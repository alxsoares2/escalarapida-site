-- API do ponto eletrônico.
-- O frontend chama SOMENTE public.ponto_rpc(fn, args), que só executa funções
-- ponto.api_* (uma função por operação). Cada operação se autentica sozinha:
--   * estação: token do computador do balcão (+ PIN do funcionário);
--   * admin:   token de sessão obtido em api_admin_login.
-- Erros esperados sobem como exceção 'E:codigo' e viram {ok:false, erro:codigo}.

-- Autenticação -----------------------------------------------------------------

create function ponto.exigir_estacao(a jsonb) returns ponto.estacao
language plpgsql stable security definer set search_path = ponto, extensions, pg_temp as $$
declare est ponto.estacao;
begin
  est := ponto.estacao_do_token(a ->> 'token');
  if est.id is null then raise exception 'E:estacao_invalida'; end if;
  return est;
end $$;

-- Confere estação + funcionário + PIN. Devolve {ok:true, estacao_id, funcionario_id}
-- ou {ok:false, erro}. Não levanta erro por PIN errado (para o contador persistir).
create function ponto.autenticar_funcionario(a jsonb) returns jsonb
language plpgsql security definer set search_path = ponto, extensions, pg_temp as $$
declare
  est ponto.estacao;
  fid integer := (a ->> 'funcionario_id')::integer;
  st  text;
  ate timestamptz;
begin
  est := ponto.exigir_estacao(a);
  if not exists (select 1 from ponto.funcionario where id = fid and empresa_id = est.empresa_id and ativo) then
    raise exception 'E:funcionario_invalido';
  end if;
  st := ponto.verificar_pin(fid, a ->> 'pin');
  if st <> 'ok' then
    select bloqueado_ate into ate from ponto.funcionario where id = fid;
    return jsonb_build_object('ok', false, 'erro', st, 'bloqueado_ate', ate);
  end if;
  return jsonb_build_object('ok', true, 'estacao_id', est.id, 'funcionario_id', fid);
end $$;

create function ponto.admin_da_sessao(p_sessao text) returns smallint
language plpgsql stable security definer set search_path = ponto, extensions, pg_temp as $$
declare v smallint;
begin
  select admin_id into v from ponto.admin_sessao
    where token_hash = ponto.sha256_hex(coalesce(p_sessao, '')) and expira_em > ponto.agora();
  if v is null then raise exception 'E:sessao_invalida'; end if;
  return v;
end $$;

-- Estação (computador do balcão) -----------------------------------------------

create function ponto.api_estacao(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
declare est ponto.estacao;
begin
  est := ponto.exigir_estacao(a);
  return jsonb_build_object(
    'ok', true,
    'empresa', (select jsonb_build_object('id', e.id, 'nome', e.nome) from ponto.empresa e where e.id = est.empresa_id),
    'estacao', jsonb_build_object('id', est.id, 'nome', est.nome),
    'agora', ponto.agora(),
    'funcionarios', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nome', f.nome) order by f.nome)
                              from ponto.funcionario f where f.empresa_id = est.empresa_id and f.ativo), '[]'));
end $$;

-- Confere o PIN e informa o que o funcionário pode marcar agora + as marcações das últimas 48 h.
create function ponto.api_estado(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare au jsonb; fid integer;
begin
  au := ponto.autenticar_funcionario(a);
  if not (au ->> 'ok')::boolean then return au; end if;
  fid := (au ->> 'funcionario_id')::integer;
  return jsonb_build_object(
    'ok', true,
    'proximos', to_jsonb(ponto.proximos_tipos(fid)),
    'ultimas', coalesce((select jsonb_agg(jsonb_build_object(
                  'nsr', m.nsr, 'tipo', m.tipo, 'marcado_em', m.marcado_em, 'hash', m.hash)
                  order by m.marcado_em desc)
                from ponto.marcacao m
                where m.funcionario_id = fid and m.marcado_em > ponto.agora() - interval '48 hours'), '[]'),
    'pedidos_pendentes', (select count(*) from ponto.ajuste
                          where funcionario_id = fid and status = 'pendente'));
end $$;

create function ponto.api_registrar(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare au jsonb; m ponto.marcacao; emp ponto.empresa; fnome text;
begin
  au := ponto.autenticar_funcionario(a);
  if not (au ->> 'ok')::boolean then return au; end if;
  m := ponto.registrar_marcacao((au ->> 'estacao_id')::smallint,
                                (au ->> 'funcionario_id')::integer,
                                (a ->> 'tipo')::ponto.tipo_marcacao);
  select * into emp from ponto.empresa where id = m.empresa_id;
  select nome into fnome from ponto.funcionario where id = m.funcionario_id;
  return jsonb_build_object('ok', true, 'comprovante', jsonb_build_object(
    'titulo', 'Comprovante de Registro de Ponto do Trabalhador',
    'nsr', m.nsr, 'empresa', emp.nome, 'cnpj', emp.cnpj, 'endereco', emp.endereco,
    'funcionario', fnome, 'tipo', m.tipo, 'marcado_em', m.marcado_em, 'hash', m.hash));
end $$;

-- O funcionário pede para incluir uma marcação esquecida; o dono decide.
create function ponto.api_solicitar_correcao(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare au jsonb; fid integer; emp smallint; quando timestamptz; v_id bigint;
begin
  au := ponto.autenticar_funcionario(a);
  if not (au ->> 'ok')::boolean then return au; end if;
  fid := (au ->> 'funcionario_id')::integer;
  select empresa_id into emp from ponto.funcionario where id = fid;
  quando := (a ->> 'marcado_em')::timestamp at time zone 'America/Recife';
  if quando > ponto.agora() or quando < ponto.agora() - interval '35 days' then
    raise exception 'E:data_invalida';
  end if;
  if coalesce(length(btrim(a ->> 'motivo')), 0) = 0 then raise exception 'E:motivo_obrigatorio'; end if;
  if (select count(*) from ponto.ajuste where funcionario_id = fid and status = 'pendente') >= 5 then
    raise exception 'E:muitos_pedidos_pendentes';
  end if;
  insert into ponto.ajuste (empresa_id, funcionario_id, tipo, tipo_marcacao, marcado_em, motivo, origem)
  values (emp, fid, 'incluir', (a ->> 'tipo_marcacao')::ponto.tipo_marcacao, quando, btrim(a ->> 'motivo'), 'funcionario')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Admin: sessão --------------------------------------------------------------------

create function ponto.api_admin_login(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare ad ponto.admin; tok text;
begin
  delete from ponto.admin_sessao where expira_em < ponto.agora();
  delete from ponto.login_tentativa where em < ponto.agora() - interval '1 day';
  if (select count(*) from ponto.login_tentativa
      where not sucesso and em > ponto.agora() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'erro', 'bloqueado');
  end if;
  select * into ad from ponto.admin where lower(email) = lower(coalesce(a ->> 'email', ''));
  if ad.id is null or crypt(coalesce(a ->> 'senha', ''), ad.senha_hash) <> ad.senha_hash then
    insert into ponto.login_tentativa (em, sucesso) values (ponto.agora(), false);
    return jsonb_build_object('ok', false, 'erro', 'credenciais_invalidas');
  end if;
  insert into ponto.login_tentativa (em, sucesso) values (ponto.agora(), true);
  tok := encode(gen_random_bytes(32), 'hex');
  insert into ponto.admin_sessao (token_hash, admin_id, expira_em)
  values (ponto.sha256_hex(tok), ad.id, ponto.agora() + interval '12 hours');
  return jsonb_build_object('ok', true, 'sessao', tok);
end $$;

create function ponto.api_admin_logout(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
begin
  delete from ponto.admin_sessao where token_hash = ponto.sha256_hex(coalesce(a ->> 'sessao', ''));
  return jsonb_build_object('ok', true);
end $$;

-- Admin: cadastros -----------------------------------------------------------------

create function ponto.api_admin_empresas(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true, 'empresas',
    coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from ponto.empresa e), '[]'));
end $$;

create function ponto.api_admin_salvar_empresa(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare v_id smallint := nullif(a ->> 'id', '')::smallint;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  if coalesce(length(btrim(a ->> 'nome')), 0) = 0 then raise exception 'E:nome_obrigatorio'; end if;
  if v_id is null then
    insert into ponto.empresa (nome, cnpj, endereco)
    values (btrim(a ->> 'nome'), nullif(btrim(a ->> 'cnpj'), ''), nullif(btrim(a ->> 'endereco'), ''))
    returning id into v_id;
  else
    update ponto.empresa set nome = btrim(a ->> 'nome'), cnpj = nullif(btrim(a ->> 'cnpj'), ''),
      endereco = nullif(btrim(a ->> 'endereco'), '') where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function ponto.api_admin_funcionarios(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
declare emp smallint := (a ->> 'empresa_id')::smallint;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true, 'funcionarios', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', f.id, 'nome', f.nome, 'cpf', f.cpf, 'ativo', f.ativo,
      'saldo_inicial_min', f.saldo_inicial_min, 'inicio_controle', f.inicio_controle,
      'bloqueado_ate', case when f.bloqueado_ate > ponto.agora() then f.bloqueado_ate end,
      'saldo_banco_min', ponto.saldo_banco(f.id),
      'jornada', (select to_jsonb(j) - 'funcionario_id' from ponto.jornada j
                  where j.funcionario_id = f.id and j.vigencia_inicio <= ponto.hoje()
                  order by j.vigencia_inicio desc limit 1)
    ) order by f.nome)
    from ponto.funcionario f where f.empresa_id = emp), '[]'));
end $$;

create function ponto.api_admin_salvar_funcionario(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare
  v_id  integer := nullif(a ->> 'id', '')::integer;
  v_pin text := nullif(a ->> 'pin', '');
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  if coalesce(length(btrim(a ->> 'nome')), 0) = 0 then raise exception 'E:nome_obrigatorio'; end if;
  if v_pin is not null and v_pin !~ '^[0-9]{4,6}$' then raise exception 'E:pin_invalido'; end if;
  if v_id is null then
    if v_pin is null then raise exception 'E:pin_obrigatorio'; end if;
    insert into ponto.funcionario (empresa_id, nome, cpf, pin_hash, saldo_inicial_min, inicio_controle)
    values ((a ->> 'empresa_id')::smallint, btrim(a ->> 'nome'), nullif(btrim(a ->> 'cpf'), ''),
            crypt(v_pin, gen_salt('bf', 8)), coalesce((a ->> 'saldo_inicial_min')::integer, 0),
            coalesce((a ->> 'inicio_controle')::date, ponto.hoje()))
    returning id into v_id;
  else
    update ponto.funcionario set
      nome = btrim(a ->> 'nome'), cpf = nullif(btrim(a ->> 'cpf'), ''),
      ativo = coalesce((a ->> 'ativo')::boolean, ativo),
      saldo_inicial_min = coalesce((a ->> 'saldo_inicial_min')::integer, saldo_inicial_min),
      inicio_controle = coalesce((a ->> 'inicio_controle')::date, inicio_controle),
      pin_hash = case when v_pin is null then pin_hash else crypt(v_pin, gen_salt('bf', 8)) end,
      pin_erros = case when v_pin is null then pin_erros else 0 end,
      bloqueado_ate = case when v_pin is null then bloqueado_ate else null end
    where id = v_id;
    if not found then raise exception 'E:funcionario_invalido'; end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function ponto.api_admin_salvar_jornada(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare dias smallint[];
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  select array_agg(x::smallint order by x::smallint) into dias
    from jsonb_array_elements_text(a -> 'dias_trabalho') x;
  if dias is null then raise exception 'E:dias_obrigatorios'; end if;
  insert into ponto.jornada (funcionario_id, vigencia_inicio, dias_trabalho, entrada, saida, intervalo_min)
  values ((a ->> 'funcionario_id')::integer, (a ->> 'vigencia_inicio')::date, dias,
          (a ->> 'entrada')::time, (a ->> 'saida')::time, coalesce((a ->> 'intervalo_min')::smallint, 15))
  on conflict (funcionario_id, vigencia_inicio) do update
    set dias_trabalho = excluded.dias_trabalho, entrada = excluded.entrada,
        saida = excluded.saida, intervalo_min = excluded.intervalo_min;
  return jsonb_build_object('ok', true);
end $$;

create function ponto.api_admin_jornadas(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true, 'jornadas', coalesce((
    select jsonb_agg(to_jsonb(j) order by j.vigencia_inicio desc)
    from ponto.jornada j where j.funcionario_id = (a ->> 'funcionario_id')::integer), '[]'));
end $$;

-- O token da estação é mostrado UMA vez; só o hash fica no banco.
create function ponto.api_admin_criar_estacao(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare tok text := encode(gen_random_bytes(24), 'hex'); v_id smallint;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  if coalesce(length(btrim(a ->> 'nome')), 0) = 0 then raise exception 'E:nome_obrigatorio'; end if;
  insert into ponto.estacao (empresa_id, nome, token_hash)
  values ((a ->> 'empresa_id')::smallint, btrim(a ->> 'nome'), ponto.sha256_hex(tok))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'token', tok);
end $$;

create function ponto.api_admin_estacoes(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true, 'estacoes', coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'ativa', e.ativa, 'criado_em', e.criado_em) order by e.id)
    from ponto.estacao e where e.empresa_id = (a ->> 'empresa_id')::smallint), '[]'));
end $$;

create function ponto.api_admin_desativar_estacao(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  update ponto.estacao set ativa = false where id = (a ->> 'id')::smallint;
  return jsonb_build_object('ok', true);
end $$;

-- Admin: exceções --------------------------------------------------------------------

create function ponto.api_admin_criar_excecao(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare
  fid integer := nullif(a ->> 'funcionario_id', '')::integer;
  emp smallint := nullif(a ->> 'empresa_id', '')::smallint;
  v_id bigint;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  if fid is not null then select empresa_id into emp from ponto.funcionario where id = fid; end if;
  if emp is null then raise exception 'E:empresa_obrigatoria'; end if;
  insert into ponto.excecao (empresa_id, funcionario_id, tipo, data_ini, data_fim, entrada, saida, minutos, motivo)
  values (emp, fid, (a ->> 'tipo')::ponto.tipo_excecao, (a ->> 'data_ini')::date,
          coalesce((a ->> 'data_fim')::date, (a ->> 'data_ini')::date),
          nullif(a ->> 'entrada', '')::time, nullif(a ->> 'saida', '')::time,
          nullif(a ->> 'minutos', '')::integer, nullif(btrim(a ->> 'motivo'), ''))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Atalho: a folga da semana muda de dia. O dia antigo passa a ser trabalhado
-- ('trabalho_folga') e o novo vira folga ('dia_liberado'), ligados por um grupo.
create function ponto.api_admin_trocar_folga(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare
  fid integer := (a ->> 'funcionario_id')::integer;
  emp smallint; g uuid := gen_random_uuid();
  novo date := (a ->> 'dia_novo')::date;      -- passa a folgar
  antigo date := (a ->> 'dia_antigo')::date;  -- folga original, agora trabalha
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  select empresa_id into emp from ponto.funcionario where id = fid;
  if emp is null then raise exception 'E:funcionario_invalido'; end if;
  insert into ponto.excecao (empresa_id, funcionario_id, tipo, data_ini, data_fim, motivo, grupo) values
    (emp, fid, 'dia_liberado',   novo,   novo,   nullif(btrim(a ->> 'motivo'), ''), g),
    (emp, fid, 'trabalho_folga', antigo, antigo, nullif(btrim(a ->> 'motivo'), ''), g);
  return jsonb_build_object('ok', true, 'grupo', g);
end $$;

-- Define os domingos de folga do mês (substitui os anteriores daquele mês).
create function ponto.api_admin_domingos(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare
  fid integer := (a ->> 'funcionario_id')::integer;
  mes date := date_trunc('month', (a ->> 'mes')::date)::date;
  emp smallint; dia text;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  select empresa_id into emp from ponto.funcionario where id = fid;
  if emp is null then raise exception 'E:funcionario_invalido'; end if;
  for dia in select x from jsonb_array_elements_text(coalesce(a -> 'domingos', '[]')) x loop
    if extract(dow from dia::date) <> 0 or date_trunc('month', dia::date)::date <> mes then
      raise exception 'E:domingo_invalido';
    end if;
  end loop;
  update ponto.excecao set cancelada_em = ponto.agora()
    where funcionario_id = fid and tipo = 'folga_domingo' and cancelada_em is null
      and data_ini >= mes and data_ini < (mes + interval '1 month')::date;
  for dia in select x from jsonb_array_elements_text(coalesce(a -> 'domingos', '[]')) x loop
    insert into ponto.excecao (empresa_id, funcionario_id, tipo, data_ini, data_fim)
    values (emp, fid, 'folga_domingo', dia::date, dia::date);
  end loop;
  return jsonb_build_object('ok', true);
end $$;

create function ponto.api_admin_cancelar_excecao(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare ex ponto.excecao;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  select * into ex from ponto.excecao where id = (a ->> 'id')::bigint;
  if ex.id is null then raise exception 'E:excecao_invalida'; end if;
  update ponto.excecao set cancelada_em = ponto.agora()
    where cancelada_em is null and (id = ex.id or (ex.grupo is not null and grupo = ex.grupo));
  return jsonb_build_object('ok', true);
end $$;

create function ponto.api_admin_excecoes(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true, 'excecoes', coalesce((
    select jsonb_agg(to_jsonb(e) || jsonb_build_object('funcionario', f.nome) order by e.data_ini, e.id)
    from ponto.excecao e left join ponto.funcionario f on f.id = e.funcionario_id
    where e.empresa_id = (a ->> 'empresa_id')::smallint and e.cancelada_em is null
      and e.data_fim >= (a ->> 'ini')::date and e.data_ini <= (a ->> 'fim')::date), '[]'));
end $$;

-- Admin: relatórios -----------------------------------------------------------------

-- Espelho de ponto do período (dia a dia) + saldo do banco.
create function ponto.api_admin_apuracao(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
declare fid integer := (a ->> 'funcionario_id')::integer;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true,
    'funcionario', (select jsonb_build_object('id', f.id, 'nome', f.nome, 'empresa', e.nome, 'cnpj', e.cnpj)
                    from ponto.funcionario f join ponto.empresa e on e.id = f.empresa_id where f.id = fid),
    'dias', coalesce((select jsonb_agg(to_jsonb(x) order by x.data)
                      from ponto.apurar(fid, (a ->> 'ini')::date, (a ->> 'fim')::date) x), '[]'),
    'saldo_periodo_min', (select coalesce(sum(x.saldo_min), 0)
                          from ponto.apurar(fid, (a ->> 'ini')::date, (a ->> 'fim')::date) x),
    'saldo_banco_min', ponto.saldo_banco(fid));
end $$;

create function ponto.api_admin_faltas(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true, 'funcionarios', coalesce((
    select jsonb_agg(jsonb_build_object('funcionario_id', t.id, 'nome', t.nome, 'total', cardinality(t.datas), 'datas', t.datas)
                     order by t.nome)
    from (
      select f.id, f.nome, array_agg(x.data order by x.data) as datas
      from ponto.funcionario f
      cross join lateral ponto.apurar(f.id, (a ->> 'ini')::date, (a ->> 'fim')::date) x
      where f.empresa_id = (a ->> 'empresa_id')::smallint and x.status = 'falta'
      group by f.id, f.nome
    ) t), '[]'));
end $$;

-- Extrato do banco de horas: só os dias com movimento.
create function ponto.api_admin_banco(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
declare
  fid integer := (a ->> 'funcionario_id')::integer;
  v_ini date := (a ->> 'ini')::date;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true,
    'saldo_anterior_min', ponto.saldo_banco(fid, v_ini - 1),
    'movimentos', coalesce((select jsonb_agg(jsonb_build_object(
        'data', x.data, 'status', x.status, 'motivo', x.motivo, 'saldo_min', x.saldo_min) order by x.data)
      from ponto.apurar(fid, v_ini, (a ->> 'fim')::date) x
      where coalesce(x.saldo_min, 0) <> 0), '[]'),
    'saldo_atual_min', ponto.saldo_banco(fid));
end $$;

-- Marcações brutas do período (para escolher qual desconsiderar).
create function ponto.api_admin_marcacoes(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true, 'marcacoes', coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'nsr', m.nsr, 'tipo', m.tipo, 'marcado_em', m.marcado_em,
      'desconsiderada', exists (select 1 from ponto.ajuste j where j.tipo = 'desconsiderar'
                                and j.status = 'aprovado' and j.marcacao_id = m.id)) order by m.marcado_em)
    from ponto.marcacao m
    where m.funcionario_id = (a ->> 'funcionario_id')::integer
      and (m.marcado_em at time zone 'America/Recife')::date between (a ->> 'ini')::date and (a ->> 'fim')::date), '[]'));
end $$;

create function ponto.api_admin_verificar_cadeia(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
declare quebra bigint;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  quebra := ponto.verificar_cadeia((a ->> 'empresa_id')::smallint);
  return jsonb_build_object('ok', true, 'integra', quebra is null, 'primeiro_nsr_invalido', quebra);
end $$;

-- Admin: correções (tratamento do ponto) --------------------------------------------

create function ponto.api_admin_correcoes(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true, 'correcoes', coalesce((
    select jsonb_agg(to_jsonb(c) || jsonb_build_object('funcionario', f.nome) order by c.criado_em desc)
    from ponto.ajuste c join ponto.funcionario f on f.id = c.funcionario_id
    where c.empresa_id = (a ->> 'empresa_id')::smallint
      and (a ->> 'status' is null or c.status = (a ->> 'status')::ponto.status_ajuste)), '[]'));
end $$;

-- Correção criada pelo dono: já entra aprovada.
create function ponto.api_admin_criar_correcao(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare fid integer := (a ->> 'funcionario_id')::integer; emp smallint; v_id bigint; tp ponto.tipo_ajuste := (a ->> 'tipo')::ponto.tipo_ajuste;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  select empresa_id into emp from ponto.funcionario where id = fid;
  if emp is null then raise exception 'E:funcionario_invalido'; end if;
  if coalesce(length(btrim(a ->> 'motivo')), 0) = 0 then raise exception 'E:motivo_obrigatorio'; end if;
  insert into ponto.ajuste (empresa_id, funcionario_id, tipo, tipo_marcacao, marcado_em, marcacao_id,
                            motivo, origem, status, decidido_em)
  values (emp, fid, tp,
          case when tp = 'incluir' then (a ->> 'tipo_marcacao')::ponto.tipo_marcacao end,
          case when tp = 'incluir' then (a ->> 'marcado_em')::timestamp at time zone 'America/Recife' end,
          case when tp = 'desconsiderar' then (a ->> 'marcacao_id')::bigint end,
          btrim(a ->> 'motivo'), 'admin', 'aprovado', ponto.agora())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function ponto.api_admin_decidir_correcao(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare aprovar boolean := (a ->> 'aprovar')::boolean;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  update ponto.ajuste set
    status = case when aprovar then 'aprovado'::ponto.status_ajuste else 'recusado'::ponto.status_ajuste end,
    decidido_em = ponto.agora(), decisao_motivo = nullif(btrim(a ->> 'motivo'), '')
  where id = (a ->> 'id')::bigint and status = 'pendente';
  if not found then raise exception 'E:correcao_invalida'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Porta de entrada única ---------------------------------------------------------------

create function public.ponto_rpc(p_fn text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = ponto, extensions, pg_temp as $$
declare v_res jsonb;
begin
  if p_fn is null or p_fn !~ '^[a-z_]+$'
     or not exists (select 1 from pg_proc p
                    where p.pronamespace = 'ponto'::regnamespace and p.proname = 'api_' || p_fn) then
    return jsonb_build_object('ok', false, 'erro', 'funcao_desconhecida');
  end if;
  begin
    execute format('select ponto.%I($1)', 'api_' || p_fn) into v_res using coalesce(p_args, '{}'::jsonb);
    return v_res;
  exception when others then
    if sqlerrm like 'E:%' then
      return jsonb_build_object('ok', false, 'erro', substr(sqlerrm, 3));
    end if;
    raise warning 'ponto_rpc(%) falhou: %', p_fn, sqlerrm;
    return jsonb_build_object('ok', false, 'erro', 'erro_interno');
  end;
end $$;

-- Permissões ---------------------------------------------------------------------------
-- Ninguém de fora acessa o schema ponto; a única porta é public.ponto_rpc.
revoke all on all functions in schema ponto from public;
alter default privileges in schema ponto revoke execute on functions from public;
revoke all on function public.ponto_rpc(text, jsonb) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema ponto from anon, authenticated';
    execute 'grant execute on function public.ponto_rpc(text, jsonb) to anon, authenticated';
  end if;
end $$;

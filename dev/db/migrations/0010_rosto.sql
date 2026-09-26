-- Versão 2, fase 2A (especificação 11.4A): reconhecimento facial em modo totem.
--   * o tablet calcula o descritor do rosto (biblioteca @vladmandic/human, modelo faceres) e as
--     notas de prova de vida (antispoof, liveness) e envia só isso; a comparação é aqui;
--   * os descritores cadastrados nunca saem do banco (nenhuma API os devolve);
--   * reconhecido = identificador de uso único (60 s) para registrar a marcação por rosto;
--   * marcação pelo PIN numa estação com reconhecimento, de quem tem rosto cadastrado = alerta sem_rosto.

alter table ponto.estacao add column reconhece_rosto boolean not null default false;

create table ponto.rosto (
  id             bigint generated always as identity primary key,
  funcionario_id integer not null references ponto.funcionario,
  posicao        text not null,
  descritor      real[] not null check (cardinality(descritor) between 64 and 2048),
  criado_em      timestamptz not null
);
create index on ponto.rosto (funcionario_id);

create table ponto.reconhecimento (
  id             bigint generated always as identity primary key,
  estacao_id     smallint not null references ponto.estacao,
  funcionario_id integer references ponto.funcionario,       -- melhor candidato (mesmo se recusado)
  similaridade   real,
  margem         real,                                        -- diferença para a 2ª pessoa
  antispoof      real,
  liveness       real,
  resultado      text not null check (resultado in ('reconhecido', 'nao_reconhecido', 'prova_de_vida', 'sem_cadastro', 'cancelado')),
  token_hash     text unique,                                 -- só quando reconhecido
  usado_em       timestamptz,
  criado_em      timestamptz not null
);
create index on ponto.reconhecimento (estacao_id, criado_em);

alter table ponto.marcacao
  add column origem_identificacao text check (origem_identificacao in ('pin', 'rosto')),
  add column reconhecimento_id    bigint references ponto.reconhecimento,
  add column sem_rosto            boolean not null default false;

-- Funcionário inativado: o cadastro facial é apagado (não é marcação; pode ser apagado).
create function ponto.apagar_rosto_inativo() returns trigger
language plpgsql security definer set search_path = ponto, extensions, pg_temp as $$
begin
  if not new.ativo and old.ativo then delete from ponto.rosto where funcionario_id = new.id; end if;
  return new;
end $$;
create trigger funcionario_apagar_rosto after update of ativo on ponto.funcionario
  for each row execute function ponto.apagar_rosto_inativo();

-- Parâmetros (sobrescrevíveis em ponto.config; valores iniciais conservadores, calibrar no tablet).
create function ponto.config_num(p_chave text, p_padrao double precision) returns double precision
language sql stable security definer set search_path = ponto, extensions, pg_temp as $$
  select coalesce((select valor::double precision from ponto.config where chave = p_chave), p_padrao)
$$;

-- Mesma conta de similaridade da biblioteca (match.ts do @vladmandic/human 3.3.6):
-- distância euclidiana × 25, raiz, normalizada para 0..1 entre min 0,2 e max 0,8.
create function ponto.similaridade(a real[], b real[]) returns double precision
language sql immutable as $$
  select coalesce((
    select case when s is null then 0
                when s = 0 then 1
                else greatest(0, least(1, (1 - sqrt(25 * s) / 100 - 0.2) / 0.6)) end
    from (select sum((x::double precision - y::double precision) ^ 2) as s
          from unnest(a, b) as t(x, y)) q
    where cardinality(a) = cardinality(b)), 0)
$$;

-- Tipo sugerido para a contagem do totem (11.4A): a sequência do dia decide; com duas opções
-- (depois da entrada), a partir de 30 min antes da saída prevista sugere "saida".
create function ponto.tipo_sugerido(p_func integer) returns ponto.tipo_marcacao
language plpgsql stable security definer set search_path = ponto, extensions, pg_temp as $$
declare
  opcoes ponto.tipo_marcacao[] := ponto.proximos_tipos(p_func);
  ent ponto.marcacao; j ponto.jornada; d date; saida_prev timestamptz;
begin
  if cardinality(opcoes) = 1 then return opcoes[1]; end if;
  if not ('saida' = any (opcoes)) or not ('saida_intervalo' = any (opcoes)) then return opcoes[1]; end if;
  select * into ent from ponto.marcacao where funcionario_id = p_func and tipo = 'entrada'
    order by marcado_em desc limit 1;
  if ent.id is null then return 'saida_intervalo'; end if;
  d := (ent.marcado_em at time zone 'America/Recife')::date;
  select * into j from ponto.jornada where funcionario_id = p_func and vigencia_inicio <= d
    order by vigencia_inicio desc limit 1;
  if j.funcionario_id is null then return 'saida_intervalo'; end if;
  saida_prev := ((d + case when j.saida <= j.entrada then 1 else 0 end)::timestamp + j.saida) at time zone 'America/Recife';
  return case when ponto.agora() >= saida_prev - interval '30 minutes' then 'saida'::ponto.tipo_marcacao
              else 'saida_intervalo'::ponto.tipo_marcacao end;
end $$;

-- Registro: acrescenta o reconhecimento (marcação por rosto) e o alerta sem_rosto (PIN).
drop function ponto.registrar_marcacao(smallint, integer, ponto.tipo_marcacao, text);
create function ponto.registrar_marcacao(
  p_estacao smallint, p_func integer, p_tipo ponto.tipo_marcacao,
  p_foto_hash text default null, p_reconhecimento bigint default null
) returns ponto.marcacao
language plpgsql security definer set search_path = ponto, extensions, pg_temp as $$
declare
  f   ponto.funcionario;
  est ponto.estacao;
  v_nsr bigint;
  ant text;
  v_agora timestamptz := ponto.agora();
  v_foto text := lower(nullif(btrim(p_foto_hash), ''));
  m   ponto.marcacao;
begin
  select * into f from ponto.funcionario where id = p_func and ativo;
  if not found then raise exception 'E:funcionario_invalido'; end if;
  select * into est from ponto.estacao where id = p_estacao and ativa;
  if not found or not ponto.estacao_atende(est.id, f.empresa_id) then raise exception 'E:estacao_invalida'; end if;
  if v_foto is not null and v_foto !~ '^[0-9a-f]{64}$' then raise exception 'E:foto_invalida'; end if;

  if not (p_tipo = any (ponto.proximos_tipos(p_func))) then
    raise exception 'E:marcacao_fora_de_sequencia';
  end if;
  if exists (select 1 from ponto.marcacao
             where funcionario_id = p_func and marcado_em > v_agora - interval '30 seconds') then
    raise exception 'E:marcacao_repetida';
  end if;

  -- trava o contador da empresa: serializa NSR e a cadeia de hash
  update ponto.nsr_contador set ultimo = ultimo + 1
    where empresa_id = f.empresa_id returning ultimo into v_nsr;
  select hash into ant from ponto.marcacao
    where empresa_id = f.empresa_id order by nsr desc limit 1;

  insert into ponto.marcacao (empresa_id, nsr, funcionario_id, estacao_id, tipo, marcado_em,
                              hash_anterior, hash, foto_hash, foto_exigida,
                              origem_identificacao, reconhecimento_id, sem_rosto)
  values (f.empresa_id, v_nsr, p_func, p_estacao, p_tipo, v_agora, ant,
          ponto.hash_marcacao_foto(f.empresa_id, v_nsr, p_func, p_tipo, v_agora, ant, v_foto),
          v_foto, est.tira_foto,
          case when p_reconhecimento is null then 'pin' else 'rosto' end, p_reconhecimento,
          p_reconhecimento is null and est.reconhece_rosto
            and exists (select 1 from ponto.rosto where funcionario_id = p_func))
  returning * into m;
  return m;
end $$;

create function ponto.comprovante(m ponto.marcacao) returns jsonb
language sql stable security definer set search_path = ponto, extensions, pg_temp as $$
  select jsonb_build_object(
    'titulo', 'Comprovante de Registro de Ponto do Trabalhador',
    'nsr', m.nsr, 'empresa', e.nome, 'cnpj', e.cnpj, 'endereco', e.endereco,
    'funcionario', f.nome, 'tipo', m.tipo, 'marcado_em', m.marcado_em, 'hash', m.hash)
  from ponto.empresa e, ponto.funcionario f where e.id = m.empresa_id and f.id = m.funcionario_id
$$;

-- Estação: reconhecimento ------------------------------------------------------------------

-- Recebe o descritor e as notas de prova de vida; compara com os rostos cadastrados dos
-- funcionários ativos das empresas que a estação atende (1 para N).
create function ponto.api_reconhecer(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare
  est ponto.estacao;
  v_agora timestamptz := ponto.agora();
  d real[]; v_as real; v_lv real;
  melhor record; segundo record;
  v_marg double precision;
  tok text; v_res text; v_id bigint;
  f ponto.funcionario; emp text;
begin
  est := ponto.exigir_estacao(a);
  if not est.reconhece_rosto then raise exception 'E:rosto_desligado'; end if;
  if (select count(*) from ponto.reconhecimento
      where estacao_id = est.id and criado_em > v_agora - interval '1 minute') >= 30 then
    raise exception 'E:muitas_tentativas';
  end if;
  if jsonb_typeof(a -> 'descritor') <> 'array' then raise exception 'E:descritor_invalido'; end if;
  begin
    select array_agg(x::real order by o) into d from jsonb_array_elements_text(a -> 'descritor') with ordinality t(x, o);
    v_as := (a ->> 'antispoof')::real;
    v_lv := (a ->> 'liveness')::real;
  exception when others then raise exception 'E:descritor_invalido';
  end;
  if d is null or cardinality(d) not between 64 and 2048 then raise exception 'E:descritor_invalido'; end if;

  -- prova de vida passiva: abaixo do mínimo nem compara
  if coalesce(v_as, 0) < ponto.config_num('rosto_antispoof_min', 0.5)
     or coalesce(v_lv, 0) < ponto.config_num('rosto_liveness_min', 0.5) then
    insert into ponto.reconhecimento (estacao_id, antispoof, liveness, resultado, criado_em)
    values (est.id, v_as, v_lv, 'prova_de_vida', v_agora);
    return jsonb_build_object('ok', true, 'reconhecido', false, 'motivo', 'prova_de_vida');
  end if;

  -- melhor amostra de cada pessoa; as duas pessoas mais parecidas
  select * into melhor from (
    select r.funcionario_id as fid, max(ponto.similaridade(r.descritor, d)) as s
    from ponto.rosto r join ponto.funcionario fu on fu.id = r.funcionario_id
    where fu.ativo and ponto.estacao_atende(est.id, fu.empresa_id)
    group by r.funcionario_id order by s desc limit 1) x;
  if melhor.fid is null then
    insert into ponto.reconhecimento (estacao_id, antispoof, liveness, resultado, criado_em)
    values (est.id, v_as, v_lv, 'sem_cadastro', v_agora);
    return jsonb_build_object('ok', true, 'reconhecido', false, 'motivo', 'sem_cadastro');
  end if;
  select * into segundo from (
    select r.funcionario_id as fid, max(ponto.similaridade(r.descritor, d)) as s
    from ponto.rosto r join ponto.funcionario fu on fu.id = r.funcionario_id
    where fu.ativo and ponto.estacao_atende(est.id, fu.empresa_id) and r.funcionario_id <> melhor.fid
    group by r.funcionario_id order by s desc limit 1) y;
  v_marg := melhor.s - coalesce(segundo.s, 0);

  if melhor.s >= ponto.config_num('rosto_limiar', 0.65) and v_marg >= ponto.config_num('rosto_margem', 0.10) then
    v_res := 'reconhecido';
    tok := encode(gen_random_bytes(16), 'hex');
  else
    v_res := 'nao_reconhecido';
  end if;
  insert into ponto.reconhecimento (estacao_id, funcionario_id, similaridade, margem, antispoof, liveness, resultado, token_hash, criado_em)
  values (est.id, melhor.fid, melhor.s, v_marg, v_as, v_lv, v_res, case when tok is null then null else ponto.sha256_hex(tok) end, v_agora)
  returning id into v_id;
  if v_res <> 'reconhecido' then
    return jsonb_build_object('ok', true, 'reconhecido', false, 'motivo', 'nao_reconhecido');
  end if;

  select * into f from ponto.funcionario where id = melhor.fid;
  select nome into emp from ponto.empresa where id = f.empresa_id;
  return jsonb_build_object('ok', true, 'reconhecido', true, 'reconhecimento', tok,
    'funcionario', jsonb_build_object('id', f.id, 'nome', f.nome, 'empresa', emp),
    'sugestao', ponto.tipo_sugerido(f.id),
    'opcoes', to_jsonb(ponto.proximos_tipos(f.id)),
    'recente', exists (select 1 from ponto.marcacao where funcionario_id = f.id and marcado_em > v_agora - interval '1 minute'));
end $$;

-- Grava a marcação de quem foi reconhecido (identificador de uso único, 60 s, mesma estação).
create function ponto.api_registrar_rosto(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare est ponto.estacao; rec ponto.reconhecimento; m ponto.marcacao;
begin
  est := ponto.exigir_estacao(a);
  select * into rec from ponto.reconhecimento
    where token_hash = ponto.sha256_hex(coalesce(a ->> 'reconhecimento', '')) for update;
  if rec.id is null or rec.estacao_id <> est.id or rec.resultado <> 'reconhecido' or rec.usado_em is not null
     or rec.criado_em < ponto.agora() - interval '60 seconds' then
    raise exception 'E:reconhecimento_invalido';
  end if;
  update ponto.reconhecimento set usado_em = ponto.agora() where id = rec.id;
  m := ponto.registrar_marcacao(est.id, rec.funcionario_id, (a ->> 'tipo')::ponto.tipo_marcacao, a ->> 'foto_hash', rec.id);
  return jsonb_build_object('ok', true, 'marcacao_id', m.id, 'comprovante', ponto.comprovante(m));
end $$;

-- "Não sou eu": invalida o reconhecimento (fica registrado como cancelado).
create function ponto.api_cancelar_reconhecimento(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare est ponto.estacao;
begin
  est := ponto.exigir_estacao(a);
  update ponto.reconhecimento set resultado = 'cancelado', usado_em = ponto.agora()
    where token_hash = ponto.sha256_hex(coalesce(a ->> 'reconhecimento', ''))
      and estacao_id = est.id and usado_em is null and resultado = 'reconhecido';
  return jsonb_build_object('ok', true);
end $$;

create or replace function ponto.api_estacao(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
declare est ponto.estacao;
begin
  est := ponto.exigir_estacao(a);
  return jsonb_build_object(
    'ok', true,
    'estacao', jsonb_build_object('id', est.id, 'nome', est.nome, 'imprime', est.imprime,
                                  'tira_foto', est.tira_foto, 'reconhece_rosto', est.reconhece_rosto),
    'agora', ponto.agora(),
    'empresas', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome,
        'funcionarios', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nome', f.nome) order by f.nome)
                                  from ponto.funcionario f where f.empresa_id = e.id and f.ativo), '[]'))
        order by e.id <> est.empresa_id, e.nome)
      from ponto.estacao_empresa ee join ponto.empresa e on e.id = ee.empresa_id
      where ee.estacao_id = est.id), '[]'),
    'empresa', (select jsonb_build_object('id', e.id, 'nome', e.nome) from ponto.empresa e where e.id = est.empresa_id),
    'funcionarios', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nome', f.nome) order by f.nome)
                              from ponto.funcionario f where f.empresa_id = est.empresa_id and f.ativo), '[]'));
end $$;

-- Admin: cadastro do rosto -------------------------------------------------------------------

-- Substitui as amostras do funcionário (3 a 8 amostras, cada uma com posição e descritor).
create function ponto.api_admin_salvar_rosto(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare fid integer := (a ->> 'funcionario_id')::integer; am jsonb; n integer;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  if not exists (select 1 from ponto.funcionario where id = fid and ativo) then raise exception 'E:funcionario_invalido'; end if;
  n := coalesce(jsonb_array_length(case when jsonb_typeof(a -> 'amostras') = 'array' then a -> 'amostras' end), 0);
  if n not between 3 and 8 then raise exception 'E:amostras_invalidas'; end if;
  delete from ponto.rosto where funcionario_id = fid;
  for am in select x from jsonb_array_elements(a -> 'amostras') x loop
    begin
      insert into ponto.rosto (funcionario_id, posicao, descritor, criado_em)
      values (fid, coalesce(nullif(btrim(am ->> 'posicao'), ''), 'frente'),
              (select array_agg(v::real order by o) from jsonb_array_elements_text(am -> 'descritor') with ordinality t(v, o)),
              ponto.agora());
    exception when others then raise exception 'E:amostras_invalidas';
    end;
  end loop;
  return jsonb_build_object('ok', true, 'amostras', n);
end $$;

create function ponto.api_admin_apagar_rosto(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  delete from ponto.rosto where funcionario_id = (a ->> 'funcionario_id')::integer;
  return jsonb_build_object('ok', true);
end $$;

-- Últimas tentativas de reconhecimento (calibração do limiar). Sem descritores.
create function ponto.api_admin_reconhecimentos(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true,
    'limiar', ponto.config_num('rosto_limiar', 0.65), 'margem', ponto.config_num('rosto_margem', 0.10),
    'tentativas', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'em', r.criado_em, 'estacao', s.nome, 'resultado', r.resultado,
        'funcionario', f.nome, 'similaridade', r.similaridade, 'margem', r.margem,
        'antispoof', r.antispoof, 'liveness', r.liveness, 'marcou', r.usado_em is not null and r.resultado = 'reconhecido')
        order by r.id desc)
      from (select * from ponto.reconhecimento order by id desc limit least(coalesce((a ->> 'limite')::integer, 100), 500)) r
      join ponto.estacao s on s.id = r.estacao_id
      left join ponto.funcionario f on f.id = r.funcionario_id), '[]'));
end $$;

-- Lista de funcionários com a situação do rosto (quantas amostras e quando).
create or replace function ponto.api_admin_funcionarios(a jsonb) returns jsonb
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
                  order by j.vigencia_inicio desc limit 1),
      'rosto_amostras', (select count(*) from ponto.rosto r where r.funcionario_id = f.id),
      'rosto_em', (select max(r.criado_em) from ponto.rosto r where r.funcionario_id = f.id)
    ) order by f.nome)
    from ponto.funcionario f where f.empresa_id = emp), '[]'));
end $$;

-- Admin: estações (acrescenta reconhece_rosto; reconhecer exige tirar foto) -------------------

create or replace function ponto.api_admin_criar_estacao(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare tok text := encode(gen_random_bytes(24), 'hex'); v_id smallint; lista smallint[];
        v_rec boolean := coalesce((a ->> 'reconhece_rosto')::boolean, false);
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  if coalesce(length(btrim(a ->> 'nome')), 0) = 0 then raise exception 'E:nome_obrigatorio'; end if;
  lista := ponto.empresas_da_lista(a);
  insert into ponto.estacao (empresa_id, nome, token_hash, imprime, reserva, tira_foto, reconhece_rosto)
  values (lista[1], btrim(a ->> 'nome'), ponto.sha256_hex(tok),
          coalesce((a ->> 'imprime')::boolean, true), coalesce((a ->> 'reserva')::boolean, false),
          coalesce((a ->> 'tira_foto')::boolean, false) or v_rec, v_rec)
  returning id into v_id;
  insert into ponto.estacao_empresa (estacao_id, empresa_id) select v_id, unnest(lista) on conflict do nothing;
  return jsonb_build_object('ok', true, 'id', v_id, 'token', tok);
end $$;

create or replace function ponto.api_admin_salvar_estacao(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare v_id smallint := (a ->> 'id')::smallint; lista smallint[];
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  if coalesce(length(btrim(a ->> 'nome')), 0) = 0 then raise exception 'E:nome_obrigatorio'; end if;
  lista := ponto.empresas_da_lista(a);
  update ponto.estacao set
    nome = btrim(a ->> 'nome'),
    empresa_id = case when empresa_id = any (lista) then empresa_id else lista[1] end,
    imprime = coalesce((a ->> 'imprime')::boolean, imprime),
    reserva = coalesce((a ->> 'reserva')::boolean, reserva),
    reconhece_rosto = coalesce((a ->> 'reconhece_rosto')::boolean, reconhece_rosto),
    tira_foto = coalesce((a ->> 'tira_foto')::boolean, tira_foto)
                or coalesce((a ->> 'reconhece_rosto')::boolean, reconhece_rosto)
  where id = v_id;
  if not found then raise exception 'E:estacao_invalida'; end if;
  delete from ponto.estacao_empresa where estacao_id = v_id and not (empresa_id = any (lista));
  insert into ponto.estacao_empresa (estacao_id, empresa_id) select v_id, unnest(lista) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

create or replace function ponto.api_admin_estacoes(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
declare v_agora timestamptz := ponto.agora();
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true, 'agora', v_agora, 'estacoes', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'nome', s.nome, 'ativa', s.ativa, 'criado_em', s.criado_em,
      'imprime', s.imprime, 'reserva', s.reserva, 'tira_foto', s.tira_foto, 'camera_ok', s.camera_ok,
      'reconhece_rosto', s.reconhece_rosto,
      'empresa_ids', (select jsonb_agg(ee.empresa_id order by ee.empresa_id <> s.empresa_id, ee.empresa_id)
                      from ponto.estacao_empresa ee where ee.estacao_id = s.id),
      'empresas', (select jsonb_agg(e.nome order by e.id <> s.empresa_id, e.nome)
                   from ponto.estacao_empresa ee join ponto.empresa e on e.id = ee.empresa_id where ee.estacao_id = s.id),
      'ultimo_contato', s.ultimo_contato,
      'online', s.ultimo_contato is not null and s.ultimo_contato > v_agora - interval '10 minutes',
      'relogio_dif_ms', s.relogio_dif_ms,
      'relogio_ok', case when s.relogio_dif_ms is null then null else abs(s.relogio_dif_ms) <= 300000 end
    ) order by s.ativa desc, s.reserva, s.id)
    from ponto.estacao s), '[]'));
end $$;

-- Relatório de marcações: acrescenta como a pessoa foi identificada e o alerta sem_rosto.
create or replace function ponto.api_admin_marcacoes_fotos(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true, 'marcacoes', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id, 'nsr', m.nsr, 'tipo', m.tipo, 'marcado_em', m.marcado_em, 'estacao', s.nome,
      'foto', case
        when f.marcacao_id is not null and f.apagada_em is null then 'foto'
        when f.apagada_em is not null then 'apagada'
        when m.foto_hash is not null then 'foto_nao_recebida'
        when m.foto_exigida then 'sem_foto'
        else 'nenhuma' end,
      'origem', m.origem_identificacao, 'sem_rosto', m.sem_rosto,
      'desconsiderada', exists (select 1 from ponto.ajuste j where j.tipo = 'desconsiderar'
                                and j.status = 'aprovado' and j.marcacao_id = m.id)) order by m.marcado_em)
    from ponto.marcacao m
    join ponto.estacao s on s.id = m.estacao_id
    left join ponto.foto f on f.marcacao_id = m.id
    where m.funcionario_id = (a ->> 'funcionario_id')::integer
      and (m.marcado_em at time zone 'America/Recife')::date between (a ->> 'ini')::date and (a ->> 'fim')::date), '[]'));
end $$;

-- Permissões ------------------------------------------------------------------------------

alter table ponto.rosto enable row level security;
alter table ponto.reconhecimento enable row level security;
revoke all on all functions in schema ponto from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on ponto.rosto, ponto.reconhecimento from anon, authenticated';
    execute 'revoke all on all functions in schema ponto from anon, authenticated';
  end if;
end $$;

-- Versão 2, fase 1 (especificação 11.2 e 11.8):
--   * uma estação atende várias empresas (o tablet serve as 2, com abas);
--   * configuração por estação: imprime o comprovante? é reserva?;
--   * sinal de vida da estação (último contato, diferença do relógio) para o quadro de saúde.
-- Compatível com a tela publicada antes desta migration: api_estacao continua devolvendo
-- "empresa" e "funcionarios" (da empresa principal) além da lista nova "empresas".

-- Empresas atendidas por estação --------------------------------------------------------

create table ponto.estacao_empresa (
  estacao_id smallint not null references ponto.estacao,
  empresa_id smallint not null references ponto.empresa,
  primary key (estacao_id, empresa_id)
);
insert into ponto.estacao_empresa (estacao_id, empresa_id) select id, empresa_id from ponto.estacao;

-- estacao.empresa_id continua existindo como "empresa principal" (a primeira da lista).
alter table ponto.estacao
  add column imprime        boolean not null default true,    -- imprime o cupom a cada marcação
  add column reserva        boolean not null default false,   -- estação de contingência (não gera aviso de queda)
  add column ultimo_contato timestamptz,                       -- último sinal de vida
  add column relogio_dif_ms integer;                           -- relógio do aparelho − relógio do servidor

-- A empresa principal é sempre atendida (vale também para inserts diretos, como nos testes).
create function ponto.estacao_vincular_principal() returns trigger
language plpgsql security definer set search_path = ponto, extensions, pg_temp as $$
begin
  insert into ponto.estacao_empresa (estacao_id, empresa_id) values (new.id, new.empresa_id)
  on conflict do nothing;
  return new;
end $$;
create trigger estacao_vincular_principal after insert or update of empresa_id on ponto.estacao
  for each row execute function ponto.estacao_vincular_principal();

create function ponto.estacao_atende(p_estacao smallint, p_empresa smallint) returns boolean
language sql stable security definer set search_path = ponto, extensions, pg_temp as $$
  select exists (select 1 from ponto.estacao_empresa where estacao_id = p_estacao and empresa_id = p_empresa)
$$;

-- Autenticação: o funcionário precisa ser de uma empresa que a estação atende ---------------

create or replace function ponto.autenticar_funcionario(a jsonb) returns jsonb
language plpgsql security definer set search_path = ponto, extensions, pg_temp as $$
declare
  est ponto.estacao;
  fid integer := (a ->> 'funcionario_id')::integer;
  st  text;
  ate timestamptz;
begin
  est := ponto.exigir_estacao(a);
  if not exists (select 1 from ponto.funcionario f
                 where f.id = fid and f.ativo and ponto.estacao_atende(est.id, f.empresa_id)) then
    raise exception 'E:funcionario_invalido';
  end if;
  st := ponto.verificar_pin(fid, a ->> 'pin');
  if st <> 'ok' then
    select bloqueado_ate into ate from ponto.funcionario where id = fid;
    return jsonb_build_object('ok', false, 'erro', st, 'bloqueado_ate', ate);
  end if;
  return jsonb_build_object('ok', true, 'estacao_id', est.id, 'funcionario_id', fid);
end $$;

-- Igual à 0002, trocando "estação da mesma empresa" por "estação que atende a empresa".
create or replace function ponto.registrar_marcacao(
  p_estacao smallint, p_func integer, p_tipo ponto.tipo_marcacao
) returns ponto.marcacao
language plpgsql security definer set search_path = ponto, extensions, pg_temp as $$
declare
  f   ponto.funcionario;
  est ponto.estacao;
  v_nsr bigint;
  ant text;
  v_agora timestamptz := ponto.agora();
  m   ponto.marcacao;
begin
  select * into f from ponto.funcionario where id = p_func and ativo;
  if not found then raise exception 'E:funcionario_invalido'; end if;
  select * into est from ponto.estacao where id = p_estacao and ativa;
  if not found or not ponto.estacao_atende(est.id, f.empresa_id) then raise exception 'E:estacao_invalida'; end if;

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

  insert into ponto.marcacao (empresa_id, nsr, funcionario_id, estacao_id, tipo, marcado_em, hash_anterior, hash)
  values (f.empresa_id, v_nsr, p_func, p_estacao, p_tipo, v_agora, ant,
          ponto.hash_marcacao(f.empresa_id, v_nsr, p_func, p_tipo, v_agora, ant))
  returning * into m;
  return m;
end $$;

-- Estação: dados da tela ---------------------------------------------------------------

create or replace function ponto.api_estacao(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
declare est ponto.estacao;
begin
  est := ponto.exigir_estacao(a);
  return jsonb_build_object(
    'ok', true,
    'estacao', jsonb_build_object('id', est.id, 'nome', est.nome, 'imprime', est.imprime),
    'agora', ponto.agora(),
    -- uma aba por empresa (ordem: principal primeiro, depois por nome)
    'empresas', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome,
        'funcionarios', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nome', f.nome) order by f.nome)
                                  from ponto.funcionario f where f.empresa_id = e.id and f.ativo), '[]'))
        order by e.id <> est.empresa_id, e.nome)
      from ponto.estacao_empresa ee join ponto.empresa e on e.id = ee.empresa_id
      where ee.estacao_id = est.id), '[]'),
    -- campos da versão 1 (tela publicada antes desta migration)
    'empresa', (select jsonb_build_object('id', e.id, 'nome', e.nome) from ponto.empresa e where e.id = est.empresa_id),
    'funcionarios', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nome', f.nome) order by f.nome)
                              from ponto.funcionario f where f.empresa_id = est.empresa_id and f.ativo), '[]'));
end $$;

-- Sinal de vida (a cada 5 min e ao abrir a tela). Grava o último contato e a diferença
-- entre o relógio do aparelho e o do servidor.
create function ponto.api_estacao_sinal(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare est ponto.estacao; v_agora timestamptz := ponto.agora(); cli timestamptz;
begin
  est := ponto.exigir_estacao(a);
  begin
    cli := (a ->> 'relogio')::timestamptz;
  exception when others then cli := null;
  end;
  update ponto.estacao set
    ultimo_contato = v_agora,
    relogio_dif_ms = case when cli is null then null
                          else greatest(-2000000000, least(2000000000,
                                 round(extract(epoch from (cli - v_agora)) * 1000)))::integer end
  where id = est.id;
  return jsonb_build_object('ok', true, 'agora', v_agora);
end $$;

-- Admin: estações ------------------------------------------------------------------------

-- Lê e valida a lista de empresas; devolve em ordem (a primeira vira a principal).
create function ponto.empresas_da_lista(a jsonb) returns smallint[]
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
declare lista smallint[];
begin
  if jsonb_typeof(a -> 'empresa_ids') = 'array' then
    select array_agg(v order by o) into lista
      from (select x::smallint v, min(o) o from jsonb_array_elements_text(a -> 'empresa_ids') with ordinality t(x, o)
            group by 1) s;
  elsif nullif(a ->> 'empresa_id', '') is not null then
    lista := array[(a ->> 'empresa_id')::smallint];      -- painel da versão 1
  end if;
  if lista is null or cardinality(lista) = 0 then raise exception 'E:empresa_obrigatoria'; end if;
  if (select count(*) from ponto.empresa where id = any (lista)) <> cardinality(lista) then
    raise exception 'E:empresa_obrigatoria';
  end if;
  return lista;
end $$;

-- O token da estação é mostrado UMA vez; só o hash fica no banco.
create or replace function ponto.api_admin_criar_estacao(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare tok text := encode(gen_random_bytes(24), 'hex'); v_id smallint; lista smallint[];
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  if coalesce(length(btrim(a ->> 'nome')), 0) = 0 then raise exception 'E:nome_obrigatorio'; end if;
  lista := ponto.empresas_da_lista(a);
  insert into ponto.estacao (empresa_id, nome, token_hash, imprime, reserva)
  values (lista[1], btrim(a ->> 'nome'), ponto.sha256_hex(tok),
          coalesce((a ->> 'imprime')::boolean, true), coalesce((a ->> 'reserva')::boolean, false))
  returning id into v_id;
  insert into ponto.estacao_empresa (estacao_id, empresa_id) select v_id, unnest(lista) on conflict do nothing;
  return jsonb_build_object('ok', true, 'id', v_id, 'token', tok);
end $$;

create function ponto.api_admin_salvar_estacao(a jsonb) returns jsonb
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
    reserva = coalesce((a ->> 'reserva')::boolean, reserva)
  where id = v_id;
  if not found then raise exception 'E:estacao_invalida'; end if;
  delete from ponto.estacao_empresa where estacao_id = v_id and not (empresa_id = any (lista));
  insert into ponto.estacao_empresa (estacao_id, empresa_id) select v_id, unnest(lista) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- Todas as estações (não só as da empresa aberta no painel), com o quadro de saúde.
-- online = sinal nos últimos 10 min; relógio OK = diferença de até 5 min.
create or replace function ponto.api_admin_estacoes(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
declare v_agora timestamptz := ponto.agora();
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  return jsonb_build_object('ok', true, 'agora', v_agora, 'estacoes', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'nome', s.nome, 'ativa', s.ativa, 'criado_em', s.criado_em,
      'imprime', s.imprime, 'reserva', s.reserva,
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

-- Permissões (mesmo padrão da 0005) -------------------------------------------------------

alter table ponto.estacao_empresa enable row level security;
revoke all on all functions in schema ponto from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on ponto.estacao_empresa from anon, authenticated';
    execute 'revoke all on all functions in schema ponto from anon, authenticated';
  end if;
end $$;

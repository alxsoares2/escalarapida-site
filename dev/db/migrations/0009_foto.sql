-- Versão 2, fase 2 (especificação 11.4): foto como prova.
--   * a estação que tira foto calcula o SHA-256 da foto ANTES de registrar e o envia junto;
--     o foto_hash entra no hash encadeado da marcação (trocar a foto depois é detectável);
--   * o arquivo sobe depois, pela Edge Function ponto-foto, que confere o hash e grava no
--     compartimento privado "ponto-fotos" do Storage (só service_role acessa);
--   * sem câmera, a marcação acontece mesmo assim (foto_exigida e sem foto_hash = alerta sem_foto).

alter table ponto.estacao
  add column tira_foto  boolean not null default false,
  add column camera_ok  boolean;                        -- informado no sinal de vida

-- Colunas novas não mexem em nenhuma marcação existente (o bloqueio é de UPDATE/DELETE).
alter table ponto.marcacao
  add column foto_hash    text check (foto_hash ~ '^[0-9a-f]{64}$'),
  add column foto_exigida boolean not null default false;

-- Arquivo recebido para a marcação (um por marcação).
create table ponto.foto (
  marcacao_id bigint primary key references ponto.marcacao,
  caminho     text not null unique,        -- empresa/AAAA-MM/nsr.ext dentro de ponto-fotos
  bytes       integer not null,
  tipo        text not null,
  recebida_em timestamptz not null,
  apagada_em  timestamptz                  -- expurgo por prazo (fase 4)
);

-- Hash da marcação com foto. Sem foto, é exatamente o hash da versão 1
-- (as marcações antigas continuam conferindo).
create function ponto.hash_marcacao_foto(
  p_empresa smallint, p_nsr bigint, p_func integer,
  p_tipo ponto.tipo_marcacao, p_em timestamptz, p_anterior text, p_foto text
) returns text language sql immutable as $$
  select case when p_foto is null
    then ponto.hash_marcacao(p_empresa, p_nsr, p_func, p_tipo, p_em, p_anterior)
    else ponto.sha256_hex(concat_ws('|',
      p_empresa, p_nsr, p_func, p_tipo::text,
      to_char(p_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      coalesce(p_anterior, ''), p_foto))
  end
$$;

create or replace function ponto.verificar_cadeia(p_empresa smallint) returns bigint
language plpgsql stable security definer set search_path = ponto, extensions, pg_temp as $$
declare
  m ponto.marcacao;
  ant text := null;
  esperado_nsr bigint := 1;
begin
  for m in select * from ponto.marcacao where empresa_id = p_empresa order by nsr loop
    if m.nsr <> esperado_nsr
       or m.hash_anterior is distinct from ant
       or m.hash <> ponto.hash_marcacao_foto(m.empresa_id, m.nsr, m.funcionario_id, m.tipo, m.marcado_em, ant, m.foto_hash) then
      return m.nsr;
    end if;
    ant := m.hash;
    esperado_nsr := esperado_nsr + 1;
  end loop;
  return null;
end $$;

-- Registro com foto opcional. Substitui a versão de 3 argumentos (uma só assinatura,
-- para não haver ambiguidade na chamada).
drop function ponto.registrar_marcacao(smallint, integer, ponto.tipo_marcacao);
create function ponto.registrar_marcacao(
  p_estacao smallint, p_func integer, p_tipo ponto.tipo_marcacao, p_foto_hash text default null
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
                              hash_anterior, hash, foto_hash, foto_exigida)
  values (f.empresa_id, v_nsr, p_func, p_estacao, p_tipo, v_agora, ant,
          ponto.hash_marcacao_foto(f.empresa_id, v_nsr, p_func, p_tipo, v_agora, ant, v_foto),
          v_foto, est.tira_foto)
  returning * into m;
  return m;
end $$;

create or replace function ponto.api_registrar(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare au jsonb; m ponto.marcacao; emp ponto.empresa; fnome text;
begin
  au := ponto.autenticar_funcionario(a);
  if not (au ->> 'ok')::boolean then return au; end if;
  m := ponto.registrar_marcacao((au ->> 'estacao_id')::smallint,
                                (au ->> 'funcionario_id')::integer,
                                (a ->> 'tipo')::ponto.tipo_marcacao,
                                a ->> 'foto_hash');
  select * into emp from ponto.empresa where id = m.empresa_id;
  select nome into fnome from ponto.funcionario where id = m.funcionario_id;
  return jsonb_build_object('ok', true, 'marcacao_id', m.id, 'comprovante', jsonb_build_object(
    'titulo', 'Comprovante de Registro de Ponto do Trabalhador',
    'nsr', m.nsr, 'empresa', emp.nome, 'cnpj', emp.cnpj, 'endereco', emp.endereco,
    'funcionario', fnome, 'tipo', m.tipo, 'marcado_em', m.marcado_em, 'hash', m.hash));
end $$;

-- Funções usadas SÓ pela Edge Function (conexão direta ao banco). Não começam com api_,
-- então public.ponto_rpc não as executa.

-- Confere se a estação pode enviar a foto desta marcação. Devolve o caminho no Storage.
create function ponto.foto_autorizar(p_token text, p_marcacao bigint, p_hash text, p_ext text) returns jsonb
language plpgsql stable security definer set search_path = ponto, extensions, pg_temp as $$
declare est ponto.estacao; m ponto.marcacao;
begin
  est := ponto.estacao_do_token(p_token);
  if est.id is null then return jsonb_build_object('ok', false, 'erro', 'estacao_invalida'); end if;
  select * into m from ponto.marcacao where id = p_marcacao;
  if m.id is null or m.estacao_id <> est.id then return jsonb_build_object('ok', false, 'erro', 'marcacao_invalida'); end if;
  if m.foto_hash is null or m.foto_hash <> lower(coalesce(p_hash, '')) then
    return jsonb_build_object('ok', false, 'erro', 'foto_nao_confere');
  end if;
  if m.marcado_em < ponto.agora() - interval '7 days' then return jsonb_build_object('ok', false, 'erro', 'prazo_esgotado'); end if;
  if exists (select 1 from ponto.foto where marcacao_id = m.id) then return jsonb_build_object('ok', false, 'erro', 'foto_ja_enviada'); end if;
  if p_ext not in ('webp', 'jpg', 'png') then return jsonb_build_object('ok', false, 'erro', 'foto_invalida'); end if;
  return jsonb_build_object('ok', true, 'caminho',
    m.empresa_id || '/' || to_char(m.marcado_em at time zone 'America/Recife', 'YYYY-MM') || '/' || m.nsr || '.' || p_ext);
end $$;

create function ponto.foto_registrar(p_marcacao bigint, p_caminho text, p_bytes integer, p_tipo text) returns void
language sql security definer set search_path = ponto, extensions, pg_temp as $$
  insert into ponto.foto (marcacao_id, caminho, bytes, tipo, recebida_em)
  values (p_marcacao, p_caminho, p_bytes, p_tipo, ponto.agora())
$$;

-- Caminhos das fotos que o gestor pode ver (a sessão é conferida aqui).
create function ponto.foto_caminhos_admin(p_sessao text, p_ids bigint[]) returns table (marcacao_id bigint, caminho text)
language plpgsql stable security definer set search_path = ponto, extensions, pg_temp as $$
begin
  perform ponto.admin_da_sessao(p_sessao);
  return query select f.marcacao_id, f.caminho from ponto.foto f
    where f.marcacao_id = any (p_ids) and f.apagada_em is null;
end $$;

-- Estação ---------------------------------------------------------------------------------

create or replace function ponto.api_estacao(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
declare est ponto.estacao;
begin
  est := ponto.exigir_estacao(a);
  return jsonb_build_object(
    'ok', true,
    'estacao', jsonb_build_object('id', est.id, 'nome', est.nome, 'imprime', est.imprime, 'tira_foto', est.tira_foto),
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

create or replace function ponto.api_estacao_sinal(a jsonb) returns jsonb
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
                                 round(extract(epoch from (cli - v_agora)) * 1000)))::integer end,
    camera_ok = case when jsonb_typeof(a -> 'camera') = 'boolean' then (a ->> 'camera')::boolean else camera_ok end
  where id = est.id;
  return jsonb_build_object('ok', true, 'agora', v_agora);
end $$;

-- Admin: estações (acrescenta tira_foto e câmera) -------------------------------------------

create or replace function ponto.api_admin_criar_estacao(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare tok text := encode(gen_random_bytes(24), 'hex'); v_id smallint; lista smallint[];
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  if coalesce(length(btrim(a ->> 'nome')), 0) = 0 then raise exception 'E:nome_obrigatorio'; end if;
  lista := ponto.empresas_da_lista(a);
  insert into ponto.estacao (empresa_id, nome, token_hash, imprime, reserva, tira_foto)
  values (lista[1], btrim(a ->> 'nome'), ponto.sha256_hex(tok),
          coalesce((a ->> 'imprime')::boolean, true), coalesce((a ->> 'reserva')::boolean, false),
          coalesce((a ->> 'tira_foto')::boolean, false))
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
    tira_foto = coalesce((a ->> 'tira_foto')::boolean, tira_foto)
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

-- Admin: marcações com foto e espaço usado ---------------------------------------------------

-- Marcações do funcionário no período, com a situação da foto:
--   foto = arquivo recebido | sem_foto = estação tira foto e a câmera falhou |
--   foto_nao_recebida = hash registrado, arquivo não chegou | nenhuma = estação sem câmera.
create function ponto.api_admin_marcacoes_fotos(a jsonb) returns jsonb
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
      'desconsiderada', exists (select 1 from ponto.ajuste j where j.tipo = 'desconsiderar'
                                and j.status = 'aprovado' and j.marcacao_id = m.id)) order by m.marcado_em)
    from ponto.marcacao m
    join ponto.estacao s on s.id = m.estacao_id
    left join ponto.foto f on f.marcacao_id = m.id
    where m.funcionario_id = (a ->> 'funcionario_id')::integer
      and (m.marcado_em at time zone 'America/Recife')::date between (a ->> 'ini')::date and (a ->> 'fim')::date), '[]'));
end $$;

-- Espaço: fotos do ponto e o Storage inteiro do projeto (limite do plano gratuito: 1 GB).
create function ponto.api_admin_espaco(a jsonb) returns jsonb
language plpgsql stable security definer set search_path = ponto, extensions, pg_temp as $$
declare total bigint;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  if to_regclass('storage.objects') is not null then
    execute $q$select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects$q$ into total;
  end if;
  return jsonb_build_object('ok', true,
    'fotos_bytes', (select coalesce(sum(bytes), 0) from ponto.foto where apagada_em is null),
    'fotos_qtd', (select count(*) from ponto.foto where apagada_em is null),
    'storage_bytes', total,
    'limite_bytes', 1073741824);
end $$;

-- Compartimento privado (só existe no Supabase; nos testes não há schema storage) -------------

do $$
begin
  if to_regclass('storage.buckets') is not null then
    execute $q$insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('ponto-fotos', 'ponto-fotos', false, 102400, array['image/webp', 'image/jpeg', 'image/png'])
      on conflict (id) do nothing$q$;
  end if;
end $$;

-- Permissões ------------------------------------------------------------------------------

alter table ponto.foto enable row level security;
revoke all on all functions in schema ponto from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on ponto.foto from anon, authenticated';
    execute 'revoke all on all functions in schema ponto from anon, authenticated';
  end if;
end $$;

-- Ponto eletrônico: schema, tabelas e proteções de imutabilidade.
-- Ver docs/ponto/ESPECIFICACAO.md

create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;
create schema if not exists ponto;

-- Empresas e funcionários ---------------------------------------------------

create table ponto.empresa (
  id        smallint generated always as identity primary key,
  nome      text not null,
  cnpj      text,
  endereco  text,
  criado_em timestamptz not null default now()
);

create table ponto.funcionario (
  id                integer generated always as identity primary key,
  empresa_id        smallint not null references ponto.empresa,
  nome              text not null,
  cpf               text,
  pin_hash          text not null,
  pin_erros         smallint not null default 0,
  bloqueado_ate     timestamptz,
  ativo             boolean not null default true,
  -- banco de horas antes de usar o sistema (minutos, pode ser negativo)
  saldo_inicial_min integer not null default 0,
  -- dias anteriores a esta data nunca são apurados (não viram falta)
  inicio_controle   date not null default ((now() at time zone 'America/Recife')::date),
  criado_em         timestamptz not null default now()
);
create index on ponto.funcionario (empresa_id);

-- Jornada prevista, com vigência por data. dias_trabalho: 0=dom ... 6=sáb.
-- saida <= entrada significa que a jornada atravessa a meia-noite.
create table ponto.jornada (
  id              integer generated always as identity primary key,
  funcionario_id  integer not null references ponto.funcionario,
  vigencia_inicio date not null,
  dias_trabalho   smallint[] not null,
  entrada         time not null,
  saida           time not null,
  intervalo_min   smallint not null default 15 check (intervalo_min >= 0),
  criado_em       timestamptz not null default now(),
  unique (funcionario_id, vigencia_inicio),
  check (dias_trabalho <@ array[0,1,2,3,4,5,6]::smallint[])
);

-- Computador do estabelecimento autorizado a marcar ponto.
create table ponto.estacao (
  id         smallint generated always as identity primary key,
  empresa_id smallint not null references ponto.empresa,
  nome       text not null,
  token_hash text not null unique,
  ativa      boolean not null default true,
  criado_em  timestamptz not null default now()
);

-- Marcações (registro imutável) ---------------------------------------------

create type ponto.tipo_marcacao as enum ('entrada', 'saida_intervalo', 'volta_intervalo', 'saida');

create table ponto.nsr_contador (
  empresa_id smallint primary key references ponto.empresa,
  ultimo     bigint not null default 0
);

create table ponto.marcacao (
  id             bigint generated always as identity primary key,
  empresa_id     smallint not null references ponto.empresa,
  nsr            bigint not null,
  funcionario_id integer not null references ponto.funcionario,
  estacao_id     smallint not null references ponto.estacao,
  tipo           ponto.tipo_marcacao not null,
  marcado_em     timestamptz not null,
  hash_anterior  text,
  hash           text not null,
  unique (empresa_id, nsr)
);
create index on ponto.marcacao (funcionario_id, marcado_em);

create function ponto.bloquear_alteracao() returns trigger
language plpgsql as $$
begin
  raise exception 'Registro imutável: % em % não é permitido', tg_op, tg_table_name
    using errcode = '42501';
end $$;

create trigger marcacao_imutavel_ud before update or delete on ponto.marcacao
  for each row execute function ponto.bloquear_alteracao();
create trigger marcacao_imutavel_t before truncate on ponto.marcacao
  for each statement execute function ponto.bloquear_alteracao();

-- Cria o contador de NSR junto com a empresa.
create function ponto.criar_contador_nsr() returns trigger
language plpgsql as $$
begin
  insert into ponto.nsr_contador (empresa_id) values (new.id);
  return new;
end $$;
create trigger empresa_nsr after insert on ponto.empresa
  for each row execute function ponto.criar_contador_nsr();

-- Tratamento do ponto: correções que ACRESCENTAM ou DESCONSIDERAM -----------

create type ponto.tipo_ajuste   as enum ('incluir', 'desconsiderar');
create type ponto.status_ajuste as enum ('pendente', 'aprovado', 'recusado');

create table ponto.ajuste (
  id             bigint generated always as identity primary key,
  empresa_id     smallint not null references ponto.empresa,
  funcionario_id integer not null references ponto.funcionario,
  tipo           ponto.tipo_ajuste not null,
  tipo_marcacao  ponto.tipo_marcacao,
  marcado_em     timestamptz,
  marcacao_id    bigint references ponto.marcacao,
  motivo         text not null check (length(btrim(motivo)) > 0),
  origem         text not null check (origem in ('admin', 'funcionario')),
  status         ponto.status_ajuste not null default 'pendente',
  criado_em      timestamptz not null default now(),
  decidido_em    timestamptz,
  decisao_motivo text,
  check (
    (tipo = 'incluir' and tipo_marcacao is not null and marcado_em is not null and marcacao_id is null) or
    (tipo = 'desconsiderar' and marcacao_id is not null)
  )
);
create index on ponto.ajuste (funcionario_id, status);

create function ponto.proteger_ajuste() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Correções não podem ser apagadas' using errcode = '42501';
  end if;
  -- só a decisão pode mudar, e uma única vez (pendente -> aprovado/recusado)
  if old.status <> 'pendente'
     or new.status = 'pendente'
     or (to_jsonb(new) - 'status' - 'decidido_em' - 'decisao_motivo')
        is distinct from (to_jsonb(old) - 'status' - 'decidido_em' - 'decisao_motivo') then
    raise exception 'Correção só pode ser decidida uma vez' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger ajuste_protegido before update or delete on ponto.ajuste
  for each row execute function ponto.proteger_ajuste();

-- Exceções à jornada --------------------------------------------------------

create type ponto.tipo_excecao as enum (
  'folga_domingo', 'dia_liberado', 'trabalho_folga', 'troca_horario',
  'compensacao', 'atestado', 'ferias', 'licenca', 'feriado'
);

create table ponto.excecao (
  id             bigint generated always as identity primary key,
  empresa_id     smallint not null references ponto.empresa,
  funcionario_id integer references ponto.funcionario,   -- null = toda a empresa (feriado)
  tipo           ponto.tipo_excecao not null,
  data_ini       date not null,
  data_fim       date not null,
  entrada        time,                                    -- troca_horario
  saida          time,                                    -- troca_horario
  minutos        integer check (minutos is null or minutos > 0),  -- compensacao (null = dia inteiro)
  motivo         text,
  grupo          uuid,                                    -- liga as duas pontas de uma troca de folga
  criado_em      timestamptz not null default now(),
  cancelada_em   timestamptz,
  check (data_fim >= data_ini),
  check (tipo <> 'troca_horario' or (entrada is not null and saida is not null)),
  check (funcionario_id is not null or tipo = 'feriado')
);
create index on ponto.excecao (funcionario_id, data_ini, data_fim);
create index on ponto.excecao (empresa_id, tipo, data_ini);

create function ponto.proteger_excecao() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Exceções não são apagadas, apenas canceladas' using errcode = '42501';
  end if;
  if old.cancelada_em is not null
     or (to_jsonb(new) - 'cancelada_em') is distinct from (to_jsonb(old) - 'cancelada_em') then
    raise exception 'Exceção só pode ser cancelada' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger excecao_protegida before update or delete on ponto.excecao
  for each row execute function ponto.proteger_excecao();

-- Administrador (uma conta) -------------------------------------------------

create table ponto.admin (
  id         smallint generated always as identity primary key,
  email      text not null unique,
  senha_hash text not null,
  criado_em  timestamptz not null default now()
);

create table ponto.admin_sessao (
  token_hash text primary key,
  admin_id   smallint not null references ponto.admin,
  expira_em  timestamptz not null,
  criado_em  timestamptz not null default now()
);

create table ponto.login_tentativa (
  id     bigint generated always as identity primary key,
  em     timestamptz not null,
  sucesso boolean not null
);

-- Nada disso é acessível diretamente pela API.
revoke all on schema ponto from public;
revoke all on all tables in schema ponto from public;

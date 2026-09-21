-- Primeiro acesso do admin sem que a senha passe por terceiros:
-- um código de instalação de uso único (guardado só como hash) autoriza a criação da conta
-- pela própria página. Depois que existe um admin, o código deixa de valer.

create table ponto.config (
  chave text primary key,
  valor text not null
);
alter table ponto.config enable row level security;
revoke all on ponto.config from public;

create function ponto.api_admin_primeiro_acesso(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare
  cod text := coalesce(a ->> 'codigo', '');
  mail text := lower(btrim(coalesce(a ->> 'email', '')));
  sen text := coalesce(a ->> 'senha', '');
  guard text;
begin
  if exists (select 1 from ponto.admin) then raise exception 'E:ja_configurado'; end if;
  -- limita tentativas de adivinhar o código (mesma tabela do login)
  if (select count(*) from ponto.login_tentativa
      where not sucesso and em > ponto.agora() - interval '15 minutes') >= 5 then
    raise exception 'E:bloqueado';
  end if;
  select valor into guard from ponto.config where chave = 'codigo_instalacao_hash';
  if guard is null or ponto.sha256_hex(cod) <> guard then
    insert into ponto.login_tentativa (em, sucesso) values (ponto.agora(), false);
    return jsonb_build_object('ok', false, 'erro', 'codigo_invalido');
  end if;
  if mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E:email_invalido'; end if;
  if length(sen) < 10 then raise exception 'E:senha_curta'; end if;

  insert into ponto.admin (email, senha_hash) values (mail, crypt(sen, gen_salt('bf', 10)));
  delete from ponto.config where chave = 'codigo_instalacao_hash';
  return jsonb_build_object('ok', true);
end $$;

create function ponto.api_admin_trocar_senha(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare aid smallint; ad ponto.admin; nova text := coalesce(a ->> 'nova', '');
begin
  aid := ponto.admin_da_sessao(a ->> 'sessao');
  select * into ad from ponto.admin where id = aid;
  if crypt(coalesce(a ->> 'atual', ''), ad.senha_hash) <> ad.senha_hash then
    raise exception 'E:senha_atual_incorreta';
  end if;
  if length(nova) < 10 then raise exception 'E:senha_curta'; end if;
  update ponto.admin set senha_hash = crypt(nova, gen_salt('bf', 10)) where id = aid;
  delete from ponto.admin_sessao where admin_id = aid and token_hash <> ponto.sha256_hex(a ->> 'sessao');
  return jsonb_build_object('ok', true);
end $$;

-- Diz à página se ainda precisa do primeiro acesso (sem revelar mais nada).
create function ponto.api_admin_status(a jsonb) returns jsonb
language sql stable set search_path = ponto, extensions, pg_temp as $$
  select jsonb_build_object('ok', true, 'precisa_primeiro_acesso', not exists (select 1 from ponto.admin))
$$;

revoke all on all functions in schema ponto from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema ponto from anon, authenticated';
    execute 'revoke all on ponto.config from anon, authenticated';
  end if;
end $$;

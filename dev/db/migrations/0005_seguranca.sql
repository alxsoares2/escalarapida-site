-- Defesa em profundidade: mesmo que o Supabase conceda privilégios por padrão
-- em schemas novos, nada de ponto.* é acessível direto pela API.
-- A única porta é public.ponto_rpc (SECURITY DEFINER, roda como dono).

do $$
declare t record;
begin
  -- RLS ligado e sem nenhuma policy: negado para quem não é dono/superusuário.
  for t in select c.relname from pg_class c
           where c.relnamespace = 'ponto'::regnamespace and c.relkind = 'r' loop
    execute format('alter table ponto.%I enable row level security', t.relname);
  end loop;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema ponto from anon, authenticated';
    execute 'revoke all on all tables in schema ponto from anon, authenticated';
    execute 'revoke all on all sequences in schema ponto from anon, authenticated';
    execute 'revoke all on all functions in schema ponto from anon, authenticated';
    execute 'alter default privileges in schema ponto revoke all on tables from anon, authenticated';
    execute 'alter default privileges in schema ponto revoke all on functions from anon, authenticated';
    execute 'alter default privileges in schema ponto revoke all on sequences from anon, authenticated';
    execute 'grant execute on function public.ponto_rpc(text, jsonb) to anon, authenticated';
  end if;
end $$;

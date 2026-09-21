-- Espelho de ponto: adicional noturno (22h às 5h) e banco de horas acumulado dia a dia.
-- A apuração em si (ponto.apurar) não muda; estes campos são derivados dela.

-- Minutos do intervalo [a, b) que caem na janela noturna (22:00 a 05:00, horário de Recife).
-- Minutos reais, sem a conversão da "hora noturna reduzida" (52min30s): isso é decisão da folha.
create function ponto.minutos_noturnos(a timestamptz, b timestamptz) returns integer
language sql immutable as $$
  select coalesce(sum(greatest(0, extract(epoch from (least(b, w.fim) - greatest(a, w.ini))) / 60)), 0)::integer
  from (
    select ((g::date)::timestamp + time '22:00') at time zone 'America/Recife' as ini,
           (((g::date) + 1)::timestamp + time '05:00') at time zone 'America/Recife' as fim
    from generate_series((a at time zone 'America/Recife')::date - 1,
                         (b at time zone 'America/Recife')::date, interval '1 day') g
  ) w
  where a is not null and b is not null and b > a
$$;

-- Espelho do período: dias + adicional noturno + banco acumulado + jornada vigente.
create or replace function ponto.api_admin_apuracao(a jsonb) returns jsonb
language plpgsql stable set search_path = ponto, extensions, pg_temp as $$
declare
  fid integer := (a ->> 'funcionario_id')::integer;
  v_ini date := (a ->> 'ini')::date;
  v_fim date := (a ->> 'fim')::date;
  v_ant integer;
begin
  perform ponto.admin_da_sessao(a ->> 'sessao');
  v_ant := ponto.saldo_banco(fid, v_ini - 1);
  return jsonb_build_object('ok', true,
    'funcionario', (select jsonb_build_object('id', f.id, 'nome', f.nome, 'empresa', e.nome, 'cnpj', e.cnpj)
                    from ponto.funcionario f join ponto.empresa e on e.id = f.empresa_id where f.id = fid),
    'jornada', (select to_jsonb(j) - 'funcionario_id' from ponto.jornada j
                where j.funcionario_id = fid and j.vigencia_inicio <= v_fim
                order by j.vigencia_inicio desc limit 1),
    'saldo_anterior_min', v_ant,
    'dias', coalesce((
      select jsonb_agg(to_jsonb(y.dia) || jsonb_build_object('an_min', y.an, 'banco_min', y.banco) order by y.data)
      from (
        select x as dia, x.data,
               case
                 when x.entrada is null or x.saida is null then null
                 when x.saida_intervalo is null then ponto.minutos_noturnos(x.entrada, x.saida)
                 else ponto.minutos_noturnos(x.entrada, x.saida_intervalo)
                    + ponto.minutos_noturnos(x.volta_intervalo, x.saida) end as an,
               v_ant + sum(coalesce(x.saldo_min, 0)) over (order by x.data) as banco
        from ponto.apurar(fid, v_ini, v_fim) x
      ) y), '[]'),
    'saldo_periodo_min', (select coalesce(sum(x.saldo_min), 0) from ponto.apurar(fid, v_ini, v_fim) x),
    'saldo_banco_min', ponto.saldo_banco(fid));
end $$;

revoke all on all functions in schema ponto from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema ponto from anon, authenticated';
  end if;
end $$;

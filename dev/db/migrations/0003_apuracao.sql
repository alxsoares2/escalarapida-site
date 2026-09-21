-- Apuração: marcações efetivas, jornadas realizadas, dia apurado e banco de horas.
-- Regras em docs/ponto/ESPECIFICACAO.md (seção 5).

-- Marcações que valem: as originais (menos as desconsideradas) + inclusões aprovadas.
-- Truncadas no minuto.
create function ponto.marcacoes_efetivas(p_func integer, p_ini timestamptz, p_fim timestamptz)
returns table (ts timestamptz, tipo ponto.tipo_marcacao, fonte text, ref_id bigint)
language sql stable security definer set search_path = ponto, extensions, pg_temp as $$
  select * from (
    select date_trunc('minute', m.marcado_em), m.tipo, 'marcacao'::text, m.id
    from ponto.marcacao m
    where m.funcionario_id = p_func and m.marcado_em >= p_ini and m.marcado_em < p_fim
      and not exists (
        select 1 from ponto.ajuste a
        where a.tipo = 'desconsiderar' and a.status = 'aprovado' and a.marcacao_id = m.id)
    union all
    select date_trunc('minute', a.marcado_em), a.tipo_marcacao, 'ajuste'::text, a.id
    from ponto.ajuste a
    where a.funcionario_id = p_func and a.tipo = 'incluir' and a.status = 'aprovado'
      and a.marcado_em >= p_ini and a.marcado_em < p_fim
  ) x (ts, tipo, fonte, ref_id)
  order by ts, tipo, ref_id
$$;

create type ponto.jornada_real as (
  entrada         timestamptz,
  saida_intervalo timestamptz,
  volta_intervalo timestamptz,
  saida           timestamptz,
  n_jornadas      integer,   -- jornadas iniciadas neste dia (só a primeira é detalhada)
  n_orfas         integer    -- marcações do dia que não pertencem a nenhuma jornada
);

-- Agrupa as marcações em jornadas (começam numa 'entrada') e devolve a do dia.
-- O dia da jornada é a data (Recife) da entrada. Olha 20 h para trás para não
-- confundir a saída da madrugada com marcação órfã.
create function ponto.jornadas(p_func integer, p_data date) returns ponto.jornada_real
language plpgsql stable security definer set search_path = ponto, extensions, pg_temp as $$
declare
  v_ini  timestamptz := (p_data::timestamp at time zone 'America/Recife') - interval '20 hours';
  v_fim  timestamptz := ((p_data + 1)::timestamp at time zone 'America/Recife') + interval '24 hours';
  m      record;
  aberta boolean := false;
  c_e timestamptz; c_si timestamptz; c_vi timestamptz; c_s timestamptz; c_ult timestamptz;
  lista  jsonb := '[]'::jsonb;
  orfas  timestamptz[] := '{}';
  el     jsonb;
  o      timestamptz;
  e_ts   timestamptz;
  res    ponto.jornada_real := row(null, null, null, null, 0, 0);
begin
  for m in select * from ponto.marcacoes_efetivas(p_func, v_ini, v_fim) loop
    -- jornada aberta há mais de 14 h sem novas marcações: encerra como está
    if aberta and m.ts - c_ult > interval '14 hours' then
      lista := lista || jsonb_build_array(jsonb_build_object('e', c_e, 'si', c_si, 'vi', c_vi, 's', c_s));
      aberta := false;
    end if;

    if m.tipo = 'entrada' then
      if aberta then
        lista := lista || jsonb_build_array(jsonb_build_object('e', c_e, 'si', c_si, 'vi', c_vi, 's', c_s));
      end if;
      aberta := true; c_e := m.ts; c_si := null; c_vi := null; c_s := null; c_ult := m.ts;
    elsif not aberta then
      orfas := orfas || m.ts;
    elsif m.tipo = 'saida_intervalo' and c_si is null then
      c_si := m.ts; c_ult := m.ts;
    elsif m.tipo = 'volta_intervalo' and c_si is not null and c_vi is null then
      c_vi := m.ts; c_ult := m.ts;
    elsif m.tipo = 'saida' then
      c_s := m.ts;
      lista := lista || jsonb_build_array(jsonb_build_object('e', c_e, 'si', c_si, 'vi', c_vi, 's', c_s));
      aberta := false;
    else
      orfas := orfas || m.ts;
    end if;
  end loop;
  if aberta then
    lista := lista || jsonb_build_array(jsonb_build_object('e', c_e, 'si', c_si, 'vi', c_vi, 's', c_s));
  end if;

  for el in select value from jsonb_array_elements(lista) loop
    e_ts := (el ->> 'e')::timestamptz;
    if (e_ts at time zone 'America/Recife')::date = p_data then
      res.n_jornadas := res.n_jornadas + 1;
      if res.n_jornadas = 1 then
        res.entrada         := e_ts;
        res.saida_intervalo := (el ->> 'si')::timestamptz;
        res.volta_intervalo := (el ->> 'vi')::timestamptz;
        res.saida           := (el ->> 's')::timestamptz;
      end if;
    end if;
  end loop;
  foreach o in array orfas loop
    if (o at time zone 'America/Recife')::date = p_data then
      res.n_orfas := res.n_orfas + 1;
    end if;
  end loop;
  return res;
end $$;

-- Resultado da apuração de um dia.
-- status: folga | trabalho | falta | incompleto | em_andamento | compensado
create type ponto.dia_apurado as (
  data             date,
  dow              smallint,
  status           text,
  motivo           text,        -- tipo de exceção que atua no dia (ex.: atestado, feriado)
  esperado_min     integer,     -- carga esperada (0 em dia de folga)
  trabalhado_min   integer,
  intervalo_min    integer,     -- intervalo real
  saldo_min        integer,     -- variação do banco de horas no dia
  entrada          timestamptz,
  saida_intervalo  timestamptz,
  volta_intervalo  timestamptz,
  saida            timestamptz,
  prevista_entrada time,
  prevista_saida   time,
  alertas          text[]
);

create function ponto.minutos(a timestamptz, b timestamptz) returns integer
language sql immutable as $$ select round(extract(epoch from (b - a)) / 60)::integer $$;

create function ponto.apurar(p_func integer, p_ini date, p_fim date)
returns setof ponto.dia_apurado
language plpgsql stable security definer set search_path = ponto, extensions, pg_temp as $$
declare
  f      ponto.funcionario;
  v_hoje date := ponto.hoje();
  v_ini  date;
  v_fim  date;
  d      date;
  j      ponto.jornada;
  jr     ponto.jornada_real;
  r      ponto.dia_apurado;
  comp   ponto.excecao;
  troca  ponto.excecao;
  libera boolean;
  extra  boolean;
  esperado boolean;
  v_motivo text;
  v_dow  smallint;
  ent    time;
  sai    time;
  pres   integer;
  carga  integer;
  prev_e timestamptz;
  prev_s timestamptz;
  v_status text;
  trab   integer;
  int_real integer;
  saldo  integer;
  c_e integer; c_s integer; c_i integer;
  dev_e integer; dev_s integer; dev_i integer;
  elig   integer;
  neutra boolean;
  alertas text[];
begin
  select * into f from ponto.funcionario where id = p_func;
  if not found then return; end if;
  v_ini := greatest(p_ini, f.inicio_controle);
  v_fim := least(p_fim, v_hoje);
  if v_ini > v_fim then return; end if;

  for d in select g::date from generate_series(v_ini, v_fim, interval '1 day') g loop
    v_dow := extract(dow from d)::smallint;
    alertas := '{}'; trab := null; int_real := null; saldo := null; v_status := null;

    select * into j from ponto.jornada
      where funcionario_id = p_func and vigencia_inicio <= d
      order by vigencia_inicio desc limit 1;

    -- exceções ativas no dia (da pessoa ou de toda a empresa)
    select exists (select 1 from ponto.excecao e
        where e.cancelada_em is null and d between e.data_ini and e.data_fim
          and (e.funcionario_id = p_func or (e.funcionario_id is null and e.empresa_id = f.empresa_id))
          and e.tipo in ('folga_domingo', 'dia_liberado', 'atestado', 'ferias', 'licenca', 'feriado'))
      into libera;
    select exists (select 1 from ponto.excecao e
        where e.cancelada_em is null and d between e.data_ini and e.data_fim
          and e.funcionario_id = p_func and e.tipo = 'trabalho_folga')
      into extra;
    select e.tipo::text into v_motivo from ponto.excecao e
      where e.cancelada_em is null and d between e.data_ini and e.data_fim
        and (e.funcionario_id = p_func or (e.funcionario_id is null and e.empresa_id = f.empresa_id))
      order by array_position(array['feriado','ferias','licenca','atestado','folga_domingo',
                                    'dia_liberado','trabalho_folga','compensacao','troca_horario'], e.tipo::text)
      limit 1;
    select * into comp from ponto.excecao e
      where e.cancelada_em is null and d between e.data_ini and e.data_fim
        and e.funcionario_id = p_func and e.tipo = 'compensacao'
      order by e.id desc limit 1;
    select * into troca from ponto.excecao e
      where e.cancelada_em is null and d between e.data_ini and e.data_fim
        and e.funcionario_id = p_func and e.tipo = 'troca_horario'
      order by e.id desc limit 1;

    if j.id is null then
      esperado := false;
    elsif extra then
      esperado := true;
    else
      esperado := (v_dow = any (j.dias_trabalho)) and not libera;
    end if;

    ent := coalesce(troca.entrada, j.entrada);
    sai := coalesce(troca.saida, j.saida);
    carga := 0; prev_e := null; prev_s := null;
    if j.id is not null then
      pres := ((extract(epoch from (sai - ent)) / 60)::integer + 1440) % 1440;
      if pres = 0 then pres := 1440; end if;
      prev_e := (d + ent)::timestamp at time zone 'America/Recife';
      prev_s := prev_e + pres * interval '1 minute';
      if esperado then carga := pres - j.intervalo_min; end if;
    end if;

    jr := ponto.jornadas(p_func, d);
    if jr.n_jornadas > 1 then alertas := array_append(alertas, 'mais_de_uma_jornada'); end if;

    if jr.entrada is null then
      -- nenhuma entrada no dia
      if jr.n_orfas > 0 then
        v_status := 'incompleto'; alertas := array_append(alertas, 'marcacao_sem_entrada');
      elsif esperado and d = v_hoje then
        v_status := 'em_andamento';
      elsif esperado and comp.id is not null then
        v_status := 'compensado';
        saldo := -coalesce(comp.minutos, carga);
      elsif esperado then
        v_status := 'falta';
      else
        v_status := 'folga';
      end if;

    elsif jr.saida is null then
      if ponto.agora() - jr.entrada < interval '14 hours' then
        v_status := 'em_andamento';
      else
        v_status := 'incompleto'; alertas := array_append(alertas, 'sem_saida');
      end if;

    elsif jr.saida_intervalo is not null and jr.volta_intervalo is null then
      v_status := 'incompleto'; alertas := array_append(alertas, 'sem_volta_intervalo');

    else
      v_status := 'trabalho';
      if jr.saida_intervalo is null then
        trab := ponto.minutos(jr.entrada, jr.saida);
        int_real := 0;
        alertas := array_append(alertas, 'sem_intervalo');
      else
        trab := ponto.minutos(jr.entrada, jr.saida_intervalo) + ponto.minutos(jr.volta_intervalo, jr.saida);
        int_real := ponto.minutos(jr.saida_intervalo, jr.volta_intervalo);
      end if;
      if int_real > 0 and int_real < coalesce(j.intervalo_min, 15) then
        alertas := array_append(alertas, 'intervalo_curto');
      end if;

      if not esperado then
        saldo := trab;                       -- dia de folga trabalhado: tudo é crédito
      else
        -- contribuição de cada ponto ao saldo (atraso/saída antecipada = negativo)
        c_e := -ponto.minutos(prev_e, jr.entrada);
        c_s :=  ponto.minutos(prev_s, jr.saida);
        c_i := -(int_real - j.intervalo_min);
        dev_e := abs(c_e); dev_s := abs(c_s);
        dev_i := case when jr.saida_intervalo is null then j.intervalo_min else abs(c_i) end;

        -- tolerância CLT: variações de até 5 min, se a soma delas no dia for <= 10 min
        elig := 0;
        if dev_e between 1 and 5 then elig := elig + dev_e; end if;
        if dev_s between 1 and 5 then elig := elig + dev_s; end if;
        if dev_i between 1 and 5 then elig := elig + dev_i; end if;
        neutra := elig <= 10;
        if elig > 0 then
          alertas := array_append(alertas, case when neutra then 'tolerancia_aplicada' else 'tolerancia_excedida' end);
        end if;
        if neutra then
          if dev_e <= 5 then c_e := 0; end if;
          if dev_s <= 5 then c_s := 0; end if;
          if dev_i <= 5 then c_i := 0; end if;
        end if;
        saldo := c_e + c_s + c_i;
      end if;
    end if;

    r := row(d, v_dow, v_status, v_motivo, carga, trab, int_real, saldo,
             jr.entrada, jr.saida_intervalo, jr.volta_intervalo, jr.saida,
             ent, sai, alertas)::ponto.dia_apurado;
    return next r;
  end loop;
end $$;

-- Banco de horas (minutos) até a data (padrão: hoje).
create function ponto.saldo_banco(p_func integer, p_ate date default null) returns integer
language sql stable security definer set search_path = ponto, extensions, pg_temp as $$
  select f.saldo_inicial_min + coalesce(sum(a.saldo_min), 0)::integer
  from ponto.funcionario f
  left join lateral ponto.apurar(f.id, f.inicio_controle, coalesce(p_ate, ponto.hoje())) a on true
  where f.id = p_func
  group by f.id
$$;

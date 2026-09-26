-- Decisões de 26/09/2026 (especificação 3, 5.4A e 11.4A):
--   * depois da saída para o intervalo também vale "saída" (saiu no intervalo e não voltou):
--     o dia conta até a saída para o intervalo, com o alerta saiu_no_intervalo;
--   * no totem, o tipo sugerido depois da saída para o intervalo é sempre a volta;
--   * "Esqueci de marcar" no totem: pedido de correção identificado pelo rosto reconhecido.

create or replace function ponto.proximos_tipos(p_func integer) returns ponto.tipo_marcacao[]
language plpgsql stable security definer set search_path = ponto, extensions, pg_temp as $$
declare
  ult ponto.marcacao;
begin
  select * into ult from ponto.marcacao
    where funcionario_id = p_func order by marcado_em desc, id desc limit 1;
  if not found or ult.tipo = 'saida' or ult.marcado_em < ponto.agora() - interval '14 hours' then
    return array['entrada']::ponto.tipo_marcacao[];
  end if;
  return case ult.tipo
    when 'entrada'         then array['saida_intervalo', 'saida']::ponto.tipo_marcacao[]
    when 'saida_intervalo' then array['volta_intervalo', 'saida']::ponto.tipo_marcacao[]
    else                        array['saida']::ponto.tipo_marcacao[]   -- volta_intervalo
  end;
end $$;

create or replace function ponto.tipo_sugerido(p_func integer) returns ponto.tipo_marcacao
language plpgsql stable security definer set search_path = ponto, extensions, pg_temp as $$
declare
  opcoes ponto.tipo_marcacao[] := ponto.proximos_tipos(p_func);
  ent ponto.marcacao; j ponto.jornada; d date; saida_prev timestamptz;
begin
  if cardinality(opcoes) = 1 then return opcoes[1]; end if;
  -- depois da saída para o intervalo: sugere a volta (ir embora no intervalo é exceção, em "Trocar")
  if 'volta_intervalo' = any (opcoes) then return 'volta_intervalo'; end if;
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

-- Apuração: igual à 0003, exceto o dia "saiu no intervalo e não voltou" (antes: incompleto).
create or replace function ponto.apurar(p_func integer, p_ini date, p_fim date)
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
      -- saiu no intervalo e não voltou (especificação 5.4A): vale até a saída para o intervalo
      v_status := 'trabalho';
      trab := ponto.minutos(jr.entrada, jr.saida_intervalo);
      alertas := array_append(alertas, 'saiu_no_intervalo');
      saldo := case when esperado then trab - carga else trab end;

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

-- Pedido de correção do funcionário (seção 6): mesma validação para o PIN e para o rosto.
create function ponto.criar_pedido_correcao(p_func integer, a jsonb) returns bigint
language plpgsql security definer set search_path = ponto, extensions, pg_temp as $$
declare emp smallint; quando timestamptz; v_id bigint;
begin
  select empresa_id into emp from ponto.funcionario where id = p_func;
  begin
    quando := (a ->> 'marcado_em')::timestamp at time zone 'America/Recife';
  exception when others then raise exception 'E:data_invalida';
  end;
  if quando is null or quando > ponto.agora() or quando < ponto.agora() - interval '35 days' then
    raise exception 'E:data_invalida';
  end if;
  if coalesce(length(btrim(a ->> 'motivo')), 0) = 0 then raise exception 'E:motivo_obrigatorio'; end if;
  if (select count(*) from ponto.ajuste where funcionario_id = p_func and status = 'pendente') >= 5 then
    raise exception 'E:muitos_pedidos_pendentes';
  end if;
  insert into ponto.ajuste (empresa_id, funcionario_id, tipo, tipo_marcacao, marcado_em, motivo, origem)
  values (emp, p_func, 'incluir', (a ->> 'tipo_marcacao')::ponto.tipo_marcacao, quando, btrim(a ->> 'motivo'), 'funcionario')
  returning id into v_id;
  return v_id;
end $$;

create or replace function ponto.api_solicitar_correcao(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare au jsonb;
begin
  au := ponto.autenticar_funcionario(a);
  if not (au ->> 'ok')::boolean then return au; end if;
  return jsonb_build_object('ok', true, 'id', ponto.criar_pedido_correcao((au ->> 'funcionario_id')::integer, a));
end $$;

-- "Esqueci de marcar" no totem: o rosto reconhecido identifica a pessoa (identificador sem uso,
-- da mesma estação, em até 5 min). O identificador é consumido.
create function ponto.api_solicitar_correcao_rosto(a jsonb) returns jsonb
language plpgsql set search_path = ponto, extensions, pg_temp as $$
declare est ponto.estacao; rec ponto.reconhecimento; v_id bigint;
begin
  est := ponto.exigir_estacao(a);
  select * into rec from ponto.reconhecimento
    where token_hash = ponto.sha256_hex(coalesce(a ->> 'reconhecimento', '')) for update;
  if rec.id is null or rec.estacao_id <> est.id or rec.resultado <> 'reconhecido' or rec.usado_em is not null
     or rec.criado_em < ponto.agora() - interval '5 minutes' then
    raise exception 'E:reconhecimento_invalido';
  end if;
  v_id := ponto.criar_pedido_correcao(rec.funcionario_id, a);
  update ponto.reconhecimento set usado_em = ponto.agora() where id = rec.id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

revoke all on all functions in schema ponto from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema ponto from anon, authenticated';
  end if;
end $$;

-- Relógio, PIN, sequência de marcações e registro (NSR + hash encadeado).

-- Única fonte de "agora". Os testes substituem esta função para simular datas.
create function ponto.agora() returns timestamptz
language sql volatile as $$ select clock_timestamp() $$;

create function ponto.hoje() returns date
language sql stable as $$ select (ponto.agora() at time zone 'America/Recife')::date $$;

create function ponto.sha256_hex(t text) returns text
language sql immutable as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

-- Hash da marcação: encadeia com o hash anterior da mesma empresa.
create function ponto.hash_marcacao(
  p_empresa smallint, p_nsr bigint, p_func integer,
  p_tipo ponto.tipo_marcacao, p_em timestamptz, p_anterior text
) returns text language sql immutable as $$
  select ponto.sha256_hex(concat_ws('|',
    p_empresa, p_nsr, p_func, p_tipo::text,
    to_char(p_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(p_anterior, '')))
$$;

create function ponto.estacao_do_token(p_token text) returns ponto.estacao
language sql stable security definer set search_path = ponto, extensions, pg_temp as $$
  select e.* from ponto.estacao e
  where e.token_hash = ponto.sha256_hex(coalesce(p_token, '')) and e.ativa
$$;

-- Confere o PIN. Devolve o status (sem levantar erro, para o contador de
-- tentativas persistir): ok | pin_invalido | bloqueado | funcionario_invalido.
-- 5 erros seguidos bloqueiam por 5 minutos.
create function ponto.verificar_pin(p_func integer, p_pin text) returns text
language plpgsql security definer set search_path = ponto, extensions, pg_temp as $$
declare
  f ponto.funcionario;
  erros integer;
begin
  select * into f from ponto.funcionario where id = p_func and ativo for update;
  if not found then return 'funcionario_invalido'; end if;
  if f.bloqueado_ate is not null and f.bloqueado_ate > ponto.agora() then
    return 'bloqueado';
  end if;

  if p_pin is not null and crypt(p_pin, f.pin_hash) = f.pin_hash then
    update ponto.funcionario set pin_erros = 0, bloqueado_ate = null where id = p_func;
    return 'ok';
  end if;

  erros := f.pin_erros + 1;
  if erros >= 5 then
    update ponto.funcionario
      set pin_erros = 0, bloqueado_ate = ponto.agora() + interval '5 minutes'
      where id = p_func;
    return 'bloqueado';
  end if;
  update ponto.funcionario set pin_erros = erros where id = p_func;
  return 'pin_invalido';
end $$;

-- Marcações válidas agora, conforme a última marcação do funcionário.
-- Passadas 14 h da última marcação, começa uma nova jornada.
create function ponto.proximos_tipos(p_func integer) returns ponto.tipo_marcacao[]
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
    when 'saida_intervalo' then array['volta_intervalo']::ponto.tipo_marcacao[]
    else                        array['saida']::ponto.tipo_marcacao[]   -- volta_intervalo
  end;
end $$;

-- Grava a marcação: NSR sequencial por empresa + hash encadeado.
-- Validações de PIN/estação ficam na camada de API.
create function ponto.registrar_marcacao(
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
  if not found or est.empresa_id <> f.empresa_id then raise exception 'E:estacao_invalida'; end if;

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

-- Primeira marcação (NSR) cuja cadeia de hash não confere; null se íntegra.
create function ponto.verificar_cadeia(p_empresa smallint) returns bigint
language plpgsql stable security definer set search_path = ponto, extensions, pg_temp as $$
declare
  m ponto.marcacao;
  ant text := null;
  esperado_nsr bigint := 1;
begin
  for m in select * from ponto.marcacao where empresa_id = p_empresa order by nsr loop
    if m.nsr <> esperado_nsr
       or m.hash_anterior is distinct from ant
       or m.hash <> ponto.hash_marcacao(m.empresa_id, m.nsr, m.funcionario_id, m.tipo, m.marcado_em, ant) then
      return m.nsr;
    end if;
    ant := m.hash;
    esperado_nsr := esperado_nsr + 1;
  end loop;
  return null;
end $$;

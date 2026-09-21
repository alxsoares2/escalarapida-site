import test from 'node:test';
import assert from 'node:assert/strict';
import { novoBanco, cenario, dia, fixarRelogio, rpc, CHEIO } from './helpers.mjs';

const ENTRADA = (h) => [h, 'entrada'];
const SI = ['13:00', 'saida_intervalo'];
const VI = ['13:15', 'volta_intervalo'];
const SAIDA = (h) => [h, 'saida'];

async function apurar(db, func = 1, ini = '2026-09-13', fim = '2026-09-30') {
  const r = await db.query(
    `select data::text as data, status, motivo, esperado_min, trabalhado_min, intervalo_min, saldo_min, alertas
       from ponto.apurar($1::integer, $2::date, $3::date) order by data`, [func, ini, fim]);
  return Object.fromEntries(r.rows.map((x) => [x.data, x]));
}

async function montar() {
  const db = await novoBanco();
  const c = await cenario(db);
  await db.exec(`update ponto.funcionario set inicio_controle = '2026-09-13'`);

  // sessão de admin (login real)
  await db.exec(`insert into ponto.admin (email, senha_hash)
    values ('dono@teste.com', extensions.crypt('senha-teste', extensions.gen_salt('bf', 4)))`);
  await fixarRelogio(db, '2026-09-30 11:00');
  const login = await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' });
  assert.equal(login.ok, true);
  const sessao = login.sessao;

  // exceções
  await db.exec(`
    insert into ponto.excecao (empresa_id, funcionario_id, tipo, data_ini, data_fim, motivo) values
      (1, 1, 'folga_domingo', '2026-09-13', '2026-09-13', null),
      (1, 1, 'compensacao',   '2026-09-20', '2026-09-20', null),
      (1, 1, 'atestado',      '2026-09-21', '2026-09-21', 'gripe'),
      (1, null, 'feriado',    '2026-09-22', '2026-09-22', 'Aniversário da cidade');
    insert into ponto.excecao (empresa_id, funcionario_id, tipo, data_ini, data_fim, entrada, saida)
      values (1, 1, 'troca_horario', '2026-09-24', '2026-09-24', '12:00', '18:15');`);
  const troca = await rpc(db, 'admin_trocar_folga', { sessao, funcionario_id: 1, dia_novo: '2026-09-25', dia_antigo: '2026-09-26', motivo: 'casamento' });
  assert.equal(troca.ok, true);

  // marcações
  await dia(db, 1, '2026-09-14', CHEIO);
  await dia(db, 1, '2026-09-15', [ENTRADA('10:04'), SI, VI, SAIDA('16:15')]);
  await dia(db, 1, '2026-09-16', [ENTRADA('10:20'), SI, VI, SAIDA('16:15')]);
  await dia(db, 1, '2026-09-17', [ENTRADA('10:00'), SI, VI, SAIDA('17:00')]);
  await dia(db, 1, '2026-09-19', [ENTRADA('10:00'), SAIDA('14:00')]);
  await dia(db, 1, '2026-09-23', [ENTRADA('10:00'), SI, VI]);
  await dia(db, 1, '2026-09-24', [ENTRADA('12:00'), ['15:00', 'saida_intervalo'], ['15:15', 'volta_intervalo'], SAIDA('18:15')]);
  await dia(db, 1, '2026-09-26', CHEIO);
  await dia(db, 1, '2026-09-27', [ENTRADA('10:00'), SI]);
  // Beto (noite, atravessa a meia-noite): sexta 18:00 -> sábado 00:15
  await dia(db, 2, '2026-09-18', [['18:00', 'entrada'], ['21:00', 'saida_intervalo'], ['21:15', 'volta_intervalo'], ['2026-09-19 00:15', 'saida']]);

  await fixarRelogio(db, '2026-09-30 12:00');
  return { db, c, sessao };
}

test('apuração dia a dia (regras da especificação)', async (t) => {
  const { db, sessao } = await montar();
  const d = await apurar(db);

  await t.test('domingo de folga não vira falta', () => {
    assert.equal(d['2026-09-13'].status, 'folga');
    assert.equal(d['2026-09-13'].motivo, 'folga_domingo');
    assert.equal(d['2026-09-13'].saldo_min, null);
  });
  await t.test('dia perfeito: 6h, saldo 0', () => {
    assert.equal(d['2026-09-14'].status, 'trabalho');
    assert.equal(d['2026-09-14'].trabalhado_min, 360);
    assert.equal(d['2026-09-14'].esperado_min, 360);
    assert.equal(d['2026-09-14'].saldo_min, 0);
  });
  await t.test('atraso de 4 min é tolerado (CLT)', () => {
    assert.equal(d['2026-09-15'].trabalhado_min, 356);
    assert.equal(d['2026-09-15'].saldo_min, 0);
    assert.ok(d['2026-09-15'].alertas.includes('tolerancia_aplicada'));
  });
  await t.test('atraso de 20 min desconta 20 min', () => {
    assert.equal(d['2026-09-16'].saldo_min, -20);
  });
  await t.test('passou das 6h + 15 min: extra automática', () => {
    assert.equal(d['2026-09-17'].trabalhado_min, 405);
    assert.equal(d['2026-09-17'].saldo_min, 45);
  });
  await t.test('dia esperado sem marcação = falta, e falta não mexe no banco', () => {
    assert.equal(d['2026-09-18'].status, 'falta');
    assert.equal(d['2026-09-18'].saldo_min, null);
  });
  await t.test('sábado (folga) trabalhado: tudo é crédito, sem intervalo alerta', () => {
    assert.equal(d['2026-09-19'].status, 'trabalho');
    assert.equal(d['2026-09-19'].esperado_min, 0);
    assert.equal(d['2026-09-19'].saldo_min, 240);
    assert.ok(d['2026-09-19'].alertas.includes('sem_intervalo'));
  });
  await t.test('compensação sem marcação debita o dia inteiro do banco', () => {
    assert.equal(d['2026-09-20'].status, 'compensado');
    assert.equal(d['2026-09-20'].saldo_min, -360);
  });
  await t.test('atestado e feriado da empresa: folga justificada', () => {
    assert.equal(d['2026-09-21'].status, 'folga');
    assert.equal(d['2026-09-21'].motivo, 'atestado');
    assert.equal(d['2026-09-22'].status, 'folga');
    assert.equal(d['2026-09-22'].motivo, 'feriado');
  });
  await t.test('jornada sem saída e antiga: incompleto, sem saldo', () => {
    assert.equal(d['2026-09-23'].status, 'incompleto');
    assert.ok(d['2026-09-23'].alertas.includes('sem_saida'));
    assert.equal(d['2026-09-23'].saldo_min, null);
  });
  await t.test('troca de horário no dia: usa o horário novo', () => {
    assert.equal(d['2026-09-24'].status, 'trabalho');
    assert.equal(d['2026-09-24'].saldo_min, 0);
  });
  await t.test('troca de folga: novo dia liberado, dia antigo vira trabalho esperado', () => {
    assert.equal(d['2026-09-25'].status, 'folga');
    assert.equal(d['2026-09-25'].motivo, 'dia_liberado');
    assert.equal(d['2026-09-26'].status, 'trabalho');
    assert.equal(d['2026-09-26'].esperado_min, 360);
    assert.equal(d['2026-09-26'].saldo_min, 0);
  });
  await t.test('domingo com entrada e saída_intervalo e nada depois: incompleto', () => {
    assert.equal(d['2026-09-27'].status, 'incompleto');
  });
  await t.test('falta nos dias passados; hoje ainda em andamento', () => {
    assert.equal(d['2026-09-28'].status, 'falta');
    assert.equal(d['2026-09-29'].status, 'falta');
    assert.equal(d['2026-09-30'].status, 'em_andamento');
  });
  await t.test('banco de horas = soma dos saldos (falta não entra)', async () => {
    const r = await db.query('select ponto.saldo_banco(1) as s');
    assert.equal(r.rows[0].s, -20 + 45 + 240 - 360);
  });

  await t.test('jornada que atravessa a meia-noite (Beto)', async () => {
    const b = await apurar(db, 2, '2026-09-13', '2026-09-27');
    assert.equal(b['2026-09-18'].status, 'trabalho');
    assert.equal(b['2026-09-18'].saldo_min, 0);
    assert.equal(b['2026-09-19'].status, 'folga');      // a saída de 00:15 não é "marcação órfã"
    assert.equal(b['2026-09-25'].status, 'falta');
  });

  await t.test('correção do dono completa o dia incompleto (volta do intervalo esquecida)', async () => {
    const corrig = { sessao, funcionario_id: 1, tipo: 'incluir', motivo: 'esqueceu de bater' };
    assert.equal((await rpc(db, 'admin_criar_correcao', { ...corrig, tipo_marcacao: 'saida', marcado_em: '2026-09-27T16:15' })).ok, true);
    let x = await apurar(db);
    assert.equal(x['2026-09-27'].status, 'incompleto');
    assert.ok(x['2026-09-27'].alertas.includes('sem_volta_intervalo'));
    assert.equal((await rpc(db, 'admin_criar_correcao', { ...corrig, tipo_marcacao: 'volta_intervalo', marcado_em: '2026-09-27T13:15' })).ok, true);
    x = await apurar(db);
    assert.equal(x['2026-09-27'].status, 'trabalho');
    assert.equal(x['2026-09-27'].saldo_min, 0);
  });

  await t.test('desconsiderar + incluir corrige um dia sem apagar a marcação original', async () => {
    const m = (await rpc(db, 'admin_marcacoes', { sessao, funcionario_id: 1, ini: '2026-09-17', fim: '2026-09-17' })).marcacoes;
    const saida = m.find((x) => x.tipo === 'saida');
    assert.equal((await rpc(db, 'admin_criar_correcao', { sessao, funcionario_id: 1, tipo: 'desconsiderar', marcacao_id: saida.id, motivo: 'marcou errado' })).ok, true);
    assert.equal((await rpc(db, 'admin_criar_correcao', { sessao, funcionario_id: 1, tipo: 'incluir', tipo_marcacao: 'saida', marcado_em: '2026-09-17T16:15', motivo: 'horário correto' })).ok, true);
    const x = await apurar(db);
    assert.equal(x['2026-09-17'].saldo_min, 0);
    const bruto = await db.query(`select count(*)::int n from ponto.marcacao where funcionario_id = 1 and (marcado_em at time zone 'America/Recife')::date = '2026-09-17'`);
    assert.equal(bruto.rows[0].n, 4);   // as 4 originais continuam lá
  });

  await t.test('relatórios da API: faltas e banco', async () => {
    const f = await rpc(db, 'admin_faltas', { sessao, empresa_id: 1, ini: '2026-09-13', fim: '2026-09-30' });
    const ana = f.funcionarios.find((x) => x.nome === 'Ana');
    assert.deepEqual(ana.datas, ['2026-09-18', '2026-09-28', '2026-09-29']);
    const b = await rpc(db, 'admin_banco', { sessao, funcionario_id: 1, ini: '2026-09-13', fim: '2026-09-30' });
    assert.equal(b.saldo_atual_min, -20 + 240 - 360);
    assert.equal(b.movimentos.length, 3);
  });
});

test('domingos de folga: só domingos do mês informado', async () => {
  const { db, sessao } = await montar();
  const ruim = await rpc(db, 'admin_domingos', { sessao, funcionario_id: 1, mes: '2026-09-01', domingos: ['2026-09-14'] });
  assert.deepEqual([ruim.ok, ruim.erro], [false, 'domingo_invalido']);
  const fora = await rpc(db, 'admin_domingos', { sessao, funcionario_id: 1, mes: '2026-09-01', domingos: ['2026-10-04'] });
  assert.equal(fora.erro, 'domingo_invalido');
  const ok = await rpc(db, 'admin_domingos', { sessao, funcionario_id: 1, mes: '2026-09-01', domingos: ['2026-09-20', '2026-09-27'] });
  assert.equal(ok.ok, true);
  const d = await apurar(db);
  // a definição do mês SUBSTITUI as anteriores: 13/09 deixa de ser folga (sem marcação = falta)
  assert.equal(d['2026-09-13'].status, 'falta');
  assert.equal(d['2026-09-20'].motivo, 'folga_domingo');
  assert.equal(d['2026-09-27'].motivo, 'folga_domingo');
});

test('adicional noturno: minutos entre 22h e 5h (horário de Recife)', async () => {
  const db = await novoBanco();
  const noturno = async (a, b) => (await db.query('select ponto.minutos_noturnos($1::timestamptz, $2::timestamptz) n',
    [a.replace(' ', 'T') + ':00-03:00', b.replace(' ', 'T') + ':00-03:00'])).rows[0].n;
  assert.equal(await noturno('2026-09-14 10:00', '2026-09-14 16:15'), 0);            // dia
  assert.equal(await noturno('2026-09-14 21:00', '2026-09-14 23:00'), 60);           // entra na janela
  assert.equal(await noturno('2026-09-14 18:00', '2026-09-15 00:15'), 135);          // 22:00 -> 00:15
  assert.equal(await noturno('2026-09-14 20:00', '2026-09-15 02:00'), 240);          // 22:00 -> 02:00
  assert.equal(await noturno('2026-09-15 04:00', '2026-09-15 06:00'), 60);           // 04:00 -> 05:00
  assert.equal(await noturno('2026-09-14 20:00', '2026-09-15 07:00'), 420);          // janela inteira: 22h -> 5h
  assert.equal(await noturno('2026-09-15 05:00', '2026-09-15 06:00'), 0);            // logo após a janela
  assert.equal(await noturno('2026-09-14 22:00', '2026-09-14 22:00'), 0);            // intervalo vazio
});

test('espelho: banco de horas acumulado dia a dia, noturno e jornada', async (t) => {
  const { db, sessao } = await montar();
  const r = await rpc(db, 'admin_apuracao', { sessao, funcionario_id: 1, ini: '2026-09-13', fim: '2026-09-30' });
  assert.equal(r.ok, true);
  const dia = Object.fromEntries(r.dias.map((d) => [d.data, d]));

  await t.test('acumulado soma só os dias com saldo (falta não move o banco)', () => {
    assert.equal(r.saldo_anterior_min, 0);
    assert.equal(dia['2026-09-14'].banco_min, 0);
    assert.equal(dia['2026-09-16'].banco_min, -20);
    assert.equal(dia['2026-09-17'].banco_min, -20 + 45);
    assert.equal(dia['2026-09-18'].banco_min, 25);                 // falta: banco igual ao dia anterior
    assert.equal(dia['2026-09-19'].banco_min, 265);
    assert.equal(dia['2026-09-20'].banco_min, -95);                // compensação de 6h
    assert.equal(dia['2026-09-30'].banco_min, r.saldo_banco_min);  // último dia = banco atual
    assert.equal(r.saldo_banco_min, -95);
  });
  await t.test('adicional noturno vazio em jornada diurna', () => {
    assert.equal(dia['2026-09-14'].an_min, 0);
    assert.equal(dia['2026-09-18'].an_min, null);                  // falta: sem marcações
  });
  await t.test('jornada vigente vem junto (para a carga por dia da semana)', () => {
    assert.deepEqual(r.jornada.dias_trabalho, [0, 1, 2, 3, 4, 5]);
    assert.equal(r.jornada.entrada, '10:00:00');
    assert.equal(r.jornada.saida, '16:15:00');
    assert.equal(r.jornada.intervalo_min, 15);
  });
  await t.test('noturno de quem fecha a loja: 18h às 0h15 = 135 min', async () => {
    const b = await rpc(db, 'admin_apuracao', { sessao, funcionario_id: 2, ini: '2026-09-13', fim: '2026-09-27' });
    const d = b.dias.find((x) => x.data === '2026-09-18');
    assert.equal(d.an_min, 135);
    assert.equal(d.status, 'trabalho');
  });
  await t.test('saldo anterior do mês seguinte carrega o banco', async () => {
    const m = await rpc(db, 'admin_apuracao', { sessao, funcionario_id: 1, ini: '2026-09-20', fim: '2026-09-30' });
    assert.equal(m.saldo_anterior_min, 265);                       // banco até 19/09
    assert.equal(m.dias[0].banco_min, 265 - 360);                  // 20/09 compensação
  });
});

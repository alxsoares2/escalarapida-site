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

// Versão 2, fase 2A (especificação 11.4A): reconhecimento facial em modo totem — regras no banco.
import test from 'node:test';
import assert from 'node:assert/strict';
import { novoBanco, cenario, fixarRelogio, rpc, pessoa, quase, cinco } from './helpers.mjs';

const ANA = pessoa(1), BETO = pessoa(2), CARLA = pessoa(3);
const VIVO = { antispoof: 0.9, liveness: 0.9 };

async function pronto() {
  const db = await novoBanco();
  const c = await cenario(db);
  await db.exec(`insert into ponto.empresa (nome) values ('Outra');
    insert into ponto.funcionario (empresa_id, nome, pin_hash, inicio_controle)
      values (2, 'Carla', extensions.crypt('4321', extensions.gen_salt('bf', 4)), '2026-09-01');
    update ponto.estacao set nome = 'Tablet', tira_foto = true, reconhece_rosto = true;
    insert into ponto.admin (email, senha_hash)
      values ('dono@teste.com', extensions.crypt('senha-teste', extensions.gen_salt('bf', 4)));`);
  await fixarRelogio(db, '2026-09-14 10:00');
  const sessao = (await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' })).sessao;
  const rec = (descritor, extra = {}) => rpc(db, 'reconhecer', { token: c.token, descritor, ...VIVO, ...extra });
  return { db, c, sessao, rec };
}

test('similaridade: mesma conta da biblioteca', async () => {
  const { db } = await pronto();
  const sim = async (a, b) => (await db.query('select ponto.similaridade($1::real[], $2::real[]) s', [a, b])).rows[0].s;
  assert.equal(await sim(ANA, ANA), 1);
  assert.ok(await sim(ANA, quase(ANA)) > 0.9);
  assert.equal(await sim(ANA, BETO), 0);
  assert.equal(await sim(ANA, ANA.slice(0, 512)), 0, 'tamanhos diferentes não se comparam');
});

test('reconhecimento 1 para N', async (t) => {
  const { db, c, sessao, rec } = await pronto();

  await t.test('sem ninguém cadastrado', async () => {
    assert.deepEqual(await rec(ANA), { ok: true, reconhecido: false, motivo: 'sem_cadastro' });
  });

  await t.test('cadastro pelo painel: 3 a 8 amostras, descritores nunca voltam pela API', async () => {
    assert.equal((await rpc(db, 'admin_salvar_rosto', { sessao, funcionario_id: 1, amostras: cinco(ANA).slice(0, 2) })).erro, 'amostras_invalidas');
    assert.equal((await rpc(db, 'admin_salvar_rosto', { sessao, funcionario_id: 1, amostras: [{ posicao: 'x', descritor: ['a'] }, ...cinco(ANA)] })).erro, 'amostras_invalidas');
    assert.equal((await rpc(db, 'admin_salvar_rosto', { sessao, funcionario_id: 1, amostras: cinco(ANA) })).amostras, 5);
    assert.equal((await rpc(db, 'admin_salvar_rosto', { sessao, funcionario_id: 2, amostras: cinco(BETO) })).ok, true);
    assert.equal((await rpc(db, 'admin_salvar_rosto', { sessao, funcionario_id: 3, amostras: cinco(CARLA) })).ok, true);
    assert.equal((await rpc(db, 'admin_salvar_rosto', { funcionario_id: 1, amostras: cinco(ANA) })).erro, 'sessao_invalida');
    const lista = await rpc(db, 'admin_funcionarios', { sessao, empresa_id: 1 });
    assert.deepEqual(lista.funcionarios.map((f) => [f.nome, f.rosto_amostras]), [['Ana', 5], ['Beto', 5]]);
    const tudo = JSON.stringify([lista, await rpc(db, 'admin_reconhecimentos', { sessao }), await rpc(db, 'admin_estacoes', { sessao })]);
    assert.ok(!tudo.includes('descritor') && !tudo.includes(String(ANA[0]) + ','), 'nenhuma API devolve descritores');
  });

  await t.test('reconhece a pessoa certa e sugere o tipo', async () => {
    const r = await rec(quase(ANA, 0.02));
    assert.equal(r.reconhecido, true);
    assert.deepEqual(r.funcionario, { id: 1, nome: 'Ana', empresa: 'Basílico' });
    assert.equal(r.sugestao, 'entrada');
    assert.deepEqual(r.opcoes, ['entrada']);
    assert.equal(r.recente, false);
    assert.match(r.reconhecimento, /^[0-9a-f]{32}$/);
  });

  await t.test('rosto desconhecido não é reconhecido', async () => {
    assert.deepEqual(await rec(pessoa(9)), { ok: true, reconhecido: false, motivo: 'nao_reconhecido' });
  });

  await t.test('prova de vida baixa nem compara', async () => {
    assert.equal((await rec(ANA, { antispoof: 0.2 })).motivo, 'prova_de_vida');
    assert.equal((await rec(ANA, { liveness: 0.1 })).motivo, 'prova_de_vida');
    assert.equal((await rec(ANA, { antispoof: null, liveness: null })).motivo, 'prova_de_vida');
  });

  await t.test('duas pessoas parecidas demais (margem pequena) = não reconhece', async () => {
    await rpc(db, 'admin_salvar_rosto', { sessao, funcionario_id: 2, amostras: cinco(quase(ANA, 0.03)) });
    assert.equal((await rec(ANA)).motivo, 'nao_reconhecido');
    await rpc(db, 'admin_salvar_rosto', { sessao, funcionario_id: 2, amostras: cinco(BETO) });
  });

  await t.test('só compara com funcionários das empresas que a estação atende', async () => {
    assert.equal((await rec(CARLA)).motivo, 'nao_reconhecido');
    await db.exec('insert into ponto.estacao_empresa (estacao_id, empresa_id) values (1, 2)');
    assert.equal((await rec(CARLA)).funcionario.nome, 'Carla');
  });

  await t.test('estação sem reconhecimento ligado e descritor inválido são recusados', async () => {
    assert.equal((await rpc(db, 'reconhecer', { token: c.token, descritor: 'x', ...VIVO })).erro, 'descritor_invalido');
    assert.equal((await rpc(db, 'reconhecer', { token: c.token, descritor: [1, 2, 3], ...VIVO })).erro, 'descritor_invalido');
    assert.equal((await rpc(db, 'reconhecer', { token: c.token, descritor: ['a', ...ANA.slice(1)], ...VIVO })).erro, 'descritor_invalido');
    await db.exec('update ponto.estacao set reconhece_rosto = false');
    assert.equal((await rec(ANA)).erro, 'rosto_desligado');
    await db.exec('update ponto.estacao set reconhece_rosto = true');
  });

  await t.test('cada tentativa fica registrada para calibração (com notas)', async () => {
    const r = await rpc(db, 'admin_reconhecimentos', { sessao });
    const res = r.tentativas.map((x) => x.resultado);
    for (const esperado of ['sem_cadastro', 'reconhecido', 'nao_reconhecido', 'prova_de_vida']) assert.ok(res.includes(esperado), esperado);
    const ok = r.tentativas.find((x) => x.resultado === 'reconhecido' && x.funcionario === 'Ana');
    assert.ok(ok.similaridade > 0.9 && ok.antispoof > 0.8);
    assert.deepEqual([r.limiar, r.margem], [0.65, 0.1]);
  });
});

test('marcação por rosto', async (t) => {
  const { db, c, sessao, rec } = await pronto();
  for (const [fid, v] of [[1, ANA], [2, BETO]]) await rpc(db, 'admin_salvar_rosto', { sessao, funcionario_id: fid, amostras: cinco(v) });

  let entradaId;
  await t.test('reconhecido + tipo + foto = marcação com origem rosto', async () => {
    const r = await rec(ANA);
    const m = await rpc(db, 'registrar_rosto', { token: c.token, reconhecimento: r.reconhecimento, tipo: 'entrada', foto_hash: 'c'.repeat(64) });
    assert.equal(m.ok, true);
    assert.equal(m.comprovante.funcionario, 'Ana');
    assert.equal(m.comprovante.nsr, 1);
    entradaId = m.marcacao_id;
    const row = (await db.query('select origem_identificacao o, reconhecimento_id is not null tem, sem_rosto, foto_hash from ponto.marcacao where id = $1', [entradaId])).rows[0];
    assert.deepEqual(row, { o: 'rosto', tem: true, sem_rosto: false, foto_hash: 'c'.repeat(64) });
    assert.equal((await db.query('select ponto.verificar_cadeia(1::smallint) v')).rows[0].v, null);
  });

  await t.test('o identificador vale uma vez só', async () => {
    const r = await rec(BETO);
    assert.equal((await rpc(db, 'registrar_rosto', { token: c.token, reconhecimento: r.reconhecimento, tipo: 'entrada' })).ok, true);
    assert.equal((await rpc(db, 'registrar_rosto', { token: c.token, reconhecimento: r.reconhecimento, tipo: 'entrada' })).erro, 'reconhecimento_invalido');
  });

  await t.test('vence em 60 s, e não serve em outra estação', async () => {
    await fixarRelogio(db, '2026-09-14 13:00');
    let r = await rec(ANA);
    await fixarRelogio(db, '2026-09-14T13:01:01-03:00');
    assert.equal((await rpc(db, 'registrar_rosto', { token: c.token, reconhecimento: r.reconhecimento, tipo: 'saida_intervalo' })).erro, 'reconhecimento_invalido');
    r = await rec(ANA);
    await db.exec(`insert into ponto.estacao (empresa_id, nome, token_hash) values (1, 'Outra', ponto.sha256_hex('tok-2'))`);
    assert.equal((await rpc(db, 'registrar_rosto', { token: 'tok-2', reconhecimento: r.reconhecimento, tipo: 'saida_intervalo' })).erro, 'reconhecimento_invalido');
    assert.equal((await rpc(db, 'registrar_rosto', { token: c.token, reconhecimento: 'inventado', tipo: 'saida_intervalo' })).erro, 'reconhecimento_invalido');
  });

  await t.test('"Não sou eu" invalida o reconhecimento', async () => {
    const r = await rec(ANA);
    assert.equal((await rpc(db, 'cancelar_reconhecimento', { token: c.token, reconhecimento: r.reconhecimento })).ok, true);
    assert.equal((await rpc(db, 'registrar_rosto', { token: c.token, reconhecimento: r.reconhecimento, tipo: 'saida_intervalo' })).erro, 'reconhecimento_invalido');
    const st = (await db.query(`select resultado from ponto.reconhecimento order by id desc limit 1`)).rows[0].resultado;
    assert.equal(st, 'cancelado');
  });

  await t.test('tipo sugerido: intervalo no meio da jornada, saída perto do fim (jornada 10:00–16:15)', async () => {
    await fixarRelogio(db, '2026-09-14 13:02');
    let r = await rec(ANA);
    assert.deepEqual([r.sugestao, r.opcoes], ['saida_intervalo', ['saida_intervalo', 'saida']]);
    await fixarRelogio(db, '2026-09-14 15:44');
    assert.equal((await rec(ANA)).sugestao, 'saida_intervalo');
    await fixarRelogio(db, '2026-09-14 15:45');
    r = await rec(ANA);
    assert.equal(r.sugestao, 'saida');
    assert.equal((await rpc(db, 'registrar_rosto', { token: c.token, reconhecimento: r.reconhecimento, tipo: 'saida' })).ok, true);
    await fixarRelogio(db, '2026-09-14T15:45:40-03:00');
    assert.equal((await rec(ANA)).recente, true, 'marcou há menos de 1 minuto');
  });

  await t.test('jornada que atravessa a meia-noite (Beto 18:00–00:15)', async () => {
    await db.exec(`delete from ponto.rosto where funcionario_id = 2`);
    await rpc(db, 'admin_salvar_rosto', { sessao, funcionario_id: 2, amostras: cinco(BETO) });
    await fixarRelogio(db, '2026-09-18 18:00');
    let r = await rec(BETO);
    await rpc(db, 'registrar_rosto', { token: c.token, reconhecimento: r.reconhecimento, tipo: 'entrada' });
    await fixarRelogio(db, '2026-09-18 21:00');
    assert.equal((await rec(BETO)).sugestao, 'saida_intervalo');
    await fixarRelogio(db, '2026-09-18 23:50');
    assert.equal((await rec(BETO)).sugestao, 'saida');
  });

  // a sessão do gestor dura 12 h; os testes abaixo andam dias no relógio
  const novaSessao = async () => (await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' })).sessao;

  await t.test('PIN numa estação com reconhecimento: alerta sem_rosto só para quem tem cadastro', async () => {
    await fixarRelogio(db, '2026-09-19 10:00');
    const sessao = await novaSessao();
    const a = await rpc(db, 'registrar', { token: c.token, funcionario_id: 1, pin: '1234', tipo: 'entrada' });
    await db.exec('insert into ponto.estacao_empresa (estacao_id, empresa_id) values (1, 2)');
    const b = await rpc(db, 'registrar', { token: c.token, funcionario_id: 3, pin: '4321', tipo: 'entrada' });
    const q = async (id) => (await db.query('select origem_identificacao o, sem_rosto from ponto.marcacao where id = $1', [id])).rows[0];
    assert.deepEqual(await q(a.marcacao_id), { o: 'pin', sem_rosto: true });
    assert.deepEqual(await q(b.marcacao_id), { o: 'pin', sem_rosto: false });
    const rel = await rpc(db, 'admin_marcacoes_fotos', { sessao, funcionario_id: 1, ini: '2026-09-19', fim: '2026-09-19' });
    assert.deepEqual(rel.marcacoes.map((m) => [m.origem, m.sem_rosto]), [['pin', true]]);
  });

  await t.test('limite de 30 tentativas por minuto por estação', async () => {
    await fixarRelogio(db, '2026-09-20 10:00');
    for (let i = 0; i < 30; i++) await rec(pessoa(50 + i));
    assert.equal((await rec(ANA)).erro, 'muitas_tentativas');
    await fixarRelogio(db, '2026-09-20T10:01:01-03:00');
    assert.equal((await rec(ANA)).reconhecido, true);
  });

  await t.test('funcionário inativado perde o cadastro facial; gestor também pode apagar', async () => {
    const sessao = await novaSessao();
    await rpc(db, 'admin_salvar_funcionario', { sessao, id: 2, nome: 'Beto', ativo: false });
    assert.equal((await db.query('select count(*)::int n from ponto.rosto where funcionario_id = 2')).rows[0].n, 0);
    await rpc(db, 'admin_apagar_rosto', { sessao, funcionario_id: 1 });
    assert.equal((await db.query('select count(*)::int n from ponto.rosto')).rows[0].n, 0);
  });
});

test('estação: reconhecer exige tirar foto; tudo configurável pelo painel', async () => {
  const { db, sessao } = await pronto();
  const r = await rpc(db, 'admin_criar_estacao', { sessao, nome: 'Tablet 2', empresa_ids: [1], reconhece_rosto: true, tira_foto: false, imprime: false });
  const e = await rpc(db, 'estacao', { token: r.token });
  assert.deepEqual([e.estacao.reconhece_rosto, e.estacao.tira_foto], [true, true]);
  await rpc(db, 'admin_salvar_estacao', { sessao, id: r.id, nome: 'Tablet 2', empresa_ids: [1], reconhece_rosto: false, tira_foto: false });
  const e2 = await rpc(db, 'estacao', { token: r.token });
  assert.deepEqual([e2.estacao.reconhece_rosto, e2.estacao.tira_foto], [false, false]);
  const lista = (await rpc(db, 'admin_estacoes', { sessao })).estacoes.find((s) => s.id === r.id);
  assert.equal(lista.reconhece_rosto, false);
  for (const fn of ['reconhecer', 'registrar_rosto', 'cancelar_reconhecimento']) {
    assert.equal((await rpc(db, fn, { token: 'errado' })).erro, 'estacao_invalida', fn);
  }
});

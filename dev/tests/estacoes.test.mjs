// Versão 2, fase 1 (especificação 11.2 e 11.8): estação com várias empresas,
// configuração por estação e sinal de vida para o quadro de saúde.
import test from 'node:test';
import assert from 'node:assert/strict';
import { novoBanco, cenario, fixarRelogio, rpc } from './helpers.mjs';

async function pronto() {
  const db = await novoBanco();
  const c = await cenario(db);
  await db.exec(`insert into ponto.empresa (nome, cnpj) values ('Outra', '11.111.111/0001-11');
    insert into ponto.funcionario (empresa_id, nome, pin_hash, inicio_controle)
      values (2, 'Carla', extensions.crypt('4321', extensions.gen_salt('bf', 4)), '2026-09-01');
    insert into ponto.admin (email, senha_hash)
      values ('dono@teste.com', extensions.crypt('senha-teste', extensions.gen_salt('bf', 4)));`);
  await fixarRelogio(db, '2026-09-14 09:00');
  const sessao = (await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' })).sessao;
  return { db, c, sessao };
}

test('estação que atende duas empresas (tablet com abas)', async (t) => {
  const { db, c, sessao } = await pronto();

  await t.test('sem vínculo, a estação só conhece a própria empresa', async () => {
    const r = await rpc(db, 'estacao', { token: c.token });
    assert.deepEqual(r.empresas.map((e) => e.nome), ['Basílico']);
    assert.equal((await rpc(db, 'registrar', { token: c.token, funcionario_id: 3, pin: '4321', tipo: 'entrada' })).erro, 'funcionario_invalido');
  });

  await t.test('gestor liga a segunda empresa e desliga a impressão', async () => {
    assert.equal((await rpc(db, 'admin_salvar_estacao', { sessao, id: c.estacao, nome: 'Tablet', empresa_ids: [1, 2], imprime: false })).ok, true);
    const r = await rpc(db, 'estacao', { token: c.token });
    assert.deepEqual(r.empresas.map((e) => [e.nome, e.funcionarios.map((f) => f.nome)]), [['Basílico', ['Ana', 'Beto']], ['Outra', ['Carla']]]);
    assert.equal(r.estacao.nome, 'Tablet');
    assert.equal(r.estacao.imprime, false);
    // campos da versão 1 continuam (tela publicada antes da migration)
    assert.equal(r.empresa.nome, 'Basílico');
    assert.deepEqual(r.funcionarios.map((f) => f.nome), ['Ana', 'Beto']);
  });

  await t.test('marca pelas duas empresas; NSR e cadeia de hash continuam por empresa', async () => {
    const carla = await rpc(db, 'registrar', { token: c.token, funcionario_id: 3, pin: '4321', tipo: 'entrada' });
    assert.equal(carla.ok, true);
    assert.equal(carla.comprovante.empresa, 'Outra');
    assert.equal(carla.comprovante.cnpj, '11.111.111/0001-11');
    assert.equal(carla.comprovante.nsr, 1);
    const ana = await rpc(db, 'registrar', { token: c.token, funcionario_id: 1, pin: '1234', tipo: 'entrada' });
    assert.equal(ana.comprovante.nsr, 1);
    for (const emp of [1, 2]) {
      assert.equal((await db.query('select ponto.verificar_cadeia($1::smallint) v', [emp])).rows[0].v, null);
    }
  });

  await t.test('tirar a empresa da estação volta a bloquear; a principal fica', async () => {
    assert.equal((await rpc(db, 'admin_salvar_estacao', { sessao, id: c.estacao, nome: 'Tablet', empresa_ids: [1] })).ok, true);
    await fixarRelogio(db, '2026-09-14 13:00');
    assert.equal((await rpc(db, 'estado', { token: c.token, funcionario_id: 3, pin: '4321' })).erro, 'funcionario_invalido');
    assert.equal((await rpc(db, 'estado', { token: c.token, funcionario_id: 1, pin: '1234' })).ok, true);
  });

  await t.test('trocar a empresa principal por outra mantém a estação consistente', async () => {
    assert.equal((await rpc(db, 'admin_salvar_estacao', { sessao, id: c.estacao, nome: 'Tablet', empresa_ids: [2] })).ok, true);
    const r = await rpc(db, 'estacao', { token: c.token });
    assert.deepEqual(r.empresas.map((e) => e.nome), ['Outra']);
    assert.equal(r.empresa.nome, 'Outra');
    await rpc(db, 'admin_salvar_estacao', { sessao, id: c.estacao, nome: 'Tablet', empresa_ids: [1, 2] });
  });

  await t.test('pelo menos uma empresa, e só empresas que existem', async () => {
    assert.equal((await rpc(db, 'admin_salvar_estacao', { sessao, id: c.estacao, nome: 'Tablet', empresa_ids: [] })).erro, 'empresa_obrigatoria');
    assert.equal((await rpc(db, 'admin_salvar_estacao', { sessao, id: c.estacao, nome: 'Tablet', empresa_ids: [1, 99] })).erro, 'empresa_obrigatoria');
    assert.equal((await rpc(db, 'admin_criar_estacao', { sessao, nome: 'X', empresa_ids: [] })).erro, 'empresa_obrigatoria');
    assert.equal((await rpc(db, 'admin_salvar_estacao', { sessao, id: 99, nome: 'X', empresa_ids: [1] })).erro, 'estacao_invalida');
  });

  await t.test('criar estação com várias empresas: a primeira da lista é a principal', async () => {
    const r = await rpc(db, 'admin_criar_estacao', { sessao, nome: 'Balcão 2', empresa_ids: [2, 1], reserva: true });
    assert.equal(r.ok, true);
    const est = await rpc(db, 'estacao', { token: r.token });
    assert.deepEqual(est.empresas.map((e) => e.nome), ['Outra', 'Basílico']);
    assert.equal(est.estacao.imprime, true, 'imprime por padrão (como o computador da Elgin)');
    const lista = (await rpc(db, 'admin_estacoes', { sessao })).estacoes;
    const b2 = lista.find((s) => s.nome === 'Balcão 2');
    assert.deepEqual([b2.reserva, b2.empresa_ids], [true, [2, 1]]);
  });
});

test('sinal de vida e quadro de saúde das estações', async (t) => {
  const { db, c, sessao } = await pronto();
  const estacao = async () => (await rpc(db, 'admin_estacoes', { sessao })).estacoes.find((s) => s.id === c.estacao);

  await t.test('estação que nunca mandou sinal', async () => {
    const s = await estacao();
    assert.deepEqual([s.ultimo_contato, s.online, s.relogio_ok], [null, false, null]);
  });

  await t.test('sinal grava o último contato e a diferença do relógio', async () => {
    const r = await rpc(db, 'estacao_sinal', { token: c.token, relogio: '2026-09-14T09:00:40-03:00' });
    assert.equal(r.ok, true);
    const s = await estacao();
    assert.equal(s.online, true);
    assert.equal(s.relogio_dif_ms, 40000);
    assert.equal(s.relogio_ok, true);
  });

  await t.test('relógio mais de 5 min fora é sinalizado (nos dois sentidos)', async () => {
    await rpc(db, 'estacao_sinal', { token: c.token, relogio: '2026-09-14T09:07:00-03:00' });
    let s = await estacao();
    assert.deepEqual([s.relogio_dif_ms, s.relogio_ok], [420000, false]);
    await rpc(db, 'estacao_sinal', { token: c.token, relogio: '2026-09-14T08:54:00-03:00' });
    s = await estacao();
    assert.deepEqual([s.relogio_dif_ms, s.relogio_ok], [-360000, false]);
  });

  await t.test('sem sinal há mais de 10 min aparece fora do ar', async () => {
    await fixarRelogio(db, '2026-09-14 09:09');
    assert.equal((await estacao()).online, true);
    await fixarRelogio(db, '2026-09-14 09:11');
    assert.equal((await estacao()).online, false);
  });

  await t.test('relógio ilegível não derruba o sinal; token errado é recusado', async () => {
    assert.equal((await rpc(db, 'estacao_sinal', { token: c.token, relogio: 'lixo' })).ok, true);
    const s = await estacao();
    assert.deepEqual([s.online, s.relogio_dif_ms, s.relogio_ok], [true, null, null]);
    assert.equal((await rpc(db, 'estacao_sinal', { token: 'errado' })).erro, 'estacao_invalida');
  });

  await t.test('quadro de saúde exige sessão de gestor', async () => {
    assert.equal((await rpc(db, 'admin_estacoes', {})).erro, 'sessao_invalida');
    assert.equal((await rpc(db, 'admin_salvar_estacao', { id: 1, nome: 'x', empresa_ids: [1] })).erro, 'sessao_invalida');
  });
});

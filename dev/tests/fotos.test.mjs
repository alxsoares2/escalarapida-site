// Versão 2, fase 2 (especificação 11.4): foto como prova.
// Regras no banco + a lógica real da Edge Function (handler.js) ligada ao banco em memória
// e a um Storage simulado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { novoBanco, cenario, fixarRelogio, rpc } from './helpers.mjs';
import { criarHandler, LIMITE_BYTES } from '../supabase/functions/ponto-foto/handler.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const FOTO = Buffer.from('RIFF....WEBPfoto-de-teste-da-ana');
const OUTRA = Buffer.from('RIFF....WEBPoutra-foto');

async function pronto() {
  const db = await novoBanco();
  const c = await cenario(db);
  await db.exec(`update ponto.estacao set tira_foto = true;
    insert into ponto.admin (email, senha_hash)
      values ('dono@teste.com', extensions.crypt('senha-teste', extensions.gen_salt('bf', 4)));`);
  await fixarRelogio(db, '2026-09-14 10:00');
  const sessao = (await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' })).sessao;
  // Storage simulado: guarda os arquivos em memória
  const arquivos = new Map();
  const storage = {
    async upload(caminho, bytes, tipo) {
      if (arquivos.has(caminho)) throw new Error('The resource already exists');
      arquivos.set(caminho, { bytes: Buffer.from(bytes), tipo });
    },
    async signedUrls(caminhos) { return caminhos.map((x) => 'https://storage.teste/assinado/' + x); }
  };
  const handler = criarHandler({ sql: async (t, p) => (await db.query(t, p)).rows, storage });
  return { db, c, sessao, arquivos, handler };
}

const envio = (corpo, { token = 'tok-estacao', id, tipo = 'image/webp' } = {}) =>
  new Request('https://f.teste/ponto-foto', { method: 'POST', body: corpo,
    headers: { 'content-type': tipo, 'x-ponto-token': token, 'x-marcacao-id': String(id) } });
const pedidoVer = (corpo) => new Request('https://f.teste/ponto-foto', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });

test('foto no hash encadeado', async (t) => {
  const { db, c } = await pronto();

  await t.test('registrar com foto grava o hash da foto e devolve o id da marcação', async () => {
    const r = await rpc(db, 'registrar', { token: c.token, funcionario_id: 1, pin: '1234', tipo: 'entrada', foto_hash: sha(FOTO) });
    assert.equal(r.ok, true);
    assert.ok(Number(r.marcacao_id) > 0);
    const m = (await db.query('select foto_hash, foto_exigida from ponto.marcacao where id = $1', [r.marcacao_id])).rows[0];
    assert.deepEqual(m, { foto_hash: sha(FOTO), foto_exigida: true });
  });

  await t.test('hash de foto em formato errado é recusado', async () => {
    await fixarRelogio(db, '2026-09-14 10:05');
    const r = await rpc(db, 'registrar', { token: c.token, funcionario_id: 2, pin: '9999', tipo: 'entrada', foto_hash: 'nao-e-hash' });
    assert.equal(r.erro, 'foto_invalida');
  });

  await t.test('sem câmera a marcação acontece mesmo assim (sem foto_hash)', async () => {
    const r = await rpc(db, 'registrar', { token: c.token, funcionario_id: 2, pin: '9999', tipo: 'entrada' });
    assert.equal(r.ok, true);
    const m = (await db.query('select foto_hash, foto_exigida from ponto.marcacao where id = $1', [r.marcacao_id])).rows[0];
    assert.deepEqual(m, { foto_hash: null, foto_exigida: true });
  });

  await t.test('cadeia íntegra com marcações com e sem foto; trocar o hash da foto é detectado', async () => {
    assert.equal((await db.query('select ponto.verificar_cadeia(1::smallint) v')).rows[0].v, null);
    await db.exec(`alter table ponto.marcacao disable trigger marcacao_imutavel_ud;
                   update ponto.marcacao set foto_hash = '${sha(OUTRA)}' where nsr = 1;
                   alter table ponto.marcacao enable trigger marcacao_imutavel_ud;`);
    assert.equal(Number((await db.query('select ponto.verificar_cadeia(1::smallint) v')).rows[0].v), 1);
  });
});

test('envio da foto pela Edge Function', async (t) => {
  const { db, c, sessao, arquivos, handler } = await pronto();
  const reg = await rpc(db, 'registrar', { token: c.token, funcionario_id: 1, pin: '1234', tipo: 'entrada', foto_hash: sha(FOTO) });
  const id = reg.marcacao_id;
  const resp = async (req) => { const r = await handler(req); return { status: r.status, corpo: r.status === 204 ? null : await r.json(), r }; };

  await t.test('pré-voo CORS responde sem autenticação', async () => {
    const { status, r } = await resp(new Request('https://f.teste/ponto-foto', { method: 'OPTIONS' }));
    assert.equal(status, 204);
    assert.match(r.headers.get('access-control-allow-headers'), /x-ponto-token/);
  });

  await t.test('arquivo diferente do hash registrado é recusado', async () => {
    const { status, corpo } = await resp(envio(OUTRA, { id }));
    assert.deepEqual([status, corpo.erro], [403, 'foto_nao_confere']);
    assert.equal(arquivos.size, 0);
  });

  await t.test('token errado, marcação de outra estação, tipo e tamanho inválidos', async () => {
    assert.equal((await resp(envio(FOTO, { id, token: 'errado' }))).corpo.erro, 'estacao_invalida');
    await db.exec(`insert into ponto.estacao (empresa_id, nome, token_hash) values (1, 'Outra', ponto.sha256_hex('tok-2'))`);
    assert.equal((await resp(envio(FOTO, { id, token: 'tok-2' }))).corpo.erro, 'marcacao_invalida');
    assert.equal((await resp(envio(FOTO, { id, tipo: 'text/html' }))).status, 415);
    assert.equal((await resp(envio(Buffer.alloc(LIMITE_BYTES + 1), { id }))).status, 413);
    assert.equal((await resp(envio(FOTO, { id: 'abc' }))).status, 400);
  });

  await t.test('arquivo certo vai para o compartimento, no caminho empresa/mês/nsr', async () => {
    const { status, corpo } = await resp(envio(FOTO, { id }));
    assert.deepEqual([status, corpo], [200, { ok: true }]);
    assert.deepEqual([...arquivos.keys()], ['1/2026-09/1.webp']);
    assert.equal(sha(arquivos.get('1/2026-09/1.webp').bytes), sha(FOTO));
    const f = (await db.query('select caminho, bytes, tipo from ponto.foto where marcacao_id = $1', [id])).rows[0];
    assert.deepEqual(f, { caminho: '1/2026-09/1.webp', bytes: FOTO.length, tipo: 'image/webp' });
  });

  await t.test('não dá para trocar a foto depois de enviada', async () => {
    assert.equal((await resp(envio(FOTO, { id }))).corpo.erro, 'foto_ja_enviada');
  });

  await t.test('arquivo que subiu mas não foi registrado (queda no meio) é aceito no reenvio', async () => {
    await fixarRelogio(db, '2026-09-14 13:00');
    const r2 = await rpc(db, 'registrar', { token: c.token, funcionario_id: 1, pin: '1234', tipo: 'saida_intervalo', foto_hash: sha(OUTRA) });
    arquivos.set('1/2026-09/2.webp', { bytes: OUTRA, tipo: 'image/webp' });   // subiu, mas o registro não aconteceu
    assert.equal((await resp(envio(OUTRA, { id: r2.marcacao_id }))).corpo.ok, true);
    assert.equal((await db.query('select count(*)::int n from ponto.foto')).rows[0].n, 2);
  });

  await t.test('depois de 7 dias não aceita mais a foto', async () => {
    const r3 = await rpc(db, 'registrar', { token: c.token, funcionario_id: 2, pin: '9999', tipo: 'entrada', foto_hash: sha(FOTO) });
    await fixarRelogio(db, '2026-09-21 13:01');
    assert.equal((await resp(envio(FOTO, { id: r3.marcacao_id }))).corpo.erro, 'prazo_esgotado');
    await fixarRelogio(db, '2026-09-14 13:00');
  });

  await t.test('gestor recebe links temporários só das fotos existentes', async () => {
    const { status, corpo } = await resp(pedidoVer({ acao: 'ver', sessao, ids: [id, 999] }));
    assert.equal(status, 200);
    assert.deepEqual(corpo.urls, { [id]: 'https://storage.teste/assinado/1/2026-09/1.webp' });
  });

  await t.test('sem sessão válida não vê foto nenhuma', async () => {
    const r = await resp(pedidoVer({ acao: 'ver', sessao: 'falsa', ids: [id] }));
    assert.deepEqual([r.status, r.corpo.erro], [401, 'sessao_invalida']);
    assert.equal((await resp(pedidoVer({ acao: 'outra', sessao }))).status, 400);
  });

  await t.test('as funções internas da foto não são alcançáveis pela API pública', async () => {
    for (const fn of ['foto_autorizar', 'foto_registrar', 'foto_caminhos_admin']) {
      assert.equal((await rpc(db, fn, {})).erro, 'funcao_desconhecida', fn);
    }
  });
});

test('painel: situação das fotos, espaço e câmera no quadro de saúde', async (t) => {
  const { db, c, sessao, handler } = await pronto();
  await rpc(db, 'admin_salvar_estacao', { sessao, id: 1, nome: 'Tablet', empresa_ids: [1], tira_foto: true });
  const a = await rpc(db, 'registrar', { token: c.token, funcionario_id: 1, pin: '1234', tipo: 'entrada', foto_hash: sha(FOTO) });
  await handler(envio(FOTO, { id: a.marcacao_id }));
  await fixarRelogio(db, '2026-09-14 13:00');
  await rpc(db, 'registrar', { token: c.token, funcionario_id: 1, pin: '1234', tipo: 'saida_intervalo', foto_hash: sha(OUTRA) });
  await fixarRelogio(db, '2026-09-14 13:15');
  await rpc(db, 'registrar', { token: c.token, funcionario_id: 1, pin: '1234', tipo: 'volta_intervalo' });
  await db.exec('update ponto.estacao set tira_foto = false');
  await fixarRelogio(db, '2026-09-14 16:15');
  await rpc(db, 'registrar', { token: c.token, funcionario_id: 1, pin: '1234', tipo: 'saida' });

  await t.test('cada marcação mostra a situação da foto', async () => {
    const r = await rpc(db, 'admin_marcacoes_fotos', { sessao, funcionario_id: 1, ini: '2026-09-14', fim: '2026-09-14' });
    assert.deepEqual(r.marcacoes.map((m) => [m.tipo, m.foto, m.estacao]), [
      ['entrada', 'foto', 'Tablet'], ['saida_intervalo', 'foto_nao_recebida', 'Tablet'],
      ['volta_intervalo', 'sem_foto', 'Tablet'], ['saida', 'nenhuma', 'Tablet']]);
    assert.equal((await rpc(db, 'admin_marcacoes_fotos', { funcionario_id: 1, ini: '2026-09-14', fim: '2026-09-14' })).erro, 'sessao_invalida');
  });

  await t.test('espaço usado pelas fotos (Storage do projeto só existe no Supabase)', async () => {
    const r = await rpc(db, 'admin_espaco', { sessao });
    assert.deepEqual([r.fotos_bytes, r.fotos_qtd, r.storage_bytes, r.limite_bytes], [FOTO.length, 1, null, 1073741824]);
  });

  await t.test('câmera informada no sinal de vida aparece no quadro; sem informação mantém a anterior', async () => {
    await rpc(db, 'estacao_sinal', { token: c.token, relogio: '2026-09-14T16:15:00-03:00', camera: false });
    const est = async () => (await rpc(db, 'admin_estacoes', { sessao })).estacoes[0];
    assert.equal((await est()).camera_ok, false);
    await rpc(db, 'estacao_sinal', { token: c.token, relogio: '2026-09-14T16:15:00-03:00' });
    assert.equal((await est()).camera_ok, false);
    await rpc(db, 'estacao_sinal', { token: c.token, camera: true });
    assert.equal((await est()).camera_ok, true);
  });

  await t.test('estação com foto é configurada pelo painel', async () => {
    const r = await rpc(db, 'admin_criar_estacao', { sessao, nome: 'Tablet 2', empresa_ids: [1], tira_foto: true, imprime: false });
    const e = await rpc(db, 'estacao', { token: r.token });
    assert.deepEqual([e.estacao.tira_foto, e.estacao.imprime], [true, false]);
  });
});

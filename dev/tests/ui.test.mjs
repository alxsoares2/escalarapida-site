// Testes de interface: carrega as páginas reais em jsdom e liga o fetch ao banco de teste.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { novoBanco, cenario, fixarRelogio, dia, rpc, CHEIO, pessoa, quase } from './helpers.mjs';

const RAIZ = new URL('../../pontoeletronico/', import.meta.url);
const abertas = [];
// Garante que nenhuma página (com seus timers) fique viva se um teste falhar no meio.
after(() => { for (const d of abertas) { try { d.window.close(); } catch (e) { /* já fechada */ } } });

// foto: código que substitui foto.js (câmera simulada; o jsdom não tem câmera).
// rosto: código que substitui rosto.js (reconhecimento simulado); config: campos a mais em PONTO_CONFIG.
async function abrir(db, caminho, { localStorage: ls = {}, sessionStorage: ss = {}, foto = null, rosto = null, config = {} } = {}) {
  const arquivo = new URL(caminho, RAIZ);
  const pasta = new URL('./', arquivo);
  let html = readFileSync(arquivo, 'utf8');
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
    const arq = src.split('?')[0];
    if (arq.endsWith('foto.js') && foto) return `<script>${foto}</script>`;
    if (arq.endsWith('rosto.js') && rosto) return `<script>${rosto}</script>`;
    if (arq.endsWith('config.js')) return `<script>window.PONTO_CONFIG=Object.assign({url:'http://teste',anonKey:'chave-de-teste',imprimirAoMarcar:true,larguraCupomMm:80},${JSON.stringify(config)});</script>`;
    return `<script>${readFileSync(new URL(arq, pasta), 'utf8')}</script>`;
  });
  const erros = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => erros.push(e.message));
  vc.on('error', (e) => erros.push(String(e)));
  const dom = new JSDOM(html, {
    url: 'https://teste.local/pontoeletronico/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      for (const [k, v] of Object.entries(ls)) w.localStorage.setItem(k, v);
      for (const [k, v] of Object.entries(ss)) w.sessionStorage.setItem(k, v);
      w.__fotoReqs = [];
      w.fetch = async (url, init) => {
        if (String(url).includes('/functions/v1/ponto-foto')) {   // Edge Function simulada: links das fotos
          const b = JSON.parse(init.body);
          w.__fotoReqs.push(b);
          const urls = Object.fromEntries((b.ids || []).map((id) => [id, 'https://img.teste/' + id + '.webp']));
          return { ok: true, status: 200, json: async () => ({ ok: true, urls }) };
        }
        const b = JSON.parse(init.body);
        const r = await db.query('select public.ponto_rpc($1, $2::jsonb) as r', [b.p_fn, JSON.stringify(b.p_args)]);
        return { ok: true, json: async () => r.rows[0].r };
      };
      w.__prints = 0;
      w.print = () => { w.__prints++; };   // jsdom não imprime; conta as chamadas
      w.confirm = () => true;
      w.prompt = () => 'motivo de teste';
    }
  });
  abertas.push(dom);
  const w = dom.window, d = w.document;
  const $ = (sel) => d.querySelector(sel);
  const esperar = async (fn, rotulo, ms = 4000) => {
    const ate = Date.now() + ms;
    for (;;) {
      try { const v = fn(); if (v) return v; } catch (e) { /* ainda não */ }
      if (Date.now() > ate) throw new Error('Tempo esgotado esperando: ' + rotulo + '\nHTML:\n' + d.body.innerHTML.slice(0, 1500));
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  const clicar = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const digitar = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  // Só o texto visível: os <script> contêm as mensagens como strings e enganariam as esperas.
  const texto = () => { const c = d.body.cloneNode(true); c.querySelectorAll('script').forEach((x) => x.remove()); return c.textContent.replace(/\s+/g, ' '); };
  return { dom, w, d, $, esperar, clicar, digitar, erros, texto, fechar: () => dom.window.close() };
}

async function tecl(p, pin) { for (const n of pin) p.clicar(p.$(`.keypad [data-k="${n}"]`)); }

test('estação: ativar computador, marcar ponto, comprovante e erros', async (t) => {
  const db = await novoBanco();
  const c = await cenario(db);
  await fixarRelogio(db, '2026-09-14 10:00');

  await t.test('sem ativação pede o código; código errado é recusado', async () => {
    const p = await abrir(db, 'index.html');
    await p.esperar(() => p.$('#tk'), 'campo do código');
    digitar_ok(p, '#tk', 'errado'); p.clicar(p.$('#ativar'));
    await p.esperar(() => p.texto().includes('não está autorizado'), 'mensagem de estação inválida');
    p.fechar();
  });

  await t.test('código certo ativa e lista só os funcionários da empresa', async () => {
    const p = await abrir(db, 'index.html');
    await p.esperar(() => p.$('#tk'), 'campo do código');
    digitar_ok(p, '#tk', c.token); p.clicar(p.$('#ativar'));
    await p.esperar(() => p.d.querySelectorAll('.nome-btn').length === 2, 'lista de nomes');
    assert.deepEqual([...p.d.querySelectorAll('.nome-btn')].map((b) => b.textContent), ['Ana', 'Beto']);
    assert.equal(p.w.localStorage.getItem('ponto_estacao_token'), c.token);
    assert.match(p.$('#relogio').textContent, /^\d\d:\d\d:\d\d$/);
    // funcionário não consegue desvincular o computador: só o gestor, pelo painel
    assert.equal(p.$('#desvincular'), null);
    assert.ok(!/desvincular/i.test(p.texto()));
    p.fechar();
  });

  const ls = { ponto_estacao_token: c.token };

  await t.test('PIN errado mostra erro e não registra', async () => {
    const p = await abrir(db, 'index.html', { localStorage: ls });
    await p.esperar(() => p.d.querySelectorAll('.nome-btn').length, 'nomes');
    p.clicar(p.d.querySelectorAll('.nome-btn')[0]);
    await p.esperar(() => p.$('.keypad'), 'teclado');
    await tecl(p, '0000'); p.clicar(p.$('#ok'));
    await p.esperar(() => p.texto().includes('PIN incorreto'), 'erro de PIN');
    assert.equal((await db.query('select count(*)::int n from ponto.marcacao')).rows[0].n, 0);
    p.fechar();
  });

  await t.test('PIN certo -> registrar ENTRADA -> comprovante com NSR e hash', async () => {
    const p = await abrir(db, 'index.html', { localStorage: ls });
    await p.esperar(() => p.d.querySelectorAll('.nome-btn').length, 'nomes');
    p.clicar(p.d.querySelectorAll('.nome-btn')[0]);
    await p.esperar(() => p.$('.keypad'), 'teclado');
    await tecl(p, '1234'); p.clicar(p.$('#ok'));
    await p.esperar(() => p.$('[data-tipo="entrada"]'), 'botão de entrada');
    assert.match(p.$('[data-tipo="entrada"]').textContent, /Registrar ENTRADA/);
    p.clicar(p.$('[data-tipo="entrada"]'));
    await p.esperar(() => p.$('.comprovante'), 'comprovante');
    const tx = p.texto();
    assert.match(tx, /Comprovante de Registro de Ponto do Trabalhador/);
    assert.match(tx, /Ana/);
    assert.match(p.$('.hash').textContent, /^[0-9a-f]{64}$/);
    assert.equal((await db.query("select tipo::text t from ponto.marcacao")).rows[0].t, 'entrada');
    assert.equal(p.erros.length, 0, p.erros.join('\n'));

    // impressão automática do cupom (impressora térmica), sem o funcionário clicar em nada
    await p.esperar(() => p.w.__prints === 1, 'impressão automática');
    const cupom = p.$('#cupom').textContent.replace(/\s+/g, ' ');
    assert.match(cupom, /COMPROVANTE DE REGISTRO DE PONTO/);
    assert.match(cupom, /Basílico/);
    assert.match(cupom, /CNPJ 00\.000\.000\/0001-00/);
    assert.match(cupom, /Ana/);
    assert.match(cupom, /ENTRADA/);
    assert.match(cupom, /NSR\s*1(?!\d)/);
    assert.ok(cupom.includes(p.$('.hash').textContent), 'o hash impresso é o mesmo do comprovante');
    assert.match(p.d.head.innerHTML, /@page\{size:80mm auto;margin:0\}/);
    // reimprimir
    p.clicar(p.$('#reimprimir'));
    assert.equal(p.w.__prints, 2);
    p.fechar();
  });

  await t.test('depois da entrada oferece intervalo ou saída; lista as 48 h', async () => {
    await fixarRelogio(db, '2026-09-14 13:00');
    const p = await abrir(db, 'index.html', { localStorage: ls });
    await p.esperar(() => p.d.querySelectorAll('.nome-btn').length, 'nomes');
    p.clicar(p.d.querySelectorAll('.nome-btn')[0]);
    await p.esperar(() => p.$('.keypad'), 'teclado');
    await tecl(p, '1234'); p.clicar(p.$('#ok'));
    await p.esperar(() => p.$('[data-tipo="saida_intervalo"]'), 'saída para intervalo');
    assert.ok(p.$('[data-tipo="saida"]'));
    assert.equal(p.$('[data-tipo="entrada"]'), null);
    p.clicar(p.$('#ver-marcacoes'));
    await p.esperar(() => p.$('.ultimas li'), 'lista 48h');
    assert.match(p.$('.ultimas').textContent, /Entrada/);
    p.fechar();
  });

  await t.test('pedido de correção sai da tela e fica pendente no banco', async () => {
    await fixarRelogio(db, '2026-09-14 15:00');
    const p = await abrir(db, 'index.html', { localStorage: ls });
    await p.esperar(() => p.d.querySelectorAll('.nome-btn').length, 'nomes');
    p.clicar(p.d.querySelectorAll('.nome-btn')[1]);          // Beto
    await p.esperar(() => p.$('.keypad'), 'teclado');
    await tecl(p, '9999'); p.clicar(p.$('#ok'));
    await p.esperar(() => p.$('#pedir'), 'botão pedir correção');
    p.clicar(p.$('#pedir'));
    await p.esperar(() => p.$('#c-hora'), 'formulário');
    assert.equal(p.$('.msg'), null, 'o formulário não pode abrir com mensagem de erro');
    p.$('#c-data').value = '2026-09-14'; p.$('#c-hora').value = '10:00'; p.$('#c-motivo').value = 'esqueci';
    p.clicar(p.$('#enviar'));
    await p.esperar(() => p.texto().includes('Pedido enviado'), 'confirmação');
    const r = (await db.query("select origem, status::text s, tipo_marcacao::text t from ponto.ajuste")).rows;
    assert.deepEqual(r, [{ origem: 'funcionario', s: 'pendente', t: 'entrada' }]);
    assert.equal(p.erros.length, 0, p.erros.join('\n'));
    p.fechar();
  });

  await t.test('nomes com HTML não injetam elementos na tela', async () => {
    await db.exec(`insert into ponto.funcionario (empresa_id, nome, pin_hash, inicio_controle)
      values (1, '<img src=x id=xss>', extensions.crypt('1111', extensions.gen_salt('bf', 4)), '2026-09-01')`);
    const p = await abrir(db, 'index.html', { localStorage: ls });
    await p.esperar(() => p.d.querySelectorAll('.nome-btn').length === 3, 'três nomes');
    assert.equal(p.d.getElementById('xss'), null);
    assert.ok(p.texto().includes('<img src=x id=xss>'));
    p.fechar();
  });

  await t.test('estação desativada volta para a tela de ativação', async () => {
    await db.exec('update ponto.estacao set ativa = false');
    const p = await abrir(db, 'index.html', { localStorage: ls });
    await p.esperar(() => p.$('#tk'), 'tela de ativação');
    assert.equal(p.w.localStorage.getItem('ponto_estacao_token'), null);
    p.fechar();
  });
});

function digitar_ok(p, sel, v) { p.$(sel).value = v; }

test('tablet: abas por empresa, sem impressão e sinal de vida', async (t) => {
  const db = await novoBanco();
  const c = await cenario(db);
  await db.exec(`insert into ponto.empresa (nome) values ('Outra');
    insert into ponto.funcionario (empresa_id, nome, pin_hash, inicio_controle)
      values (2, 'Carla', extensions.crypt('4321', extensions.gen_salt('bf', 4)), '2026-09-01');
    insert into ponto.estacao_empresa (estacao_id, empresa_id) values (1, 2);
    update ponto.estacao set nome = 'Tablet', imprime = false;`);
  await fixarRelogio(db, '2026-09-14 10:00');
  const ls = { ponto_estacao_token: c.token };

  await t.test('uma aba por empresa; trocar de aba troca a lista de nomes', async () => {
    const p = await abrir(db, 'index.html', { localStorage: ls });
    await p.esperar(() => p.d.querySelectorAll('.emp-tab').length === 2, 'abas');
    assert.deepEqual([...p.d.querySelectorAll('.emp-tab')].map((b) => b.textContent), ['Basílico', 'Outra']);
    assert.match(p.$('.emp-tab.ativa').textContent, /Basílico/);
    assert.deepEqual([...p.d.querySelectorAll('.nome-btn')].map((b) => b.textContent), ['Ana', 'Beto']);
    p.clicar(p.d.querySelectorAll('.emp-tab')[1]);
    await p.esperar(() => p.$('.emp-tab.ativa').textContent === 'Outra', 'aba Outra');
    assert.deepEqual([...p.d.querySelectorAll('.nome-btn')].map((b) => b.textContent), ['Carla']);
    assert.equal(p.erros.length, 0, p.erros.join('\n'));
    p.fechar();
  });

  await t.test('marca pela segunda empresa, não imprime e volta para a mesma aba', async () => {
    const p = await abrir(db, 'index.html', { localStorage: ls });
    await p.esperar(() => p.d.querySelectorAll('.emp-tab').length === 2, 'abas');
    p.clicar(p.d.querySelectorAll('.emp-tab')[1]);
    await p.esperar(() => p.$('.nome-btn') && p.$('.nome-btn').textContent === 'Carla', 'Carla');
    p.clicar(p.$('.nome-btn'));
    await p.esperar(() => p.$('.keypad'), 'teclado');
    await tecl(p, '4321'); p.clicar(p.$('#ok'));
    await p.esperar(() => p.$('[data-tipo="entrada"]'), 'botão de entrada');
    p.clicar(p.$('[data-tipo="entrada"]'));
    await p.esperar(() => p.$('.comprovante'), 'comprovante');
    assert.match(p.texto(), /Outra/);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(p.w.__prints, 0, 'estação sem impressora não imprime');
    assert.equal(p.$('#reimprimir'), null);
    p.clicar(p.$('#fechar'));
    await p.esperar(() => p.$('.emp-tab.ativa'), 'lista');
    assert.equal(p.$('.emp-tab.ativa').textContent, 'Outra');
    const m = (await db.query('select empresa_id, nsr::int from ponto.marcacao')).rows;
    assert.deepEqual(m, [{ empresa_id: 2, nsr: 1 }]);
    p.fechar();
  });

  await t.test('ao abrir, a tela manda o sinal de vida', async () => {
    await db.exec('update ponto.estacao set ultimo_contato = null');
    const p = await abrir(db, 'index.html', { localStorage: ls });
    await p.esperar(() => p.$('.emp-tab'), 'abas');
    const ok = async () => (await db.query('select ultimo_contato from ponto.estacao')).rows[0].ultimo_contato;
    for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(await ok(), 'último contato gravado');
    p.fechar();
  });

  await t.test('estação de uma empresa só não mostra abas', async () => {
    await db.exec('delete from ponto.estacao_empresa where empresa_id = 2');
    const p = await abrir(db, 'index.html', { localStorage: ls });
    await p.esperar(() => p.d.querySelectorAll('.nome-btn').length === 2, 'nomes');
    assert.equal(p.$('.emp-tabs'), null);
    p.fechar();
  });
});

test('painel do gestor: primeiro acesso, login e todas as abas', async (t) => {
  const db = await novoBanco();
  await cenario(db);
  await db.exec(`update ponto.funcionario set inicio_controle = '2026-09-01'`);
  await fixarRelogio(db, '2026-09-16 09:00');
  await dia(db, 1, '2026-09-14', CHEIO);
  await db.exec(`insert into ponto.config (chave, valor) values ('codigo_instalacao_hash', ponto.sha256_hex('COD-INSTALA'))`);
  await fixarRelogio(db, '2026-09-16 12:00');

  let sessao;
  await t.test('sem admin cria o acesso com o código de instalação', async () => {
    const p = await abrir(db, 'admin/index.html');
    await p.esperar(() => p.$('#pa-cod'), 'tela de primeiro acesso');
    p.$('#pa-cod').value = 'COD-INSTALA'; p.$('#pa-mail').value = 'dono@teste.com';
    p.$('#pa-s1').value = 'senha-bem-longa'; p.$('#pa-s2').value = 'senha-diferente';
    p.clicar(p.$('#pa-ok'));
    await p.esperar(() => p.texto().includes('As senhas não conferem'), 'aviso de senhas');
    p.$('#pa-cod').value = 'COD-INSTALA'; p.$('#pa-mail').value = 'dono@teste.com';
    p.$('#pa-s1').value = 'senha-bem-longa'; p.$('#pa-s2').value = 'senha-bem-longa';
    p.clicar(p.$('#pa-ok'));
    await p.esperar(() => p.$('#l-mail'), 'tela de login');
    assert.match(p.texto(), /Acesso criado/);
    p.fechar();
  });

  await t.test('login errado avisa; certo entra no painel', async () => {
    const p = await abrir(db, 'admin/index.html');
    await p.esperar(() => p.$('#l-mail'), 'login');
    p.$('#l-mail').value = 'dono@teste.com'; p.$('#l-senha').value = 'errada';
    p.clicar(p.$('#l-ok'));
    await p.esperar(() => p.texto().includes('E-mail ou senha incorretos'), 'erro de login');
    p.$('#l-mail').value = 'dono@teste.com'; p.$('#l-senha').value = 'senha-bem-longa';
    p.clicar(p.$('#l-ok'));
    await p.esperar(() => p.$('.tabs'), 'painel');
    sessao = p.w.sessionStorage.getItem('ponto_admin_sessao');
    assert.ok(sessao);
    assert.match(p.texto(), /Basílico/);
    p.fechar();
  });

  await t.test('cada aba renderiza sem erros de JavaScript', async () => {
    const p = await abrir(db, 'admin/index.html', { sessionStorage: { ponto_admin_sessao: sessao } });
    await p.esperar(() => p.$('.tabs'), 'painel');
    for (const aba of ['funcionarios', 'calendario', 'correcoes', 'relatorios', 'config']) {
      p.clicar(p.$(`[data-tab="${aba}"]`));
      await p.esperar(() => p.$(`.tab.active[data-tab="${aba}"]`) && p.$('#aba') && p.$('#aba').innerHTML.length > 80, 'aba ' + aba);
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(p.erros.length, 0, p.erros.join('\n'));
    p.fechar();
  });

  await t.test('funcionários: lista com jornada e banco; novo funcionário com PIN', async () => {
    const p = await abrir(db, 'admin/index.html', { sessionStorage: { ponto_admin_sessao: sessao } });
    await p.esperar(() => p.texto().includes('Ana'), 'lista');
    assert.match(p.texto(), /10:00–16:15/);
    p.clicar(p.$('#novo-f'));
    await p.esperar(() => p.$('#f-nome'), 'formulário');
    p.$('#f-nome').value = 'Duda'; p.$('#f-pin').value = '2468';
    p.clicar(p.$('#f-salvar'));
    await p.esperar(() => p.$('#j-salvar'), 'formulário de jornada do novo');
    const r = await db.query("select nome, pin_hash from ponto.funcionario where nome = 'Duda'");
    assert.equal(r.rows.length, 1);
    assert.match(r.rows[0].pin_hash, /^\$2/);
    p.fechar();
  });

  await t.test('relatório: espelho mensal mostra dia trabalhado, falta e saldo', async () => {
    const p = await abrir(db, 'admin/index.html', { sessionStorage: { ponto_admin_sessao: sessao } });
    await p.esperar(() => p.$('.tabs'), 'painel');
    p.clicar(p.$('[data-tab="relatorios"]'));
    await p.esperar(() => p.$('#r-mes'), 'relatórios');
    p.$('#r-mes').value = '2026-09'; p.$('#r-f').value = '1'; p.$('#r-tipo').value = 'espelho';
    p.clicar(p.$('#r-ok'));
    await p.esperar(() => p.$('#rel table.t') && p.$('#rel').textContent.includes('TOTAIS DO MÊS'), 'espelho');
    const tx = p.$('#rel').textContent;
    assert.match(tx, /14\/09\/2026/);
    assert.match(tx, /FALTA/);
    assert.match(tx, /Banco de horas atual/);
    // estrutura no estilo da planilha: colunas, carga horária por dia e totais
    for (const col of ['H. Diária', 'Atrasos', 'Horas Extras', 'A.N.', 'Banco de horas', 'CARGA HORÁRIA', 'TOTAIS DO MÊS', 'CONTROLE DE CARTÃO PONTO']) {
      assert.ok(tx.includes(col), 'falta no espelho: ' + col);
    }
    const celulas = (tr) => [...tr.children].map((c) => c.textContent.trim());
    const carga = [...p.d.querySelectorAll('.esp-lado table')[0].querySelectorAll('tr')].map((tr) => celulas(tr).join(' '));
    assert.deepEqual(carga.slice(0, 7), ['Seg 06:00', 'Ter 06:00', 'Qua 06:00', 'Qui 06:00', 'Sex 06:00', 'Sáb –', 'Dom 06:00']);
    // 14/09 (dia perfeito): marcações, 06:00 trabalhadas, sem atraso/extra/compensado/noturno, banco 00:00
    const linha14 = [...p.d.querySelectorAll('table.esp tbody tr')].find((tr) => tr.textContent.includes('14/09/2026'));
    assert.deepEqual(celulas(linha14).slice(2, 12), ['10:00', '13:00', '13:15', '16:15', '06:00', '–', '–', '–', '–', '00:00']);
    assert.equal(p.erros.length, 0, p.erros.join('\n'));
    p.fechar();
  });

  await t.test('configuração: gerar estação mostra o código uma vez; a estação funciona', async () => {
    const p = await abrir(db, 'admin/index.html', { sessionStorage: { ponto_admin_sessao: sessao } });
    await p.esperar(() => p.$('.tabs'), 'painel');
    p.clicar(p.$('[data-tab="config"]'));
    await p.esperar(() => p.$('#es-nova'), 'estações');
    p.clicar(p.$('#es-nova'));
    await p.esperar(() => p.$('#es-nome'), 'formulário de estação');
    p.$('#es-nome').value = 'Caixa 2'; p.clicar(p.$('#es-ok'));
    await p.esperar(() => p.$('#tok'), 'código gerado');
    const token = p.$('#tok').textContent;
    assert.equal(token.length, 48);
    // a estação nova aparece no quadro, ainda sem sinal de vida
    assert.match(p.texto(), /Caixa 2.*Basílico.*nunca conectou/);
    p.clicar(p.$('#verif'));
    await p.esperar(() => p.texto().includes('Íntegro'), 'verificação de integridade');
    const est = await db.query('select ponto.estacao_do_token($1) as e', [token]);
    assert.ok(est.rows[0].e);
    p.fechar();
  });

  await t.test('calendário: domingos de folga e exceção pela tela', async () => {
    const p = await abrir(db, 'admin/index.html', { sessionStorage: { ponto_admin_sessao: sessao } });
    await p.esperar(() => p.$('.tabs'), 'painel');
    p.clicar(p.$('[data-tab="calendario"]'));
    await p.esperar(() => p.$('.dom-c'), 'domingos');
    const dom = p.d.querySelectorAll('.dom-c'); dom[1].checked = true;
    p.clicar(p.$('#dom-salvar'));
    await p.esperar(() => p.texto().includes('Domingos salvos') || p.d.querySelector('.dom-c:checked'), 'domingos salvos');
    await new Promise((r) => setTimeout(r, 150));
    const ex = (await db.query("select tipo::text t, data_ini::text d from ponto.excecao where cancelada_em is null")).rows;
    assert.equal(ex.length, 1);
    assert.equal(ex[0].t, 'folga_domingo');
    p.fechar();
  });

  await t.test('sessão expirada volta para o login', async () => {
    await fixarRelogio(db, '2026-09-17 09:00');   // > 12 h depois
    const p = await abrir(db, 'admin/index.html', { sessionStorage: { ponto_admin_sessao: sessao } });
    await p.esperar(() => p.$('#l-mail'), 'tela de login');
    assert.equal(p.w.sessionStorage.getItem('ponto_admin_sessao'), null);
    p.fechar();
  });
});

// Câmera simulada (o jsdom não tem câmera): "ligar" mostra a imagem ao vivo, "capturarAgora" devolve um arquivo fixo.
const CAMERA_OK = `window.PontoFoto = { cameraOk: null, enviados: [], ligada: false, capturas: 0, video: () => ({ videoWidth: 640 }),
  ligar: async (el) => { el.innerHTML = '<video></video>'; el.hidden = false; window.PontoFoto.ligada = true; window.PontoFoto.cameraOk = true; return true; },
  desligar: () => { window.PontoFoto.ligada = false; },
  capturarAgora: async () => { window.PontoFoto.capturas++; return { type: 'image/webp', fake: true }; },
  hash: async () => '${'a'.repeat(64)}',
  enviar: async (blob, d) => { window.PontoFoto.enviados.push(d); return true; } };`;
const CAMERA_QUEBRADA = `window.PontoFoto = { cameraOk: null, enviados: [], ligada: false, capturas: 0, video: () => null,
  ligar: async (el) => { el.hidden = true; window.PontoFoto.cameraOk = false; return false; },
  desligar: () => {},
  capturarAgora: async () => { window.PontoFoto.capturas++; return null; },
  hash: async () => { throw new Error('não deveria calcular'); },
  enviar: async (b, d) => { window.PontoFoto.enviados.push(d); return true; } };`;

test('tablet com foto de prova', async (t) => {
  const db = await novoBanco();
  const c = await cenario(db);
  await db.exec(`update ponto.estacao set nome = 'Tablet', imprime = false, tira_foto = true`);
  await fixarRelogio(db, '2026-09-14 10:00');
  const ls = { ponto_estacao_token: c.token };

  async function marcar(p, idx, pin, tipo) {
    await p.esperar(() => p.d.querySelectorAll('.nome-btn').length, 'nomes');
    p.clicar(p.d.querySelectorAll('.nome-btn')[idx]);
    await p.esperar(() => p.$('.keypad'), 'teclado');
    await tecl(p, pin); p.clicar(p.$('#ok'));
    await p.esperar(() => p.$(`[data-tipo="${tipo}"]`), 'botão ' + tipo);
    p.clicar(p.$(`[data-tipo="${tipo}"]`));
    await p.esperar(() => p.$('.comprovante'), 'comprovante');
  }

  await t.test('câmera fica ligada na tela desde a abertura, antes de qualquer toque', async () => {
    const p = await abrir(db, 'index.html', { localStorage: ls, foto: CAMERA_OK });
    await p.esperar(() => p.d.querySelectorAll('.nome-btn').length, 'nomes');
    await p.esperar(() => p.w.PontoFoto.ligada, 'câmera ligada');
    assert.equal(p.$('#cam-vivo').hidden, false);
    assert.ok(p.$('#cam-vivo video'));
    assert.equal(p.w.PontoFoto.capturas, 0);
    p.fechar();
  });

  await t.test('tira a foto no toque, grava o hash na marcação e envia o arquivo com o id da marcação', async () => {
    const p = await abrir(db, 'index.html', { localStorage: ls, foto: CAMERA_OK });
    await marcar(p, 0, '1234', 'entrada');
    assert.equal(p.w.PontoFoto.capturas, 1);
    const m = (await db.query('select id::int, foto_hash, foto_exigida from ponto.marcacao')).rows[0];
    assert.deepEqual([m.foto_hash, m.foto_exigida], ['a'.repeat(64), true]);
    await p.esperar(() => p.w.PontoFoto.enviados.length === 1, 'envio da foto');
    assert.deepEqual(JSON.parse(JSON.stringify(p.w.PontoFoto.enviados[0])), { token: c.token, marcacaoId: m.id });
    assert.equal(p.erros.length, 0, p.erros.join('\n'));
    p.fechar();
  });

  await t.test('câmera quebrada: marca sem foto, não envia nada e avisa o quadro de saúde', async () => {
    await fixarRelogio(db, '2026-09-14 10:05');
    const p = await abrir(db, 'index.html', { localStorage: ls, foto: CAMERA_QUEBRADA });
    await marcar(p, 1, '9999', 'entrada');
    const m = (await db.query(`select foto_hash, foto_exigida from ponto.marcacao where funcionario_id = 2`)).rows[0];
    assert.deepEqual(m, { foto_hash: null, foto_exigida: true });
    assert.equal(p.w.PontoFoto.enviados.length, 0);
    const cam = async () => (await db.query('select camera_ok from ponto.estacao')).rows[0].camera_ok;
    for (let i = 0; i < 100 && (await cam()) !== false; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(await cam(), false);
    p.fechar();
  });

  await t.test('estação sem foto não abre a câmera', async () => {
    await db.exec('update ponto.estacao set tira_foto = false');
    await fixarRelogio(db, '2026-09-14 13:00');
    const p = await abrir(db, 'index.html', { localStorage: ls, foto: CAMERA_OK });
    await marcar(p, 0, '1234', 'saida_intervalo');
    assert.equal(p.w.PontoFoto.ligada, false, 'câmera não foi ligada');
    assert.equal(p.w.PontoFoto.capturas, 0);
    assert.equal(p.$('#cam-vivo').hidden, true);
    const m = (await db.query(`select foto_hash, foto_exigida from ponto.marcacao where tipo = 'saida_intervalo'`)).rows[0];
    assert.deepEqual(m, { foto_hash: null, foto_exigida: false });
    p.fechar();
  });
});

test('painel: relatório de marcações e fotos, espaço e câmera', async (t) => {
  const db = await novoBanco();
  const c = await cenario(db);
  await db.exec(`update ponto.estacao set nome = 'Tablet', tira_foto = true, camera_ok = false, ultimo_contato = '2026-09-14 10:00-03';
    insert into ponto.admin (email, senha_hash) values ('dono@teste.com', extensions.crypt('senha-teste', extensions.gen_salt('bf', 4)));`);
  await fixarRelogio(db, '2026-09-14 10:00');
  const r1 = await rpc(db, 'registrar', { token: c.token, funcionario_id: 1, pin: '1234', tipo: 'entrada', foto_hash: 'b'.repeat(64) });
  await db.query(`select ponto.foto_registrar($1, '1/2026-09/1.webp', 9000, 'image/webp')`, [r1.marcacao_id]);
  await fixarRelogio(db, '2026-09-14 13:00');
  await rpc(db, 'registrar', { token: c.token, funcionario_id: 1, pin: '1234', tipo: 'saida_intervalo' });
  const sessao = (await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' })).sessao;
  const ss = { ponto_admin_sessao: sessao };

  await t.test('relatório mostra a miniatura e a marcação sem foto', async () => {
    const p = await abrir(db, 'admin/index.html', { sessionStorage: ss });
    await p.esperar(() => p.$('.tabs'), 'painel');
    p.clicar(p.$('[data-tab="relatorios"]'));
    await p.esperar(() => p.$('#r-tipo'), 'relatórios');
    p.$('#r-tipo').value = 'marcacoes'; p.$('#r-mes').value = '2026-09'; p.$('#r-f').value = '1';
    p.clicar(p.$('#r-ok'));
    await p.esperar(() => p.$('#rel img.foto-mini'), 'miniatura');
    assert.equal(p.$('#rel img.foto-mini').getAttribute('src'), `https://img.teste/${r1.marcacao_id}.webp`);
    assert.match(p.$('#rel').textContent, /sem foto \(câmera falhou\)/);
    assert.deepEqual(JSON.parse(JSON.stringify(p.w.__fotoReqs.map((b) => [b.acao, b.sessao, b.ids]))), [["ver", sessao, [r1.marcacao_id]]]);
    assert.equal(p.erros.length, 0, p.erros.join('\n'));
    p.fechar();
  });

  await t.test('configuração mostra espaço das fotos e câmera com falha', async () => {
    const p = await abrir(db, 'admin/index.html', { sessionStorage: ss });
    await p.esperar(() => p.$('.tabs'), 'painel');
    p.clicar(p.$('[data-tab="config"]'));
    await p.esperar(() => p.texto().includes('Fotos do ponto'), 'espaço');
    assert.match(p.texto(), /Fotos do ponto: 0 MB \(1 fotos\)/);
    assert.match(p.texto(), /câmera com falha/);
    assert.match(p.texto(), /Principal · imprime · foto/);
    p.clicar(p.$('[data-edes]'));
    await p.esperar(() => p.$('#es-foto'), 'formulário');
    assert.equal(p.$('#es-foto').checked, true);
    p.fechar();
  });
});

// Reconhecimento simulado: analisar() devolve window.__rosto (o teste troca quando quiser);
// window.__poses (lista) é consumida antes, uma análise por item.
const RECONHECIMENTO = `window.__rosto = { rostos: 0 }; window.__poses = [];
  window.PontoRosto = { pronto: () => !!window.__pronto, iniciar: async () => { if (window.__falhaCarregar) throw new Error('sem webgl'); window.__pronto = true; return true; },
    analisar: async () => window.__poses.length ? window.__poses.shift() : window.__rosto };`;
const ANA = pessoa(1);
const olhando = (descritor, extra = {}) => ({ rostos: 1, rosto: { descritor, antispoof: 0.9, liveness: 0.9, yaw: 0, pitch: 0, largura: 0.3, ...extra } });
const RAPIDO = { totemContagemSeg: 1, totemIntervaloMs: 20, totemFalhaMs: 200 };

test('totem: reconhecimento facial', async (t) => {
  const db = await novoBanco();
  const c = await cenario(db);
  await db.exec(`update ponto.estacao set nome = 'Tablet', imprime = false, tira_foto = true, reconhece_rosto = true`);
  await db.query(`insert into ponto.rosto (funcionario_id, posicao, descritor, criado_em) values (1, 'frente', $1::real[], now())`, [ANA]);
  await fixarRelogio(db, '2026-09-14 10:00');
  const ls = { ponto_estacao_token: c.token };
  const abrirTotem = () => abrir(db, 'index.html', { localStorage: ls, foto: CAMERA_OK, rosto: RECONHECIMENTO, config: RAPIDO });
  const marcacoes = async () => (await db.query(`select tipo::text t, origem_identificacao o, sem_rosto s, foto_hash is not null f from ponto.marcacao order by id`)).rows;

  await t.test('a tela inicial é a câmera, com relógio e "Aproxime o rosto"', async () => {
    const p = await abrirTotem();
    await p.esperar(() => p.texto().includes('Aproxime o rosto'), 'espera');
    assert.equal(p.$('#totem').hidden, false);
    assert.equal(p.$('#bloco-relogio').hidden, true);
    assert.match(p.$('#totem-hora').textContent, /^\d\d:\d\d$/);
    assert.ok(p.$('#totem-cam video'), 'câmera ligada dentro do totem');
    assert.equal(p.$('.nome-btn'), null, 'sem lista de nomes');
    assert.equal(p.erros.length, 0, p.erros.join('\n'));
    p.fechar();
  });

  await t.test('olhou para a câmera: nome, tipo sugerido e grava sozinho depois da contagem', async () => {
    const p = await abrirTotem();
    await p.esperar(() => p.texto().includes('Aproxime o rosto'), 'espera');
    p.w.__rosto = olhando(quase(ANA));
    await p.esperar(() => p.$('.totem-card') && p.texto().includes('ENTRADA'), 'contagem');
    assert.match(p.$('.totem-card').textContent, /Ana/);
    assert.match(p.$('.totem-card').textContent, /Basílico/);
    assert.equal(p.$('#t-trocar'), null, 'só uma opção: sem "Trocar"');
    await p.esperar(() => p.texto().includes('Entrada registrada às'), 'gravou sozinho', 5000);
    assert.deepEqual(await marcacoes(), [{ t: 'entrada', o: 'rosto', s: false, f: true }]);
    await p.esperar(() => p.w.PontoFoto.enviados.length === 1, 'foto enviada');
    assert.equal(p.erros.length, 0, p.erros.join('\n'));
    p.fechar();
  });

  await t.test('"Trocar": escolhe outra marcação válida', async () => {
    await fixarRelogio(db, '2026-09-14 13:00');
    const p = await abrirTotem();
    await p.esperar(() => p.texto().includes('Aproxime o rosto'), 'espera');
    p.w.__rosto = olhando(ANA);
    await p.esperar(() => p.$('#t-trocar'), 'botão Trocar');
    assert.match(p.$('.totem-tipo').textContent, /SAÍDA PARA INTERVALO/);
    p.clicar(p.$('#t-trocar'));
    await p.esperar(() => p.$('[data-t-tipo="saida"]'), 'opções');
    p.clicar(p.$('[data-t-tipo="saida"]'));
    await p.esperar(() => p.texto().includes('Saída registrada às'), 'gravou a escolhida');
    assert.equal((await marcacoes()).at(-1).t, 'saida');
    p.fechar();
  });

  await t.test('"Não sou eu": não grava nada', async () => {
    await fixarRelogio(db, '2026-09-15 10:00');
    const antes = (await marcacoes()).length;
    const p = await abrirTotem();
    await p.esperar(() => p.texto().includes('Aproxime o rosto'), 'espera');
    p.w.__rosto = olhando(ANA);
    await p.esperar(() => p.$('#t-nao'), 'contagem');
    p.w.__rosto = { rostos: 0 };
    p.clicar(p.$('#t-nao'));
    await p.esperar(() => p.texto().includes('Tudo bem'), 'cancelado');
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal((await marcacoes()).length, antes);
    const ult = (await db.query(`select resultado from ponto.reconhecimento order by id desc limit 1`)).rows[0].resultado;
    assert.equal(ult, 'cancelado');
    p.fechar();
  });

  await t.test('rosto desconhecido: avisa e sugere o PIN; dois rostos: um por vez', async () => {
    const p = await abrirTotem();
    await p.esperar(() => p.texto().includes('Aproxime o rosto'), 'espera');
    p.w.__rosto = { rostos: 2 };
    await p.esperar(() => p.texto().includes('Uma pessoa por vez'), 'dois rostos');
    p.w.__rosto = olhando(pessoa(77));
    await p.esperar(() => p.texto().includes('Não reconhecemos'), 'não reconhecido', 5000);
    p.fechar();
  });

  await t.test('"Marcar com PIN": lista de nomes, marca com alerta sem_rosto e volta para a câmera', async () => {
    await fixarRelogio(db, '2026-09-15 10:05');
    const p = await abrirTotem();
    await p.esperar(() => p.texto().includes('Aproxime o rosto'), 'espera');
    p.clicar(p.$('#totem-pin'));
    await p.esperar(() => p.d.querySelectorAll('.nome-btn').length === 2, 'lista de nomes');
    assert.equal(p.$('#totem').hidden, true);
    assert.ok(p.$('#voltar-totem'));
    p.clicar(p.d.querySelectorAll('.nome-btn')[0]);
    await p.esperar(() => p.$('.keypad'), 'teclado');
    await tecl(p, '1234'); p.clicar(p.$('#ok'));
    await p.esperar(() => p.$('[data-tipo="entrada"]'), 'botão de entrada');
    p.clicar(p.$('[data-tipo="entrada"]'));
    await p.esperar(() => p.$('.comprovante'), 'comprovante');
    assert.deepEqual((await marcacoes()).at(-1), { t: 'entrada', o: 'pin', s: true, f: true });
    p.clicar(p.$('#fechar'));
    await p.esperar(() => !p.$('#totem').hidden && p.texto().includes('Aproxime o rosto'), 'de volta ao totem');
    p.fechar();
  });

  await t.test('sem WebGL/rede para o reconhecimento: avisa e o PIN continua funcionando', async () => {
    const p = await abrir(db, 'index.html', { localStorage: ls, foto: CAMERA_OK, rosto: RECONHECIMENTO + 'window.__falhaCarregar = true;', config: RAPIDO });
    await p.esperar(() => p.texto().includes('Reconhecimento indisponível'), 'aviso');
    p.clicar(p.$('#totem-pin'));
    await p.esperar(() => p.d.querySelectorAll('.nome-btn').length, 'lista de nomes');
    p.fechar();
  });
});

test('painel: cadastro do rosto em 5 posições', async (t) => {
  const db = await novoBanco();
  await cenario(db);
  await db.exec(`update ponto.estacao set reconhece_rosto = true, tira_foto = true;
    insert into ponto.admin (email, senha_hash) values ('dono@teste.com', extensions.crypt('senha-teste', extensions.gen_salt('bf', 4)));`);
  await fixarRelogio(db, '2026-09-14 10:00');
  const sessao = (await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' })).sessao;
  const ss = { ponto_admin_sessao: sessao };
  const pose = (yaw, pitch) => olhando(ANA, { yaw, pitch });
  // cada posição precisa de 2 análises seguidas
  const POSES = [pose(0, 0), pose(0, 0), pose(0.3, 0), pose(0.3, 0), pose(0.3, 0), pose(-0.3, 0), pose(-0.3, 0),
                 pose(0, 0.3), pose(0, 0.3), pose(0, 0.3), pose(0, -0.3), pose(0, -0.3)];

  await t.test('funcionário sem cadastro -> cadastra no tablet -> 5 amostras no banco', async () => {
    const p = await abrir(db, 'admin/index.html', { sessionStorage: ss, foto: CAMERA_OK, rosto: RECONHECIMENTO, config: RAPIDO });
    await p.esperar(() => p.texto().includes('sem cadastro'), 'lista com a coluna Rosto');
    p.clicar(p.$('[data-ed="1"]'));
    await p.esperar(() => p.$('#r-cadastrar'), 'botão cadastrar');
    p.w.__poses = POSES.slice();
    p.w.__rosto = { rostos: 0 };
    p.clicar(p.$('#r-cadastrar'));
    await p.esperar(() => p.texto().includes('Rosto de Ana cadastrado'), 'cadastro salvo', 6000);
    const r = (await db.query(`select posicao from ponto.rosto where funcionario_id = 1 order by id`)).rows.map((x) => x.posicao);
    assert.deepEqual(r, ['frente', 'lado_a', 'lado_b', 'vertical_a', 'vertical_b']);
    assert.equal(p.erros.length, 0, p.erros.join('\n'));
    p.fechar();
  });

  await t.test('segundo "lado" para o mesmo lado não conta', async () => {
    const p = await abrir(db, 'admin/index.html', { sessionStorage: ss, foto: CAMERA_OK, rosto: RECONHECIMENTO, config: RAPIDO });
    await p.esperar(() => p.$('[data-ed="1"]'), 'lista');
    p.clicar(p.$('[data-ed="1"]'));
    await p.esperar(() => p.$('#r-cadastrar'), 'botão refazer');
    assert.match(p.$('#r-cadastrar').textContent, /Refazer/);
    p.w.__poses = [pose(0, 0), pose(0, 0), pose(0.3, 0), pose(0.3, 0)];
    p.w.__rosto = pose(0.3, 0);   // fica virado para o mesmo lado
    p.clicar(p.$('#r-cadastrar'));
    await p.esperar(() => p.texto().includes('Agora um pouco para o outro lado'), 'pede o outro lado');
    await new Promise((r) => setTimeout(r, 300));
    assert.match(p.texto(), /Agora um pouco para o outro lado/);
    p.clicar(p.$('#cad-x'));
    p.fechar();
  });

  await t.test('estação: "Reconhece rosto" liga a foto junto', async () => {
    const p = await abrir(db, 'admin/index.html', { sessionStorage: ss, foto: CAMERA_OK, rosto: RECONHECIMENTO });
    await p.esperar(() => p.$('.tabs'), 'painel');
    p.clicar(p.$('[data-tab="config"]'));
    await p.esperar(() => p.$('[data-edes]'), 'estações');
    assert.match(p.texto(), /Principal · imprime · rosto/);
    assert.match(p.texto(), /Reconhecimento facial: últimas tentativas/);
    p.clicar(p.$('[data-edes]'));
    await p.esperar(() => p.$('#es-rosto'), 'formulário');
    assert.equal(p.$('#es-rosto').checked, true);
    assert.equal(p.$('#es-foto').checked, true);
    assert.equal(p.$('#es-foto').disabled, true);
    p.fechar();
  });
});

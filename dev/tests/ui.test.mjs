// Testes de interface: carrega as páginas reais em jsdom e liga o fetch ao banco de teste.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { novoBanco, cenario, fixarRelogio, dia, CHEIO } from './helpers.mjs';

const RAIZ = new URL('../../pontoeletronico/', import.meta.url);
const abertas = [];
// Garante que nenhuma página (com seus timers) fique viva se um teste falhar no meio.
after(() => { for (const d of abertas) { try { d.window.close(); } catch (e) { /* já fechada */ } } });

async function abrir(db, caminho, { localStorage: ls = {}, sessionStorage: ss = {} } = {}) {
  const arquivo = new URL(caminho, RAIZ);
  const pasta = new URL('./', arquivo);
  let html = readFileSync(arquivo, 'utf8');
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
    const arq = src.split('?')[0];
    if (arq.endsWith('config.js')) return `<script>window.PONTO_CONFIG={url:'http://teste',anonKey:'chave-de-teste',imprimirAoMarcar:true,larguraCupomMm:80};</script>`;
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
      w.fetch = async (_url, init) => {
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

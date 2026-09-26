// foto.js de verdade (câmera sempre ligada) com câmera e permissões simuladas no jsdom.
// Defeito de 26/09/2026: com o aviso "Permitir câmera?" aberto, a página desistia em 5 s e pedia
// de novo a cada 10 s; o aviso sumia e voltava e não dava para clicar em Permitir.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const FOTO_JS = readFileSync(new URL('../../pontoeletronico/foto.js', import.meta.url), 'utf8');
const abertas = [];
after(() => { for (const d of abertas) { try { d.window.close(); } catch (e) { /* já fechada */ } } });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function novoStream() {
  const trilha = { readyState: 'live', stop() { this.readyState = 'ended'; }, addEventListener() {} };
  return { getTracks: () => [trilha], getVideoTracks: () => [trilha] };
}
function erro(nome) { const e = new Error(nome); e.name = nome; return e; }

// perm: estado inicial da permissão; gum: o que getUserMedia faz a cada chamada
function pagina({ perm, gum }) {
  const dom = new JSDOM('<div id="c" hidden></div>', { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://t.local/' });
  abertas.push(dom);
  const w = dom.window;
  const status = { state: perm, onchange: null };
  const chamadas = { gum: 0 };
  Object.defineProperty(w.navigator, 'permissions', { value: { query: async () => status } });
  Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia: () => { chamadas.gum++; return gum(chamadas.gum); } } });
  // o jsdom não decodifica vídeo: com stream ligado, finge 640x480
  Object.defineProperty(w.HTMLVideoElement.prototype, 'videoWidth', { get() { return this.srcObject ? 640 : 0; } });
  Object.defineProperty(w.HTMLVideoElement.prototype, 'videoHeight', { get() { return this.srcObject ? 480 : 0; } });
  w.HTMLMediaElement.prototype.play = async () => {};
  w.eval(FOTO_JS);
  const el = w.document.getElementById('c');
  return { w, el, status, chamadas, F: w.PontoFoto, texto: () => el.textContent };
}

test('aviso de permissão aberto: um pedido só, sem prazo, e a marcação não trava', async () => {
  const p = pagina({ perm: 'prompt', gum: () => new Promise(() => {}) });   // a pessoa ainda não respondeu
  p.F.ligar(p.el); p.F.ligar(p.el); p.F.ligar();
  await esperar(50);
  assert.equal(p.chamadas.gum, 1, 'não pode abrir um segundo pedido enquanto o aviso está aberto');
  assert.equal(p.el.hidden, false);
  assert.match(p.texto(), /Permitir/);
  const ini = Date.now();
  assert.equal(await p.F.capturarAgora(), null);
  assert.ok(Date.now() - ini < 500, 'capturarAgora não espera o aviso de permissão');
  assert.equal(p.chamadas.gum, 1);
});

test('aviso respondido com Permitir: a imagem aparece', async () => {
  let libera;
  const p = pagina({ perm: 'prompt', gum: () => new Promise((r) => { libera = () => r(novoStream()); }) });
  const pronto = p.F.ligar(p.el);
  await esperar(20);
  libera();
  assert.equal(await pronto, true);
  assert.ok(p.el.querySelector('video'));
  assert.equal(p.F.cameraOk, true);
});

test('câmera bloqueada: explica, não insiste sozinha e volta quando liberarem no cadeado', async () => {
  const p = pagina({ perm: 'denied', gum: () => Promise.resolve(novoStream()) });
  assert.equal(await p.F.ligar(p.el), false);
  assert.equal(p.chamadas.gum, 0);
  assert.match(p.texto(), /bloqueada/);
  assert.ok(p.el.querySelector('button'), 'botão "Ativar câmera"');
  p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));
  await esperar(20);
  assert.equal(p.chamadas.gum, 0, 'voltar para a tela não pede de novo');
  assert.equal(p.F.cameraOk, false);
  // liberou no cadeado da barra de endereço
  p.status.state = 'granted';
  p.status.onchange();
  await esperar(50);
  assert.equal(p.chamadas.gum, 1);
  assert.ok(p.el.querySelector('video'));
  assert.equal(p.F.cameraOk, true);
});

test('aviso fechado sem permitir: não pede de novo sozinho; o botão tenta outra vez', async () => {
  const p = pagina({ perm: 'prompt', gum: (n) => n === 1 ? Promise.reject(erro('NotAllowedError')) : Promise.resolve(novoStream()) });
  assert.equal(await p.F.ligar(p.el), false);
  assert.match(p.texto(), /não foi liberada/);
  assert.equal(await p.F.capturarAgora(), null);
  assert.equal(p.chamadas.gum, 1, 'marcar ponto não reabre o aviso');
  p.el.querySelector('button').click();
  await esperar(50);
  assert.equal(p.chamadas.gum, 2);
  assert.ok(p.el.querySelector('video'));
});

test('sem câmera no aparelho: avisa em vez de ficar tentando', async () => {
  const p = pagina({ perm: 'granted', gum: () => Promise.reject(erro('NotFoundError')) });
  assert.equal(await p.F.ligar(p.el), false);
  assert.match(p.texto(), /Nenhuma câmera/);
  assert.equal(p.F.cameraOk, false);
});

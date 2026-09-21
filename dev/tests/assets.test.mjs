// A Hostinger manda CSS/JS com cache de 7 dias (Cache-Control: max-age=604800).
// Sem versão na URL, quem já abriu a página fica com o CSS/JS antigo casado com o HTML novo
// (foi o que fez o cupom aparecer na tela do balcão em 21/09/2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const paginas = ['index.html', 'admin/index.html'];
const RAIZ = new URL('../../pontoeletronico/', import.meta.url);

function locais(html) {
  const out = [];
  for (const m of html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="([^"]+)"/g)) {
    if (!/^(https?:)?\/\//.test(m[1])) out.push(m[1]);
  }
  return out;
}

test('todo CSS/JS local das páginas tem ?v= e a mesma versão nas duas páginas', () => {
  const versoes = new Set();
  for (const p of paginas) {
    const lista = locais(readFileSync(new URL(p, RAIZ), 'utf8'));
    assert.ok(lista.length >= 3, p + ': deveria carregar css/js locais');
    for (const url of lista) {
      const v = url.match(/\?v=([\w.-]+)$/);
      assert.ok(v, `${p}: "${url}" sem ?v=  (troque a versão em todos os arquivos ao mudar CSS/JS)`);
      versoes.add(v[1]);
    }
  }
  assert.equal(versoes.size, 1, 'versões diferentes entre arquivos: ' + [...versoes].join(', '));
});

test('o cupom nasce escondido no próprio HTML (não depende do CSS em cache)', () => {
  const html = readFileSync(new URL('index.html', RAIZ), 'utf8');
  assert.match(html, /<div id="cupom"[^>]*style="display:none"/);
});

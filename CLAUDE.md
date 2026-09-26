# EscalaRápida — instruções do projeto

Gerador de escala de trabalho (CLT), site de página única em https://www.escalarapida.com.br. Detalhes completos no `README.md`.

## Regras de trabalho

- **Tudo é um arquivo só:** `index.html` (CSS em `<style>`, JS em `<script>` no fim). Sem build, sem framework, sem backend. Manter assim a menos que o dono peça outra estrutura.
- **Deploy automático:** `git push` na `master` publica sozinho na Hostinger (repo `alxsoares2/escalarapida-site`, Git do hPanel → `public_html`). Publica o repositório inteiro, então arquivos que não devem ser públicos precisam ser bloqueados no `.htaccess` (hoje bloqueia `*.md`).
- **Commit/push só quando o dono pedir:** push = publicar em produção.
- Nunca afirmar que algo "está no ar" sem conferir com `curl -s https://www.escalarapida.com.br | tr -d '\r' | diff - index.html`.
- **Não quebrar o formato do `.json` de configuração** (`salvarConfig`/`carregarConfig`): usuários têm arquivos salvos. Campos novos devem ser opcionais.
- **Mexeu em regra trabalhista (jornada, intervalo, folga, domingo)?** Registrar a decisão no README, seção "Regras de cálculo", e não prometer conformidade legal além do que o código faz.
- **Ao concluir uma mudança**, atualizar a tabela "Histórico" e as "Pendências" do README.
- Idioma da interface e dos textos: português do Brasil.

## Ponto eletrônico (`/pontoeletronico`)

Sistema separado do gerador de escala. Especificação em `docs/ponto/ESPECIFICACAO.md`; visão geral e operação no README. Regras de trabalho:

- **Mudou regra de apuração?** Muda a especificação primeiro, depois a migration **nova** (nunca editar migration já aplicada), depois o teste. `cd dev && npm test` precisa ficar verde (180 testes).
- **Migrations:** `node --env-file=../../marcus-assistente/.env db/migrate.mjs` (no `dev/`). O banco é o **compartilhado** com Saas Financeiro e Marcus: só mexer no schema `ponto` e em `public.ponto_rpc`. Nunca imprimir `DATABASE_URL` nem chaves.
- **Segurança da API:** o frontend só chama `public.ponto_rpc`. Função nova de API = `ponto.api_<nome>(jsonb)` que se autentica sozinha (token de estação + PIN, ou sessão de admin). Tabelas novas: ligar RLS e revogar de `anon`/`authenticated`. `service_role` nunca no frontend.
- **Marcação é imutável:** nada de UPDATE/DELETE em `marcacao`. Correção = `ajuste` (acrescenta/desconsidera) com motivo. O relógio vem só de `ponto.agora()`.
- **Frontend:** todo texto do usuário em `innerHTML` passa por `Ponto.esc()`. Testes de tela em `dev/tests/ui.test.mjs`: o helper `texto()` ignora `<script>` de propósito (as mensagens existem como strings ali e enganariam as esperas).
- **Cache de 7 dias:** a Hostinger serve CSS/JS com `Cache-Control: max-age=604800`. **Sempre que mudar `ponto.css`, `api.js`, `config.js` ou `admin.js`, troque o `?v=` em TODOS os `<link>`/`<script>` de `pontoeletronico/index.html` e `pontoeletronico/admin/index.html`** (mesma versão nos dois). O teste `dev/tests/assets.test.mjs` falha se faltar ou divergir. Sem isso o navegador de quem já abriu a página mistura CSS antigo com HTML novo (aconteceu em 21/09/2026: o cupom apareceu na tela do balcão).
- **Não afirmar conformidade com a Portaria 671** em nenhum texto público enquanto não houver INPI + ATTR + ICP-Brasil.
- **Não publicar** (`git push`) sem o dono pedir. Antes, a chave `anon` precisa estar em `pontoeletronico/config.js`.

## Mapa rápido do código (gerador de escala)

Estado global: `emps`, `picos`, `horFunc[7]`, `distFolga`, `viewMode`. Entrada principal: `gerar()` → `gerarSemana()` → `renderTabelaSemana()`. Regras de folga em `calcFolgasEmp()`, domingos em `calcDomingosMes()`, intervalo em `calcIntervaloMin()`, saída em `calcSaida()`.

## Pontos de atenção

Ver "Pontos de atenção" no README. Regra: todo texto do usuário que vá para `innerHTML` passa por `esc()`; o 12x36 usa `folga12x36()` (data corrente), nunca a posição na semana.

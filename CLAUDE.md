# EscalaRápida — instruções do projeto

Gerador de escala de trabalho (CLT), site de página única em https://www.escalarapida.com.br. Detalhes completos no `README.md`.

## Regras de trabalho

- **Tudo é um arquivo só:** `index.html` (CSS em `<style>`, JS em `<script>` no fim). Sem build, sem framework, sem backend. Manter assim a menos que o dono peça outra estrutura.
- **Deploy manual** na Hostinger (upload do `index.html` para `public_html`). Nunca afirmar que algo "está no ar" sem conferir com `curl -s https://www.escalarapida.com.br | tr -d '\r' | diff - index.html`.
- **Não quebrar o formato do `.json` de configuração** (`salvarConfig`/`carregarConfig`): usuários têm arquivos salvos. Campos novos devem ser opcionais.
- **Mexeu em regra trabalhista (jornada, intervalo, folga, domingo)?** Registrar a decisão no README, seção "Regras de cálculo", e não prometer conformidade legal além do que o código faz.
- **Ao concluir uma mudança**, atualizar a tabela "Histórico" e as "Pendências" do README.
- Idioma da interface e dos textos: português do Brasil.

## Mapa rápido do código

Estado global: `emps`, `picos`, `horFunc[7]`, `distFolga`, `viewMode`. Entrada principal: `gerar()` → `gerarSemana()` → `renderTabelaSemana()`. Regras de folga em `calcFolgasEmp()`, domingos em `calcDomingosMes()`, intervalo em `calcIntervaloMin()`, saída em `calcSaida()`.

## Pontos de atenção

Ver "Pontos de atenção" no README. Regra: todo texto do usuário que vá para `innerHTML` passa por `esc()`; o 12x36 usa `folga12x36()` (data corrente), nunca a posição na semana.

# EscalaRápida — Gerador de Escala de Trabalho

Gerador gratuito de escalas de trabalho (CLT) para estabelecimentos. O usuário cadastra funcionários, horários de funcionamento e horários de pico, e o site monta a escala semanal ou mensal, com intervalos, folgas e domingos de folga.

- **URL:** https://www.escalarapida.com.br
- **Hospedagem:** Hostinger (hPanel, LiteSpeed) — confirmado pelos headers HTTP em 21/09/2026
- **Status:** No ar, com as correções de 21/09/2026 (12x36 e escape de HTML). O site publicado é idêntico ao `index.html` desta pasta (conferido em 21/09/2026).
- **Repositório:** https://github.com/alxsoares2/escalarapida-site (privado, branch `master`)
- **Origem:** o arquivo foi gerado numa conversa com o Claude, baixado em 02/06/2026 (ficou em `Downloads/escalarapida-index.html`) e subido na Hostinger. Esta pasta passou a ser a fonte oficial em 21/09/2026.

## Stack

- **Um único arquivo:** `index.html` com HTML + CSS + JavaScript puro (sem build, sem framework, sem backend, sem banco).
- **Única dependência externa:** Tabler Icons via CDN (`cdn.jsdelivr.net/npm/@tabler/icons-webfont@2.44.0`).
- Tudo roda no navegador. Nada é enviado a servidor; o estado só existe na página aberta.

## Estrutura da pasta

```
escalarapida-site/
├── index.html   # o site inteiro (CSS no <style>, JS no <script> no fim)
├── README.md    # este arquivo
└── CLAUDE.md    # regras de trabalho e mapa do código para o Claude
```

## Deploy

**Automático.** Todo `git push` na branch `master` publica sozinho em escalarapida.com.br (Git do hPanel da Hostinger, conectado ao GitHub, diretório `public_html`). Testado em 21/09/2026: o push do `.htaccess` chegou ao ar em ~10 segundos sem nenhuma ação no painel.

```bash
git add -A && git commit -m "..." && git push
```

- **A Hostinger publica o repositório inteiro** em `public_html`, incluindo `README.md` e `CLAUDE.md`. O `.htaccess` bloqueia o acesso público a arquivos `.md` (respondem 403). Qualquer arquivo novo que não deva ser público (notas, rascunhos, `.json` de teste) precisa ser bloqueado no `.htaccess` ou ficar fora do repositório.
- Se o deploy automático parar, o painel tem o botão de implantar em hPanel → Sites → escalarapida.com.br → Avançado → GIT.
- Conferir se o ar bate com o código:

```bash
curl -s https://www.escalarapida.com.br | tr -d '\r' | diff - index.html
```

(o `tr -d '\r'` ignora o CRLF que o servidor coloca no arquivo.)

## Como o site funciona

### Entradas (telas)

| Bloco | O que configura |
|---|---|
| Estabelecimento | Nome, mês e ano de referência (padrão: mês/ano de hoje) |
| Horário de funcionamento | Abre/fecha por dia da semana + botão "Fechado" (padrão 08:00–22:00 todos os dias) |
| Horários de pico | Faixas (ex.: 12:00–14:00) que os intervalos tentam evitar |
| Regras gerais | Mínimo na operação durante intervalo; distribuir folgas automaticamente; mínimo de pessoas por dia |
| Funcionários | Nome, cargo, hora de entrada, tipo de escala (5x2, 6x1, 4x3, 12x36), intervalo (1h ou 2h), "Trabalha FDS?" |
| Visualização | Semanal (com data de início) ou Mensal |

Botões extras: **Salvar configuração** (baixa um `.json`), **Carregar configuração** (lê o `.json`) e **Exportar PDF** (abre janela de impressão do navegador).

### Regras de cálculo (todas em `index.html`, bloco `<script>`)

- **Jornada:** 8h por dia para 5x2, 6x1 e 4x3; 12h para 12x36. O intervalo é somado *por fora* (saída = entrada + jornada + intervalo).
- **Turno** do funcionário (Manhã/Tarde/Noite) vem da hora de entrada: 05–11h = M, 12–17h = T, resto = N.
- **Saída limitada pelo fechamento:** se entrada + jornada + intervalo passa do horário de fechar, a saída é encurtada e a diferença aparece como **horas devidas** (por dia e somada na semana).
- **Intervalo:** começa no meio da jornada. Se cair num horário de pico, é antecipado para terminar antes do pico. Nunca passa de 6h após a entrada (`MAX6H = 360`, regra da CLT de intervalo em jornada > 6h).
- **Cobertura:** funcionários do mesmo turno saem para o intervalo em grupos escalonados; o tamanho do grupo é `equipe do turno − mínimo na operação`.
- **Folgas por tipo** (`calcFolgasEmp`):
  - 5x2 sem FDS: folga sáb + dom. Com FDS e distribuição ligada: 2 dias úteis rotacionados pelo índice do funcionário.
  - 6x1 sem FDS: folga dom. Com FDS: 1 dia rotacionado (seg–dom).
  - 4x3: um de 6 padrões de folga fixos, escolhido pelo índice.
  - 12x36: trabalha em dias alternados pela **data corrente** (`folga12x36`: paridade do nº de dias desde 1970 + índice do funcionário), então a alternância continua entre semanas e meses. Funcionários de índice par e ímpar se complementam.
- **Domingos de folga (`calcDomingosMes`):** para quem trabalha FDS em 5x2/6x1, distribui em rodízio quem folga em cada domingo do mês. Aparece no card "Domingos de folga" e marca a célula como "Dom. obrig.".
- **Alertas:** aviso quando algum dia tem menos gente que o mínimo por dia.
- A semana é sempre exibida de **domingo a sábado**.

### Funções principais

| Função | Papel |
|---|---|
| `gerar()` | Orquestra: lê a tela, monta o card de domingos e a(s) tabela(s), escreve em `#output` |
| `gerarSemana()` | Calcula as células (folga/trabalho, intervalo, saída, horas devidas) de uma semana |
| `renderTabelaSemana()` | Monta o HTML da tabela de uma semana |
| `calcFolgasEmp()` | Regra de folga por dia da semana (5x2, 6x1, 4x3); o 12x36 é tratado por `folga12x36()` |
| `esc()` | Escapa HTML — obrigatório para qualquer texto do usuário que entre em `innerHTML` |
| `calcDomingosMes()` | Rodízio de domingos |
| `calcIntervaloMin()` / `calcSaida()` | Horário do intervalo e da saída |
| `salvarConfig()` / `carregarConfig()` | Exportar/importar o estado em JSON (o carregamento valida e converte cada campo) |
| `exportPDF()` | Abre janela com a escala e chama `window.print()` |

### Formato do `.json` de configuração

`nomeEstab, mes, ano, horFunc[7]{ab,fe,fechado}, picos[]{ini,fim,id}, emps[]{nome,cargo,hora,tipo,intervalo,fds,turno,id}, distFolga, minCob, minDia`

Se a nova funcionalidade mexer nesse formato, manter compatibilidade com arquivos já salvos por usuários.

## Pontos de atenção

**Corrigidos e publicados em 21/09/2026:**

1. **12x36 na visão mensal:** a folga usava a posição na semana e reiniciava a cada semana, o que fazia o funcionário trabalhar dois dias seguidos na virada sábado→domingo. Agora usa a data corrente (`folga12x36`). Testado em 60 dias seguidos: nunca há 2 dias trabalhados em sequência e os índices par/ímpar são complementares.
2. **Texto do usuário sem escape de HTML:** nome, cargo, nome do estabelecimento e nomes nos domingos de folga passam por `esc()`, inclusive no PDF. Além disso `carregarConfig` agora valida o `.json` (horas `HH:MM`, tipo entre os 4 permitidos, números inteiros, ids gerados de novo) porque ids e horas iam para atributos `onclick`/`value`. Testado com arquivo malicioso: entradas inválidas são descartadas e um arquivo salvo por versões antigas continua carregando.

**Ainda abertos:**

3. **Descanso semanal e interjornada não são verificados** de forma explícita (11h entre jornadas, DSR preferencialmente no domingo). As regras da CLT no site são o intervalo de até 6h e a jornada de 8h/12h; o resto vem dos padrões de folga acima.
4. **Sem persistência:** recarregar a página perde tudo, a menos que o usuário tenha baixado o `.json`.
5. O site se descreve como "Respeita as leis trabalhistas brasileiras" (meta description). Convém não prometer conformidade jurídica além do que o código faz.

## Pendências / próximos passos

- [ ] **Nova funcionalidade** — a definir (combinada em 21/09/2026, ainda sem especificação). Registrar aqui a spec e as decisões quando começar.
- [ ] Decidir se vale trocar o arquivo único por estrutura com `css/` e `js/` separados (só se a funcionalidade nova crescer o suficiente).

## Histórico

| Data | O que |
|---|---|
| 02/06/2026 | Primeira versão publicada em escalarapida.com.br (gerada pelo Claude numa conversa) |
| 21/09/2026 | Corrigidos 12x36 entre semanas e escape de HTML / validação do `.json` carregado (publicado) |
| 21/09/2026 | Repositório no GitHub, deploy automático via Git da Hostinger e `.htaccess` bloqueando `.md` |
| 21/09/2026 | Código trazido para `C:\projetos\escalarapida-site`, git iniciado, README e CLAUDE.md criados |

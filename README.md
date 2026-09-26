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

## Ponto eletrônico (`/pontoeletronico`)

Sistema de ponto separado do gerador de escala, para as 2 empresas do dono (até 5 funcionários cada). **Regras completas em [`docs/ponto/ESPECIFICACAO.md`](docs/ponto/ESPECIFICACAO.md).** A Portaria MTP 671/2021 (REP-P) é só referência de projeto; **não há** INPI/ATTR/ICP-Brasil, então o sistema não pode se anunciar como "compatível com a Portaria 671".

| Onde | O que é |
|---|---|
| `pontoeletronico/index.html` | Tela do computador do balcão: escolhe o nome, digita o PIN, marca (entrada, saída p/ intervalo, volta, saída), comprovante, pedido de correção |
| `pontoeletronico/admin/` | Painel do gestor: funcionários e jornadas, domingos de folga e exceções, correções, relatórios (espelho mensal/PDF, banco de horas, faltas), empresas e estações |
| `pontoeletronico/api.js`, `config.js`, `ponto.css` | Cliente da API, configuração pública, estilo |
| `pontoeletronico/rosto.js` | Reconhecimento facial no navegador (biblioteca `@vladmandic/human` 3.3.6 via jsDelivr): descritor do rosto e notas de prova de vida; a comparação é no banco |
| `pontoeletronico/foto.js` | Câmera da foto de prova: sempre ligada na tela da estação, captura no toque (240 px, WebP), SHA-256 e envio pela Edge Function |
| `dev/supabase/functions/ponto-foto/` | Edge Function das fotos: `handler.js` (lógica, testada no Node) + `index.ts` (liga ao banco e ao Storage). Fica em `dev/`, bloqueada no site |
| `dev/db/migrations/*.sql` | Schema `ponto` no Supabase do Saas Financeiro (`dhmlltvdyhavpoyazaph`), 0001 a 0010, todas aplicadas (0010 = fase 2A, reconhecimento facial) |
| `dev/tests/` | 180 testes: regras de apuração, reconhecimento facial,, segurança, estações, fotos (incluindo a Edge Function) e as telas (jsdom ligado a um Postgres em memória) |

**Como funciona por baixo:** as páginas são estáticas (Hostinger) e falam com o Supabase por uma única função pública, `public.ponto_rpc(fn, args)`, que só executa funções `ponto.api_*`. Tabelas e funções internas ficam no schema `ponto`, sem acesso para `anon`/`authenticated` (RLS ligado, privilégios revogados). Toda a regra (hora do servidor, NSR, hash encadeado, apuração, banco de horas) roda no banco. A chave `anon` é pública; **a `service_role` nunca vai para o frontend**.

### Operações do dia a dia (no diretório `dev/`)

```bash
npm test                                                                   # 180 testes, ~90 s, não toca no banco real
node --env-file=../../marcus-assistente/.env db/migrate.mjs                # aplica migrations novas (não repete)
node --env-file=../../marcus-assistente/.env db/criar-codigo-instalacao.mjs  # código de uso único p/ criar o admin
npx supabase functions deploy ponto-foto --project-ref dhmlltvdyhavpoyazaph --no-verify-jwt --workdir .   # publica a Edge Function das fotos (precisa de `npx supabase login` uma vez)
```

**Não aplicar migration pelo SQL Editor do Supabase:** o painel pode estar aberto no projeto errado (em 26/09/2026 a 0008 foi colada no projeto do DirectMenu e falhou com `schema "ponto" does not exist`), e o Editor não registra a migration em `ponto.migracoes`, então o script tenta aplicá-la de novo e falha (aconteceu com a 0009 em 26/09/2026: aplicada pelo Editor, o script falhou com "column already exists"; conferido que o banco era idêntico ao arquivo e só então a 0009 foi anotada em `ponto.migracoes`). Sempre pelo `migrate.mjs`.

`DATABASE_URL` vem do `.env` do `marcus-assistente` (mesmo banco). Nunca copiar essa URL para este repositório. A pasta `~/.credenciais` citada no CLAUDE.md raiz **não existe** neste computador.

### Instalação do zero (já feita em 21/09/2026: chave `anon` em `config.js`, conta do gestor criada, site no ar)
Só para reinstalar em outro projeto Supabase:
1. **Chave `anon`:** copiar do Supabase (Project Settings → API → `anon` `public`) e colar em `pontoeletronico/config.js`. Enquanto estiver o texto `COLE_AQUI...`, as páginas mostram "Sistema ainda não configurado".
2. **Criar o acesso do gestor:** rodar `criar-codigo-instalacao.mjs`, abrir `/pontoeletronico/admin/` e criar e-mail + senha (a senha nunca passa pelo Claude; o código vale uma vez).
3. No painel: cadastrar as 2 empresas (com CNPJ e endereço, que saem no comprovante), os funcionários (PIN de 4 a 6 dígitos) e as jornadas.
4. Em **Estações**, gerar o código de ativação e colar no computador do balcão (aparece uma vez).
5. `git push` publica tudo (deploy automático).

### Impressão do comprovante na Elgin i9 (computador do balcão)
O comprovante imprime sozinho depois de cada marcação (cupom no tamanho da bobina, sem cabeçalho de página). Configuração única no computador do balcão:
1. Instalar o driver da Elgin i9, deixá-la como **impressora padrão** do Windows, papel 80 mm e corte automático ligado no driver.
2. Abrir o ponto por um atalho do Chrome com impressão silenciosa (sem a janela de impressão):
   `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --app=https://www.escalarapida.com.br/pontoeletronico/`
3. Bobina de 58 mm: trocar `larguraCupomMm` para `58` em `pontoeletronico/config.js`. Para desligar a impressão automática: `imprimirAoMarcar: false` (o botão "Reimprimir" continua na tela).

Sem `--kiosk-printing` o Chrome abre a janela de impressão a cada marcação. O layout do cupom foi conferido por imagem (80 mm) e por teste automático, **mas não numa i9 física**: se a margem ou o corte não ficarem certos, ajustar no driver/`ponto.css` (seção do cupom).

### Arquivos que nunca podem ficar públicos
A Hostinger publica o repositório inteiro. O `.htaccess` bloqueia `dev/`, `docs/`, `.git` e as extensões `.md .sql .mjs .cjs .json .env .log`. Por isso o frontend do ponto usa só `.js`, `.css` e `.html`. Não colocar `.env` nem chaves no repositório.

## Como o site funciona (gerador de escala)

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

- [ ] **Ponto, versão 2** (tablet, foto como prova, comprovante pelo WhatsApp do Marcus, marcação sem internet, backup no Drive, saúde das estações). Especificação aprovada em 26/09/2026: `docs/ponto/ESPECIFICACAO.md`, seção 11. Fases:
  - [x] Fase 1 (no ar desde 26/09/2026): estação com várias empresas + abas, `imprime`/`reserva` por estação, sinal de vida e quadro de saúde. Migration 0008 aplicada e tela publicada em 26/09/2026 (commit `5e6feae`).
  - [x] Fase 2 (no ar desde 26/09/2026): foto como prova (câmera com contagem, 240 px WebP, hash na cadeia), Edge Function `ponto-foto`, compartimento privado `ponto-fotos`, relatório "Marcações e fotos", espaço usado, câmera no quadro de saúde. Migration 0009 aplicada, Edge Function publicada e tela publicada. Ainda não testada com câmera real: ligar "Tira foto de prova" na estação do tablet e conferir no relatório "Marcações e fotos". Expurgo das fotos vencidas fica na fase 4.
  - [x] Fase 2A (código pronto e testado, **só local**): reconhecimento facial em modo totem (câmera como tela inicial, reconhece sem toque, tipo automático com contagem de 3 s, "Trocar"/"Não sou eu", prova de vida passiva, PIN como reserva com alerta `sem_rosto`), cadastro do rosto em 5 posições no painel, tentativas de reconhecimento no painel para calibrar. Migration 0010 aplicada em 26/09/2026 (pelo SQL Editor, conferida idêntica e anotada). **Falta:** publicar; cadastrar os rostos no tablet; calibrar o limiar (começa em 0,65) na primeira semana.
  - [ ] Fase 3: WhatsApp pelo Marcus + aviso de estação fora do ar (mexe no `marcus-assistente`).
  - [ ] Fase 4: backup (botão + Drive do RH + `manifest.txt`). Antes: confirmar backup sem PDF e o dono da pasta no Drive.
  - [ ] Fase 5: marcação sem internet (PIN cifrado com chave pública).
- [ ] **Nova funcionalidade do gerador de escala** — a definir (combinada em 21/09/2026, ainda sem especificação).
- [ ] Decidir se vale trocar o arquivo único por estrutura com `css/` e `js/` separados (só se a funcionalidade nova crescer o suficiente).

## Histórico

| Data | O que |
|---|---|
| 02/06/2026 | Primeira versão publicada em escalarapida.com.br (gerada pelo Claude numa conversa) |
| 21/09/2026 | Corrigidos 12x36 entre semanas e escape de HTML / validação do `.json` carregado (publicado) |
| 21/09/2026 | Repositório no GitHub, deploy automático via Git da Hostinger e `.htaccess` bloqueando `.md` |
| 21/09/2026 | Código trazido para `C:\projetos\escalarapida-site`, git iniciado, README e CLAUDE.md criados |
| 21/09/2026 | Ponto eletrônico publicado em `/pontoeletronico` (impressão na Elgin i9, espelho mensal) |
| 26/09/2026 | Fase 2A implementada localmente: reconhecimento facial em modo totem (migration 0010, `rosto.js`); biblioteca real conferida em Chrome sem janela com fotos de exemplo; limiar inicial 0,65; 180 testes |
| 26/09/2026 | Corrigido: com o aviso "Permitir câmera?" aberto, a tela pedia a câmera de novo a cada 10 s e o aviso sumia antes do clique. Agora é um pedido só, sem prazo; câmera bloqueada mostra instrução e botão "Ativar câmera"; marcar ponto nunca espera a câmera |
| 26/09/2026 | Foto: câmera sempre ligada na tela (foto no instante do toque, sem contagem); religa sozinha |
| 26/09/2026 | Fase 2 do ponto v2 publicada (foto como prova, Edge Function `ponto-foto`, migration 0009); 140 testes. Reconhecimento facial especificado como fase 2A |
| 26/09/2026 | Ponto v2 especificado e aprovado (seção 11 da especificação). Fase 1 publicada: estação com várias empresas (abas no tablet), impressão por estação, sinal de vida e quadro de saúde; migration 0008; 112 testes |

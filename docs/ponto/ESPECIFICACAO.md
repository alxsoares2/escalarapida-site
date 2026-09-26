# Ponto Eletrônico — Especificação

Sistema de controle de ponto em `escalarapida.com.br/pontoeletronico`, separado do gerador de escala.
Especificação fechada em conversa com o dono em 21/09/2026. Este arquivo é a fonte de verdade das regras; mudou uma regra, muda aqui primeiro.

## 1. Escopo e premissas

- **Uso:** só as 2 empresas do dono, até 5 funcionários cada. Sem cadastro aberto, sem cobrança.
- **Norma como referência, não como obrigação.** A Portaria MTP 671/2021 (REP-P) é a base de projeto. **Não há** certificado ICP-Brasil, registro no INPI nem ATTR. Portanto o sistema **não pode se apresentar como "compatível com a Portaria 671"** (nem na tela, nem no site) até que isso exista.
- A Portaria 1.510/2009 foi revogada pela 671; não é alvo.
- Para virar produto comercial no futuro (fora do escopo agora): INPI, ATTR assinado com e-CPF, assinatura ICP-Brasil (tipo A1) do AFD/AEJ/comprovante, AEJ e espelho no leiaute oficial, e validação por contador/advogado trabalhista.
- Citar números de artigo da portaria só depois de conferir o texto oficial (o PDF do gov.br estava fora do ar na pesquisa; os números de artigo variaram entre as fontes).

## 2. Arquitetura

| Camada | Escolha |
|---|---|
| Frontend | Páginas estáticas em `/pontoeletronico/` (mesmo repositório e deploy automático da Hostinger) |
| Backend | Supabase (projeto do Saas Financeiro), **schema `ponto`** isolado |
| Lógica | Funções PL/pgSQL no banco (hora do servidor, NSR, hash, apuração, banco de horas) |
| API | Funções `public.ponto_*` (SECURITY DEFINER) chamadas por RPC com a chave `anon`. O schema `ponto` não é exposto. |
| Testes | Postgres local em memória (PGlite), `dev/tests/` |

Regras de segurança da API: as tabelas nunca são acessadas direto; toda função `ponto_*` valida um token de **estação** (computador do balcão) ou de **sessão de admin**. A chave `service_role` nunca vai para o frontend.

## 3. Como o funcionário marca ponto

1. Computador fixo do estabelecimento, cadastrado como **estação** (token guardado no navegador daquele computador; o token é mostrado uma vez e só o hash fica no banco).
2. O funcionário escolhe o **nome** na lista da empresa da estação e digita o **PIN** (4 a 6 dígitos, guardado com bcrypt).
3. O sistema mostra as marcações válidas naquele momento e o funcionário confirma.
4. Hora sempre do **servidor**, truncada no minuto. Nunca do computador.
5. Comprovante na tela: NSR, empresa, nome, data/hora, tipo, hash.
6. **Impressão automática** do comprovante em impressora térmica não fiscal (**Elgin i9**, bobina de 80 mm ou 58 mm, ESC/POS): sai sozinho após cada marcação, sem janela de impressão, e há botão "Reimprimir". Implementado como impressão do navegador (CSS `@page` na largura da bobina) com o Chrome em modo `--kiosk-printing`, usando a i9 como impressora padrão do Windows. Configurável em `config.js` (`imprimirAoMarcar`, `larguraCupomMm`).
7. **Só o gestor desvincula** um computador (desativa a estação no painel). A tela do balcão não tem botão para isso.

**4 marcações por dia:** `entrada` → `saida_intervalo` → `volta_intervalo` → `saida`. A partir da entrada também é aceita `saida` direta (dia sem intervalo registrado, gera alerta).

Proteções:
- **5 PINs errados seguidos bloqueiam o funcionário por 5 minutos.**
- Duas marcações do mesmo funcionário em menos de 30 s são recusadas (toque duplo).
- A marcação nunca é bloqueada por horário nem exige autorização (a portaria proíbe restringir a marcação).
- Jornada que atravessa a meia-noite: o dia da jornada é a data (Recife) da **entrada**.

### Registro imutável
- Tabela `marcacao` só aceita INSERT (UPDATE/DELETE/TRUNCATE bloqueados por trigger).
- **NSR** sequencial por empresa, sem buracos.
- **Hash SHA-256 encadeado**: cada marcação inclui o hash da anterior da mesma empresa. Existe função de verificação da cadeia.

## 4. Jornada e exceções

### Jornada (por funcionário, com vigência por data)
Dias da semana trabalhados, horário de entrada e de saída previstos, minutos de intervalo (padrão 15).
`carga esperada = (saída − entrada) − intervalo`. Ex.: 10:00–16:15 com 15 min = 6h.
O caso comum é 6x1 com 6h corridas e 15 min de intervalo em qualquer momento da jornada.

### Domingos de folga
O dono marca, **mês a mês, para cada funcionário**, qual(is) domingo(s) de folga. Semana com domingo de folga fica 5x2. Modelado como exceção `folga_domingo`.

### Exceções por data (ou período)
| Tipo | Efeito |
|---|---|
| `folga_domingo` | Dia não esperado. Sem falta. |
| `dia_liberado` | Dia não esperado (abono). Não mexe no banco. |
| `trabalho_folga` | Dia que seria de folga passa a ser esperado. |
| `troca_horario` | Troca entrada/saída previstas no período. |
| `compensacao` | Abate o banco. Sem marcação no dia, debita `minutos` (ou a carga inteira se vazio). |
| `atestado`, `ferias`, `licenca` | Dia não esperado, justificado. |
| `feriado` | Vale para todos os funcionários da empresa. |
| *Troca de dia de folga* | Atalho: cria `dia_liberado` no dia novo + `trabalho_folga` no dia antigo, ligados por um mesmo `grupo`. |

Regra de precedência: `trabalho_folga` vence os tipos de folga; qualquer tipo de folga torna o dia não esperado. Exceção cancelada não vale mais (fica no histórico).

## 5. Apuração do dia

Estados do dia: `folga`, `trabalho`, `falta`, `incompleto`, `em_andamento`, `compensado`.

1. **Dia esperado sem nenhuma marcação** (e sem compensação) e já passado → **falta**.
2. **Dia esperado sem marcação, com `compensacao`** → `compensado`, debita o banco.
3. **Dia de hoje ainda sem saída** → `em_andamento` (não é falta nem saldo).
4. **Marcações faltando** (ex.: sem volta do intervalo, ou entrada sem saída em jornada antiga) → `incompleto`, **sem saldo**, aparece para você corrigir. *(Interpretação minha: "esqueceu de bater" com dia inteiro em branco é falta; marcação faltando no meio do dia é incompleto.)*
5. **Dia completo** → `trabalho`, com saldo:
   `saldo do dia = trabalhado − carga esperada`, onde `trabalhado = (saída_intervalo − entrada) + (saída − volta)`.
6. **Dia não esperado com marcação** → tudo que foi trabalhado é crédito no banco.

### Tolerância da CLT (art. 58 §1º)
Variações de até 5 min por marcação (entrada, saída) e no tamanho do intervalo (vs. o previsto) não geram desconto nem extra, **se a soma das variações toleradas do dia for ≤ 10 min**. Se passar de 10 min, contam **todos** os minutos (Súmula 366 do TST). Variação maior que 5 min conta inteira.

### Intervalo
- Intervalo real < 15 min gera alerta `intervalo_curto`. Sem marcação de intervalo: alerta `sem_intervalo`; o tempo conta como trabalhado (vira crédito, como intervalo não gozado).

### Faltas
Falta de dia inteiro **não mexe no banco de horas**. Vai para a **lista de faltas** (base para advertência e desconto do dia). O desconto do DSR da semana fica com o contador.

### Banco de horas
Por funcionário, em **minutos**: `saldo_inicial + soma dos saldos dos dias` a partir do `inicio_controle` (dias antes disso nunca viram falta). Extra é automática (tudo acima da carga + tolerância). Banco de horas exige acordo por escrito com o funcionário: o sistema só calcula.

## 6. Correções (tratamento do ponto)
- Nunca se apaga nem altera uma marcação. A correção **acrescenta** (`incluir` marcação) ou **desconsidera** (`desconsiderar` uma marcação indevida), sempre com **motivo**, autor e data.
- O dono cria correções direto (já aprovadas).
- O funcionário pede no computador do balcão (informa horário, tipo e motivo); o dono **aprova ou recusa** (com motivo da decisão).
- Só correções aprovadas entram na apuração.

## 7. Painel do dono (só ele)
Login com e-mail e senha (bcrypt), sessão de 12 h, bloqueio após tentativas erradas. Alterna entre as 2 empresas. Cadastra empresas, estações, funcionários (nome, CPF, PIN), jornadas, exceções e domingos de folga; aprova correções.

Relatórios:
1. **Espelho de ponto mensal** por funcionário, no estilo da planilha que o dono usava ("Controle de cartão ponto"): cabeçalho com empresa/CNPJ/funcionário/mês, quadro **Carga horária** por dia da semana, quadro **Banco de horas** (saldo anterior, variação, atual, faltas) e, por dia: Entrada, Saída, Entrada, Saída, **H. Diária**, **Atrasos**, **Horas Extras**, **Compensado**, **A.N.** (adicional noturno), **Banco de horas acumulado linha a linha** e Obs. (avisos), com linha de totais. Impressão em A4 paisagem com linhas de assinatura.
   - **A.N.:** minutos trabalhados entre 22h e 5h (Recife). Sem a conversão da "hora noturna reduzida" (52min30s): isso fica com a folha/contador. Decisão do dono: incluir, pois o fechamento da loja às vezes passa das 22h.
   - **Sem colunas de "faixa" de hora extra** (1ª/2ª faixa da planilha antiga): decisão do dono, tudo vai só para o banco de horas.
   - Atraso = saldo negativo em dia trabalhado; Hora extra = saldo positivo; Compensado = dia inteiro abatido do banco.
   - **Quem vê:** só o gestor. O funcionário **não** tem acesso ao espelho nem ao banco de horas pelo sistema; no fim do mês o gestor imprime o espelho e o funcionário assina atestando as marcações. No balcão o funcionário só vê as próprias marcações das últimas 48 h (com NSR) e o comprovante de cada marcação.
2. **Saldo do banco de horas** com histórico de créditos e débitos.
3. **Lista de faltas** por funcionário e período.
4. **Correções pendentes.**

## 8. Fora de escopo (por enquanto)
Celular do funcionário, geolocalização, integração com o gerador de escala, assinatura ICP-Brasil, AFD/AEJ oficiais, venda a terceiros, múltiplos administradores. (Tablet, foto, reconhecimento facial, WhatsApp, marcação sem internet e backup estão na versão 2, seção 11.)

## 9. Estado da implementação (conferido em 26/09/2026)

- **Banco:** migrations 0001–0008 **aplicadas** no Supabase do Saas Financeiro (schema `ponto`; schemas `financeiro` e `assistente` intactos). Verificado: `anon` só executa `public.ponto_rpc`; todas as tabelas com RLS.
- **Frontend:** estação (`/pontoeletronico/`) e painel (`/pontoeletronico/admin/`) **no ar desde 21/09/2026**, com a chave `anon` configurada e a conta do gestor criada. Impressão automática (Elgin i9), só o gestor desvincula e espelho novo também publicados (commits `173bb45` e `25e5a32`; arquivos no ar iguais ao repositório em 26/09/2026).
- **Uso real:** ainda não. Em 26/09/2026 o banco tinha 1 empresa, 1 funcionário, 1 estação e 3 marcações, todas de 21/09 (testes da instalação).
- **Testes:** 146 automáticos passando (apuração, segurança, estações, fotos e Edge Function, telas).
- **Versão 2, fase 2 (26/09/2026), no ar:** migration 0009 (`foto_hash` na cadeia, `foto_exigida`, tabela `foto`, `tira_foto`/`camera_ok` por estação, compartimento privado `ponto-fotos`), Edge Function `ponto-foto` (`dev/supabase/functions/`), câmera na estação (`foto.js`), relatório "Marcações e fotos" e espaço usado no painel. A hash sem foto é idêntica à da versão 1 (marcações antigas continuam conferindo). 0009 aplicada (pelo SQL Editor, conferida idêntica ao arquivo e anotada em `ponto.migracoes`), Edge Function publicada com `--no-verify-jwt` (a função se autentica sozinha), tela publicada. Falta o teste com a câmera real do tablet.
- **Versão 2, fase 1 (26/09/2026), no ar:** migration 0008 (estação com várias empresas, `imprime`/`reserva` por estação, sinal de vida), abas por empresa e botões maiores no tablet, quadro de saúde no painel. Migration 0008 **aplicada** no banco real em 26/09/2026 (verificado: RLS ligado na tabela nova, `anon` só executa `public.ponto_rpc`, cadeia íntegra). Tela publicada no mesmo dia (commit `5e6feae`).
- **Primeiro acesso:** o admin foi criado pela própria página com um código de uso único (só o hash fica no banco), para a senha nunca passar por terceiros.

## 10. Pontos a confirmar com o dono
- `incompleto` versus `falta` quando falta só uma marcação (regra do item 5.4).
- Tempo de bloqueio do PIN (5 min) e limite de tentativas (5).
- Se o intervalo real maior que o previsto deve entrar no banco (hoje entra: desconta do trabalhado).

## 11. Versão 2: tablet, foto, WhatsApp, sem internet e backup

> **Status: aprovada pelo dono em 26/09/2026** (com os ajustes de revisão: PIN cifrado sem internet, limites de 5 min e 24 h, fotos por 2 anos, saúde da estação com aviso no WhatsApp, resumo do backup com hash registrado). Implementação em fases (11.9). **Cada regra vale a partir da fase em que é publicada**; até lá, valem as seções 1 a 10. Depois de publicadas, as regras daqui substituem as partes das seções 3, 7 e 8 que contradizem.

### 11.1 Decisões do dono

| Tema | Decisão |
|---|---|
| Aparelho | **Um tablet Android** fixo, com a página do ponto em modo quiosque (sem app de loja) |
| Identificação | **Reconhecimento facial** (decidido em 26/09/2026, revendo a decisão anterior de só foto): o rosto identifica a pessoa e o **PIN vira reserva** quando não reconhece. Prova de vida **às vezes** (sorteada). A foto de prova continua em toda marcação (11.4 e 11.4A) |
| Empresas | O tablet atende **as 2 empresas**, com **abas por empresa** |
| Impressão | O tablet **não imprime**. O computador da Elgin i9 continua como **estação reserva**, com impressão |
| Comprovante | **WhatsApp pelo número do Marcus** (fila no banco, o Marcus envia) |
| Sem internet | Usa a **hora do Android**, com conferência automática e marcação sinalizada |
| Fotos | Storage do Supabase, **plano gratuito** (não pagar Storage), compartimento privado |
| Backup | Mensal, automático, para o **Google Drive do RH**, e botão **"Baixar backup"** no painel |
| Geolocalização | **Não.** Num tablet fixo não prova nada que o vínculo da estação já não prove |

### 11.2 Estações

- A estação deixa de pertencer a uma empresa só. Nova tabela `estacao_empresa` (estação ↔ empresas que ela atende). As estações atuais migram com a empresa que já têm.
- Configuração **por estação**, no painel (não mais só em `config.js`): `tira_foto` (sim/não), `imprime` (sim/não), `aceita_sem_internet` (sim/não). Tablet: foto sim, impressão não, sem internet sim. Computador da Elgin: foto não, impressão sim, sem internet não.
- Na tela, uma **aba por empresa**; cada aba lista só os funcionários ativos daquela empresa. O NSR e o hash encadeado continuam **por empresa**.
- Continua valendo: token mostrado uma vez, só o hash no banco, só o gestor desvincula.

### 11.3 Tablet (hardware e configuração)

- Android com câmera frontal, suporte fixo na parede, carregador sempre ligado, **luz boa no rosto**.
- Navegador em modo quiosque (ex.: Fully Kiosk Browser) travado em `/pontoeletronico/`, **sem acesso às configurações do Android** (principalmente data/hora).
- Layout próprio para tela de toque: botões grandes, retrato.

### 11.4 Foto como prova

1. **Câmera sempre ligada** (decidido em 26/09/2026, no lugar da moldura com contagem): a imagem da câmera frontal fica o tempo todo na tela da estação, abaixo do relógio. A foto é o **quadro do instante do toque em "Registrar"**, sem contagem nem espera; a pessoa já está de frente para o tablet. Nada é gravado continuamente: só esse quadro é guardado.
   - Se o Android derrubar a câmera (tela apagada, outro app, economia de energia), a página religa sozinha (na volta da tela, 10 s depois de uma falha e numa checagem a cada minuto).
   - **Permissão:** nunca dois pedidos de câmera ao mesmo tempo; com o aviso "Permitir câmera?" aberto, espera a pessoa decidir (sem prazo). Negada ou fechada: o quadro da câmera mostra a instrução e um botão "Ativar câmera", e a página **não** pede de novo sozinha (volta quando liberarem no cadeado da barra de endereço). A marcação nunca espera a câmera: sem imagem na hora do toque, segue sem foto.
   - Desligar a câmera fora do horário de funcionamento fica para quando o horário por estação existir (fase 3).
2. Recorte quadrado do centro da imagem (sem detecção de rosto), **240 px, WebP, ~10 KB**.
3. O **SHA-256 da foto entra no cálculo do hash encadeado** da marcação (coluna nova `foto_hash` em `marcacao`). Trocar a foto depois é detectável.
4. **Câmera com defeito ou recusada não impede a marcação** (seção 3: a marcação nunca é bloqueada); a marcação fica com o alerta `sem_foto`.
5. **Onde fica:** compartimento **privado** `ponto-fotos` no Supabase Storage, caminho `empresa/AAAA-MM/nsr.webp`. Nunca público (os compartimentos que já existem no projeto são públicos; este não pode ser).
6. **Envio e leitura:** por uma Supabase Edge Function `ponto-foto` (grátis até 500 mil chamadas/mês), porque o navegador não pode ter a chave `service_role`. Ela se autentica pelas mesmas regras da API (token da estação para enviar; sessão do gestor para ver) e confere que o hash do arquivo bate com o `foto_hash` da marcação.
7. **Quem vê:** só o gestor, no painel (miniatura ao lado de cada marcação, no dia e nas correções). O funcionário não vê fotos de ninguém.
8. **Prazo:** fotos guardadas por **2 anos** por padrão, configurável no painel **até 5 anos** (só se o contador/advogado justificar); depois são apagadas. Motivo: quem prova as marcações é o espelho assinado todo mês; a foto serve para dúvidas recentes, e guardar menos reduz a exposição na LGPD. A marcação fica para sempre (com o `foto_hash`, que prova que existiu foto).
9. **Espaço:** ~1.040 fotos/mês × 10 KB ≈ 125 MB/ano ≈ 250 MB em 2 anos (620 MB no máximo de 5), dentro do 1 GB grátis. Em 26/09/2026 o Storage do projeto usava 12 MB e o banco 18 MB (de 500 MB). O painel mostra o **espaço usado** e avisa acima de 80%.
10. **Aviso aos funcionários:** **dispensado pelo dono em 26/09/2026** (uso interno e próprio). Não há aviso impresso no painel. Informação de registro: o banco e o Storage ficam na região `us-east-1` (EUA), conferido em 26/09/2026.

### 11.4A Reconhecimento facial

Decidido em 26/09/2026. Construído **em cima da foto de prova** (11.4), que continua existindo em toda marcação.

**Onde roda:** o modelo roda **no tablet**, no navegador (biblioteca de código aberto `@vladmandic/human`, versão fixa, carregada do jsDelivr e guardada no aparelho; ~5 a 8 MB). Ele encontra o rosto, faz a prova de vida e gera o **descritor** (assinatura numérica do rosto). **A comparação é no servidor**, dentro do banco: o tablet envia só o descritor; os descritores cadastrados **nunca saem do servidor** (tablet roubado não leva o cadastro facial de ninguém). Sem serviço pago. Sem AWS.

**Fluxo no tablet (estação com `reconhece_rosto`):**
1. Tela de espera: relógio + **câmera sempre ligada** (11.4). Um detector leve de rosto roda o tempo todo em baixa frequência; quando um rosto fica **parado de frente por ~1 s**, o reconhecimento começa sozinho, **sem toque**. Quem preferir continua podendo tocar no próprio nome (vai direto para o PIN).
2. O tablet pede ao servidor o início do reconhecimento (`api_iniciar_reconhecimento`), que devolve um identificador de uso único (vale **60 s**) e o **desafio de prova de vida** sorteado pelo servidor: `nenhum`, `piscar` ou `virar_rosto`.
3. Desafio de prova de vida, se sorteado ("pisque" / "vire o rosto"). Até **5 s** para cumprir.
4. O tablet envia o descritor e se o desafio foi cumprido (`api_reconhecer`). O servidor compara com os descritores dos funcionários **ativos das empresas que a estação atende** (1 para N) e responde com a pessoa reconhecida ou "não reconhecido".
5. **Reconhecido:** tela "Olá, **Ana** (Empresa X) — Registrar ENTRADA?" com os botões das marcações válidas, e **"Não sou eu"**. O toque confirma; a foto de prova é tirada nesse momento.
6. **Não reconhecido** (ou "Não sou eu", ou desafio não cumprido em 5 s, ou câmera com defeito): cai no fluxo atual, **abas por empresa → nome → PIN**. A marcação por PIN recebe o alerta `sem_rosto` e aparece destacada para o gestor revisar, com a foto.

**Regra de reconhecimento:**
- Reconhece quando a similaridade com o melhor candidato é **≥ limiar** e a diferença para o segundo melhor é **≥ margem** (evita confundir duas pessoas parecidas). Limiar e margem ficam em `ponto.config`; valores iniciais conservadores, **calibrados no tablet real** (luz e câmera do local) antes de ligar para todos.
- Similaridade na **faixa de dúvida** (logo abaixo do limiar): repete uma vez **com desafio obrigatório**; se continuar em dúvida, vai para o PIN.
- O identificador do passo 2 é de uso único e amarrado à estação; a marcação por rosto só é aceita com um reconhecimento bem-sucedido da mesma estação, do mesmo funcionário, dentro dos 60 s.
- Limite de **20 tentativas de reconhecimento por minuto por estação** (contra enxurrada de tentativas).

**Prova de vida "às vezes":** o servidor sorteia o desafio em **1 de cada 3** reconhecimentos (o funcionário não sabe quando vem), e ele é **obrigatório** na faixa de dúvida e para quem teve marcação `sem_rosto` nos últimos 7 dias. Barra o truque mais comum (foto do colega no celular); máscara ou vídeo bem feito ainda podem passar: aceitável para uso interno. Desafio pedido e não cumprido = não reconhecido (vai para o PIN).

**Cadastro do rosto (painel):**
- Feito **no próprio tablet** (mesma câmera e luz): o gestor abre o painel no tablet, Funcionários → **"Cadastrar rosto"**, e o sistema tira **5 amostras** com desafio de prova de vida. Só amostras com um único rosto nítido são aceitas.
- Tabela nova `rosto` (funcionário, descritor, data), RLS ligado, **nenhuma API devolve descritores**. "Refazer cadastro" substitui as amostras.
- **Funcionário inativado:** os descritores são **apagados** (o descritor não é marcação; pode ser apagado). A marcação e a foto seguem as regras de 11.4.
- Funcionário sem rosto cadastrado marca pelo PIN normalmente (sem alerta `sem_rosto` até ter cadastro).

**Registro:** cada tentativa grava `reconhecimento` (estação, funcionário candidato, similaridade, desafio, resultado, data), para auditoria e para calibrar o limiar. A marcação feita por rosto guarda o `reconhecimento_id`; `origem_identificacao` = `rosto` ou `pin`.

**Configuração por estação:** `reconhece_rosto` (sim/não). Tablet: sim. Computador da Elgin: não (continua nome + PIN).

**Sem internet (fase 5):** sem servidor não há comparação. Sem internet a estação usa **nome + PIN** (PIN cifrado, 11.5); o tablet guarda também o descritor e a foto, e o servidor compara quando a fila sobe: se o rosto não bater com o funcionário do PIN, a marcação ganha o alerta `rosto_nao_confere`.

**LGPD:** descritor facial é dado biométrico (sensível). Base: prevenção à fraude na identificação em sistema eletrônico (art. 11, II, "g"). Por isso os descritores ficam só no servidor e são apagados quando o funcionário sai. Aviso formal dispensado pelo dono (uso interno, 11.4.10).

**Testes:** os automáticos não rodam o modelo; o módulo de reconhecimento é substituído por um simulado que devolve descritores fixos. A regra (limiar, margem, uso único, desafio, alertas, limite por minuto) é testada no banco. **A qualidade real só se vê no tablet.**

### 11.5 Marcação sem internet

**Muda a regra da seção 3.4** ("hora sempre do servidor"): com internet, continua a hora do servidor; **sem internet, vale a hora do Android**, com as proteções abaixo. Só em estações com `aceita_sem_internet`.

- **A página funciona sem internet** (service worker guarda a página e a lista de nomes). A lista **não** leva hashes de PIN para o tablet: um PIN de 4 a 6 dígitos se descobre em segundos se alguém copiar os dados do aparelho.
- **Conferência do relógio:** com internet, o tablet anota a diferença entre o relógio dele e o do servidor e o instante em que conferiu (contador interno do navegador, que não muda se alguém mexer na hora do Android). Sem internet, calcula a hora esperada = última hora do servidor + tempo corrido no contador.
- Cada marcação feita sem internet guarda: **hora do Android** (a que vale, truncada no minuto), hora estimada pelo contador, o **PIN cifrado** (abaixo), a foto e um identificador único gerado no tablet (para não duplicar no reenvio). Fica numa fila no próprio tablet.
- **O PIN nunca fica legível no tablet.** No momento da marcação, o tablet cifra `{PIN, identificador da marcação, funcionário, hora}` com a **chave pública** do servidor (RSA-OAEP pela Web Crypto do navegador, sem biblioteca) e descarta o PIN. Só o servidor, com a chave privada, abre. Quem copiar os dados do tablet não descobre o PIN, nem o próprio tablet consegue ler de volta, e o texto cifrado não serve para outra marcação (leva o identificador e a hora dentro). Não se usa hash/derivação do PIN no tablet: com 4 a 6 dígitos (no máximo 1 milhão de combinações), qualquer valor derivado se quebra testando todas. A chave pública vai na página; a privada fica só no servidor (segredo da Edge Function, nunca no repositório).
- **Quando a internet volta**, a fila sobe sozinha. O servidor abre o PIN, confere e grava a marcação com `origem = 'sem_internet'`, `hora_dispositivo`, `recebido_em` e os alertas:
  - `relogio_divergente`: hora do Android difere mais de **5 min** da estimada;
  - `sem_referencia`: o tablet reiniciou sem internet e não havia como conferir;
  - `atraso_envio`: chegou mais de **24 h** depois da hora marcada. **É só alerta, não bloqueia:** uma queda de internet num fim de semana não pode virar dezenas de aprovações manuais.
- **PIN errado sem internet:** a marcação **não** entra. Vai para a fila de correções como pedido pendente (com a foto); se o gestor aprovar, vira uma correção `incluir` com motivo, como qualquer correção (seção 6).
- As marcações com alerta **entram na apuração**, mas aparecem destacadas no painel e na coluna Obs. do espelho para o gestor revisar; se estiverem erradas, o gestor corrige pelo caminho normal (desconsiderar + incluir).
- **Ordem do NSR:** o NSR é dado quando a marcação chega ao servidor. Uma marcação feita sem internet pode ter NSR maior que outras de horário posterior. O hash continua encadeado pela ordem do NSR; a apuração usa `marcado_em`.
- A regra dos 30 s (toque duplo) vale também para marcações sem internet.

### 11.6 Comprovante pelo WhatsApp (pelo Marcus)

- Funcionário ganha os campos `telefone` e `recebe_whatsapp`. Sem telefone, não recebe (o comprovante continua na tela).
- Cada marcação grava uma mensagem numa **fila no schema `ponto`** (`whatsapp_fila`: telefone, texto, criado_em, enviado_em, tentativas, erro). Texto: empresa, nome, tipo, data/hora, NSR, início do hash e "mensagem automática, não responda". Marcação sem internet leva "registrada sem internet". **Não diz que é compatível com a Portaria 671.**
- O **Marcus** (outro projeto, `marcus-assistente`) lê a fila no poller que já roda, envia pela Z-API dele e marca como enviada. Interface só por funções do schema `ponto` (`ponto.whatsapp_pegar_lote()`, `ponto.whatsapp_marcar_enviado()`), sem FK entre schemas.
- **Respostas dos funcionários:** o Marcus consulta `ponto.telefones_funcionarios()`; mensagem vinda desses números **não vai para a IA**. Ele responde um texto fixo, no máximo uma vez por dia por número: "Este número só envia comprovantes de ponto. Dúvidas, fale com o gestor."
- Falha de envio: até 5 tentativas; depois fica com erro e aparece no painel.

### 11.7 Backup

- **Automático, mensal:** todo dia 1º, de madrugada (Recife), o **Marcus** gera o pacote do mês anterior e envia para uma **pasta do Google Drive do RH**, compartilhada com uma **conta de serviço do Google** (só enxerga aquela pasta; ninguém passa senha).
- **Conteúdo, por empresa:** marcações, correções e exceções em CSV; apuração diária (as mesmas colunas do espelho: entradas/saídas, H. Diária, Atrasos, Horas Extras, Compensado, A.N., banco acumulado) em CSV; resultado da verificação da cadeia de hash; fotos do mês num `.zip`.
- **O espelho em PDF não vai no backup automático** (gerar PDF no Marcus exigiria um navegador no servidor). O espelho continua saindo pelo painel, que o gestor imprime todo mês para assinatura.
- **Resumo com impressão digital:** todo pacote leva um `manifest.txt` com empresa, período, quantidade de registros por arquivo e o SHA-256 de cada arquivo. O **SHA-256 do próprio `manifest.txt` fica gravado no banco** (`backup_registro`: data, período, destino, hash) e aparece no painel. Só o resumo dentro do zip não provaria nada (quem altera o zip refaz o resumo); com o hash registrado fora do zip, qualquer cópia pode ser conferida depois.
- **Botão "Baixar backup"** no painel: mesmo pacote, para qualquer período, baixado no navegador (também registra o hash).
- O **expurgo das fotos vencidas** (11.4.8) roda junto com o backup mensal, chamando a Edge Function.
- Motivo: o plano gratuito do Supabase **não tem backup automático** do banco.

### 11.8 Saúde das estações

Para não descobrir problema só no fechamento do mês.

- **Sinal de vida:** cada estação avisa o servidor a cada **5 min** enquanto a página está aberta (`ultimo_contato`), mandando junto: diferença do relógio para o servidor, câmera funcionando (estações com foto) e quantas marcações estão na fila sem internet.
- **Quadro no painel**, por estação: online / fora do ar (sem sinal há mais de 10 min), último contato, relógio OK (diferença ≤ 5 min), câmera OK, marcações aguardando envio. No mesmo quadro: comprovantes de WhatsApp com falha e resultado do último backup.
- **Aviso no WhatsApp do gestor** (pelo Marcus): estação principal **sem sinal há mais de 1 h dentro do horário de funcionamento** (definido por estação no painel; padrão: todos os dias, 08:00–22:00). Um aviso por queda e outro quando volta; sem repetir enquanto continuar fora. Estações marcadas como reserva (computador da Elgin) não geram aviso.
- Sem internet o tablet não consegue avisar; por isso a queda aparece como "fora do ar" pelo último contato, e a fila pendente é informada quando a conexão volta.

### 11.9 Impacto e ordem de implementação

Mexe em **dois projetos**. Cada fase é publicada e testada antes da seguinte.

| Fase | O quê | Projeto |
|---|---|---|
| 1 | Estação com várias empresas, configuração por estação, abas, layout de tablet; sinal de vida e quadro de saúde (online/último contato/relógio) | ponto |
| 2 | Foto: Edge Function, compartimento privado, `foto_hash` no hash, miniaturas no painel, espaço usado, câmera no quadro de saúde | ponto |
| 2A | Reconhecimento facial: modelo no tablet, comparação no servidor, cadastro do rosto no painel, prova de vida sorteada, PIN como reserva com alerta `sem_rosto`, calibração no tablet real | ponto |
| 3 | WhatsApp: telefone do funcionário, fila, envio e filtro de respostas; aviso de estação fora do ar | ponto + Marcus |
| 4 | Backup: botão no painel, `manifest.txt` e hash registrado; envio mensal ao Drive e expurgo de fotos | ponto + Marcus |
| 5 | Sem internet: service worker, fila no tablet, PIN cifrado, conferência do relógio, alertas, pendências por PIN errado, fila no quadro de saúde | ponto |

A fase 5 fica por último por ser a mais complexa e a que muda uma regra central. Até ela, o tablet exige internet (como hoje) e o computador da Elgin é a reserva.

Toda regra nova ganha teste em `dev/tests/`. As migrations são novas (0008 em diante); nenhuma já aplicada é editada.

### 11.10 A confirmar com o dono
- Backup sem o espelho em PDF (11.7) — antes da fase 4.
- Quem será o dono da pasta no Google Drive do RH (e-mail da conta que compartilha a pasta) — antes da fase 4.

Decidido em 26/09/2026 (depois): reconhecimento facial com o rosto identificando e o PIN como reserva; não reconhecido pede PIN; prova de vida às vezes (1 em 3, sorteada no servidor). Aviso formal aos funcionários dispensado.

Decididos na revisão de 26/09/2026: relógio divergente acima de 5 min; atraso de envio acima de 24 h só como alerta; fotos por 2 anos (até 5); PIN sem internet cifrado com chave pública; aviso no WhatsApp de estação fora do ar.

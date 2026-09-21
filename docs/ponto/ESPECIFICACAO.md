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
Celular do funcionário, geolocalização, foto/biometria, integração com o gerador de escala, assinatura ICP-Brasil, AFD/AEJ oficiais, venda a terceiros, múltiplos administradores.

## 9. Estado da implementação (21/09/2026)

- **Banco:** migrations 0001–0007 **aplicadas** no Supabase do Saas Financeiro (schema `ponto`; schemas `financeiro` e `assistente` intactos). Verificado: `anon` só executa `public.ponto_rpc`; todas as tabelas com RLS.
- **Frontend:** estação (`/pontoeletronico/`) e painel (`/pontoeletronico/admin/`) **no ar desde 21/09/2026** (commit `8e339e1`), com a chave `anon` configurada e a conta do gestor criada.
- **Feito depois, ainda só local (sem `git push`):** só o gestor desvincula computador; impressão automática do comprovante (Elgin i9); espelho novo (A.N., banco acumulado, carga horária). A migration 0007 (espelho) já está no banco real e é compatível com o frontend publicado.
- **Testes:** 92 automáticos passando (apuração, segurança, telas).
- **Primeiro acesso:** o admin foi criado pela própria página com um código de uso único (só o hash fica no banco), para a senha nunca passar por terceiros.

## 10. Pontos a confirmar com o dono
- `incompleto` versus `falta` quando falta só uma marcação (regra do item 5.4).
- Tempo de bloqueio do PIN (5 min) e limite de tentativas (5).
- Se o intervalo real maior que o previsto deve entrar no banco (hoje entra: desconta do trabalhado).

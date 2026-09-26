// Painel de gestão do ponto eletrônico (uma conta de administrador).
(function () {
  const { rpc, msgErro, esc, hora, dataHora, dataBR, DIAS_SEMANA, MESES, min, TIPOS, hojeISO } = window.Ponto;
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const SESSAO_KEY = 'ponto_admin_sessao';

  const S = { sessao: null, empresas: [], empresa: null, funcs: [], tab: 'funcionarios' };

  const store = {
    get() { try { return sessionStorage.getItem(SESSAO_KEY); } catch (e) { return null; } },
    set(v) { try { v ? sessionStorage.setItem(SESSAO_KEY, v) : sessionStorage.removeItem(SESSAO_KEY); } catch (e) {} }
  };

  const SITUACAO = { folga: 'Folga', trabalho: 'Trabalhado', falta: 'FALTA', incompleto: 'Incompleto', em_andamento: 'Em andamento', compensado: 'Compensação' };
  const MOTIVO = { folga_domingo: 'Domingo de folga', dia_liberado: 'Dia liberado', atestado: 'Atestado', ferias: 'Férias', licenca: 'Licença',
    feriado: 'Feriado', trabalho_folga: 'Trabalho em dia de folga', compensacao: 'Compensação', troca_horario: 'Horário trocado' };
  const ALERTA = { tolerancia_aplicada: 'Tolerância CLT aplicada', tolerancia_excedida: 'Tolerância excedida (>10 min)', intervalo_curto: 'Intervalo menor que o previsto',
    sem_intervalo: 'Sem marcação de intervalo', sem_saida: 'Sem saída', sem_volta_intervalo: 'Sem volta do intervalo',
    marcacao_sem_entrada: 'Marcação sem entrada', mais_de_uma_jornada: 'Mais de uma jornada no dia' };
  const TIPOS_EXCECAO = { folga_domingo: 'Domingo de folga', dia_liberado: 'Dia liberado (abono)', trabalho_folga: 'Trabalho em dia de folga',
    troca_horario: 'Troca de horário', compensacao: 'Compensação (abate o banco)', atestado: 'Atestado', ferias: 'Férias', licenca: 'Licença', feriado: 'Feriado da empresa' };

  /* ---------- utilitários ---------- */
  function toast(txt) {
    const t = $('toast'); t.textContent = txt; t.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3000);
  }
  const msg = (txt, tipo) => txt ? '<div class="msg ' + (tipo || 'erro') + '">' + esc(txt) + '</div>' : '';
  const opts = (obj, sel) => Object.keys(obj).map((k) => '<option value="' + esc(k) + '"' + (k === sel ? ' selected' : '') + '>' + esc(obj[k]) + '</option>').join('');
  const funcOpts = (sel, extra) => (extra || '') + S.funcs.map((f) => '<option value="' + f.id + '"' + (String(f.id) === String(sel) ? ' selected' : '') + '>' + esc(f.nome) + '</option>').join('');
  const val = (id) => { const e = $(id); return e ? e.value.trim() : ''; };
  const mesAtual = () => hojeISO().slice(0, 7);
  const ultimoDia = (ym) => { const [a, m] = ym.split('-').map(Number); return new Date(a, m, 0).getDate(); };
  const saldoTxt = (m) => '<span class="' + (m > 0 ? 'pos' : m < 0 ? 'neg' : '') + '">' + esc(min(m, true)) + '</span>';

  // "1:30", "-0:20", "90" -> minutos
  function parseMin(s) {
    s = String(s || '').trim();
    if (!s) return 0;
    const m = s.match(/^([+-]?)(\d+)(?::([0-5]?\d))?$/);
    if (!m) return null;
    const total = m[3] !== undefined ? Number(m[2]) * 60 + Number(m[3]) : Number(m[2]);
    return m[1] === '-' ? -total : total;
  }

  async function chamar(fn, args) {
    const r = await rpc(fn, Object.assign({ sessao: S.sessao }, args || {}));
    if (!r.ok && r.erro === 'sessao_invalida') { sair(true); }
    return r;
  }

  /* ---------- entrada: primeiro acesso / login ---------- */
  async function iniciar() {
    if (!window.PONTO_CONFIG || String(window.PONTO_CONFIG.anonKey).startsWith('COLE_AQUI')) {
      app.innerHTML = msg('Sistema ainda não configurado.'); return;
    }
    const st = await rpc('admin_status');
    if (!st.ok) { app.innerHTML = msg(msgErro(st.erro)); return; }
    if (st.precisa_primeiro_acesso) return telaPrimeiroAcesso();
    const s = store.get();
    if (s) {
      S.sessao = s;
      if (await carregarBase()) return telaPrincipal();
      S.sessao = null;
    }
    telaLogin();
  }

  function telaPrimeiroAcesso(erro) {
    app.innerHTML = '<div class="card" style="max-width:460px;margin:2rem auto"><h2>Primeiro acesso</h2>' +
      '<p class="muted" style="margin-bottom:12px">Crie o acesso do gestor com o código de instalação fornecido. Ele vale uma única vez.</p>' + msg(erro) +
      '<div class="field"><label for="pa-cod">Código de instalação</label><input id="pa-cod" autocomplete="off"></div>' +
      '<div class="field" style="margin-top:10px"><label for="pa-mail">E-mail</label><input id="pa-mail" type="email" autocomplete="username"></div>' +
      '<div class="field" style="margin-top:10px"><label for="pa-s1">Senha (mínimo 10 caracteres)</label><input id="pa-s1" type="password" autocomplete="new-password"></div>' +
      '<div class="field" style="margin-top:10px"><label for="pa-s2">Repita a senha</label><input id="pa-s2" type="password" autocomplete="new-password"></div>' +
      '<div style="margin-top:14px"><button class="btn pri" id="pa-ok">Criar acesso</button></div></div>';
    $('pa-ok').onclick = async () => {
      if ($('pa-s1').value !== $('pa-s2').value) return telaPrimeiroAcesso('As senhas não conferem.');
      const r = await rpc('admin_primeiro_acesso', { codigo: val('pa-cod'), email: val('pa-mail'), senha: $('pa-s1').value });
      if (!r.ok) return telaPrimeiroAcesso(msgErro(r.erro));
      telaLogin('Acesso criado. Entre com o e-mail e a senha.', 'ok');
    };
  }

  function telaLogin(aviso, tipo) {
    $('topo-dir').textContent = '';
    app.innerHTML = '<div class="card" style="max-width:420px;margin:2rem auto"><h2>Entrar</h2>' + msg(aviso, tipo) +
      '<div class="field"><label for="l-mail">E-mail</label><input id="l-mail" type="email" autocomplete="username"></div>' +
      '<div class="field" style="margin-top:10px"><label for="l-senha">Senha</label><input id="l-senha" type="password" autocomplete="current-password"></div>' +
      '<div style="margin-top:14px"><button class="btn pri" id="l-ok">Entrar</button></div></div>';
    const go = async () => {
      const r = await rpc('admin_login', { email: val('l-mail'), senha: $('l-senha').value });
      if (!r.ok) return telaLogin(msgErro(r.erro));
      S.sessao = r.sessao; store.set(r.sessao);
      if (await carregarBase()) telaPrincipal(); else telaLogin('Não foi possível carregar os dados.');
    };
    $('l-ok').onclick = go;
    $('l-senha').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  function sair(expirou) {
    if (S.sessao && !expirou) rpc('admin_logout', { sessao: S.sessao });
    S.sessao = null; store.set(null);
    telaLogin(expirou ? 'Sessão expirada. Entre novamente.' : '');
  }

  async function carregarBase() {
    const r = await chamar('admin_empresas');
    if (!r.ok) return false;
    S.empresas = r.empresas;
    if (!S.empresa || !S.empresas.some((e) => e.id === S.empresa)) S.empresa = S.empresas.length ? S.empresas[0].id : null;
    await carregarFuncs();
    return true;
  }
  async function carregarFuncs() {
    if (!S.empresa) { S.funcs = []; return; }
    const r = await chamar('admin_funcionarios', { empresa_id: S.empresa });
    S.funcs = r.ok ? r.funcionarios : [];
  }

  /* ---------- estrutura principal ---------- */
  const ABAS = { funcionarios: 'Funcionários', calendario: 'Calendário e exceções', correcoes: 'Correções', relatorios: 'Relatórios', config: 'Empresas e estações' };

  async function telaPrincipal() {
    $('topo-dir').innerHTML = '<button class="btn sm" id="b-senha">Trocar senha</button> <button class="btn sm" id="b-sair">Sair</button>';
    $('b-sair').onclick = () => sair(false);
    $('b-senha').onclick = () => telaTrocarSenha();
    const pend = S.empresa ? await contarPendentes() : 0;
    app.innerHTML =
      '<div class="row no-print"><div class="field" style="max-width:280px"><label for="sel-emp">Empresa</label><select id="sel-emp">' +
      S.empresas.map((e) => '<option value="' + e.id + '"' + (e.id === S.empresa ? ' selected' : '') + '>' + esc(e.nome) + '</option>').join('') +
      '</select></div></div>' +
      '<div class="tabs no-print">' + Object.keys(ABAS).map((k) =>
        '<button class="tab' + (k === S.tab ? ' active' : '') + '" data-tab="' + k + '">' + esc(ABAS[k]) +
        (k === 'correcoes' && pend ? ' <span class="badge warn">' + pend + '</span>' : '') + '</button>').join('') + '</div>' +
      '<div id="aba"></div>';
    $('sel-emp').onchange = async (e) => { S.empresa = Number(e.target.value); await carregarFuncs(); telaPrincipal(); };
    app.querySelectorAll('.tab').forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; telaPrincipal(); });
    if (!S.empresas.length && S.tab !== 'config') { S.tab = 'config'; return telaPrincipal(); }
    ({ funcionarios: abaFuncionarios, calendario: abaCalendario, correcoes: abaCorrecoes, relatorios: abaRelatorios, config: abaConfig })[S.tab]();
  }

  async function contarPendentes() {
    const r = await chamar('admin_correcoes', { empresa_id: S.empresa, status: 'pendente' });
    return r.ok ? r.correcoes.length : 0;
  }

  function telaTrocarSenha(erro) {
    app.innerHTML = '<div class="card" style="max-width:420px;margin:1rem auto"><h2>Trocar senha</h2>' + msg(erro) +
      '<div class="field"><label for="ts-a">Senha atual</label><input id="ts-a" type="password" autocomplete="current-password"></div>' +
      '<div class="field" style="margin-top:10px"><label for="ts-n">Nova senha (mínimo 10 caracteres)</label><input id="ts-n" type="password" autocomplete="new-password"></div>' +
      '<div style="margin-top:14px;display:flex;gap:8px"><button class="btn pri" id="ts-ok">Salvar</button><button class="btn" id="ts-x">Voltar</button></div></div>';
    $('ts-x').onclick = telaPrincipal;
    $('ts-ok').onclick = async () => {
      const r = await chamar('admin_trocar_senha', { atual: $('ts-a').value, nova: $('ts-n').value });
      if (!r.ok) return telaTrocarSenha(msgErro(r.erro));
      toast('Senha alterada.'); telaPrincipal();
    };
  }

  /* ---------- aba: funcionários ---------- */
  function resumoJornada(j) {
    if (!j) return '<span class="muted">sem jornada</span>';
    return esc(j.dias_trabalho.map((d) => DIAS_SEMANA[d]).join(', ')) + ' · ' + esc(j.entrada.slice(0, 5)) + '–' + esc(j.saida.slice(0, 5)) + ' · int. ' + esc(j.intervalo_min) + 'min';
  }

  function abaFuncionarios() {
    const el = $('aba');
    el.innerHTML = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="margin:0">Funcionários</h2>' +
      '<button class="btn sm pri" id="novo-f">+ Novo funcionário</button></div>' +
      (S.funcs.length ? '<div class="scroll"><table class="t"><tr><th>Nome</th><th>Jornada</th><th class="n">Banco de horas</th><th>Rosto</th><th>Situação</th><th></th></tr>' +
        S.funcs.map((f) => '<tr><td>' + esc(f.nome) + '</td><td>' + resumoJornada(f.jornada) + '</td><td class="n">' + saldoTxt(f.saldo_banco_min) + '</td><td>' +
          (f.rosto_amostras ? '<span class="badge ok">cadastrado</span>' : '<span class="badge">sem cadastro</span>') + '</td><td>' +
          (!f.ativo ? '<span class="badge">inativo</span>' : f.bloqueado_ate ? '<span class="badge bad">PIN bloqueado</span>' : '<span class="badge ok">ativo</span>') +
          '</td><td class="n"><button class="btn sm" data-ed="' + f.id + '">Editar</button></td></tr>').join('') + '</table></div>'
        : '<p class="muted">Nenhum funcionário nesta empresa.</p>') + '</div><div id="form-f"></div>';
    $('novo-f').onclick = () => formFuncionario(null);
    el.querySelectorAll('[data-ed]').forEach((b) => b.onclick = () => formFuncionario(S.funcs.find((f) => f.id === Number(b.dataset.ed))));
  }

  function formFuncionario(f, erro) {
    const novo = !f;
    const j = f && f.jornada;
    const dias = j ? j.dias_trabalho : [0, 1, 2, 3, 4, 5];
    $('form-f').innerHTML =
      '<div class="card"><h2>' + (novo ? 'Novo funcionário' : 'Editar ' + esc(f.nome)) + '</h2>' + msg(erro) +
      '<div class="row"><div class="field"><label for="f-nome">Nome</label><input id="f-nome" value="' + esc(f ? f.nome : '') + '"></div>' +
      '<div class="field"><label for="f-cpf">CPF (opcional)</label><input id="f-cpf" value="' + esc(f && f.cpf || '') + '"></div>' +
      '<div class="field"><label for="f-pin">' + (novo ? 'PIN (4 a 6 dígitos)' : 'Novo PIN (deixe vazio para manter)') + '</label><input id="f-pin" inputmode="numeric" maxlength="6" autocomplete="off"></div></div>' +
      '<div class="row"><div class="field"><label for="f-saldo">Saldo inicial do banco (h:mm ou minutos; negativo com −)</label><input id="f-saldo" value="' + esc(f ? formatarSaldoInicial(f.saldo_inicial_min) : '0') + '"></div>' +
      '<div class="field"><label for="f-inicio">Controlar a partir de</label><input type="date" id="f-inicio" value="' + esc(f ? f.inicio_controle : hojeISO()) + '"></div>' +
      (novo ? '' : '<div class="field" style="max-width:160px"><label for="f-ativo">Situação</label><select id="f-ativo"><option value="true"' + (f.ativo ? ' selected' : '') + '>Ativo</option><option value="false"' + (!f.ativo ? ' selected' : '') + '>Inativo</option></select></div>') + '</div>' +
      '<div><button class="btn pri" id="f-salvar">Salvar dados</button></div>' +
      (novo ? '<p class="muted" style="margin-top:8px">Depois de salvar, defina a jornada.</p>' : formJornadaHtml(f, dias, j) + formRostoHtml(f)) + '</div>';
    $('f-salvar').onclick = async () => {
      const saldo = parseMin(val('f-saldo'));
      if (saldo === null) return formFuncionario(f, 'Saldo inicial inválido. Use 1:30, -0:20 ou minutos.');
      const args = { empresa_id: S.empresa, nome: val('f-nome'), cpf: val('f-cpf'), pin: val('f-pin'), saldo_inicial_min: saldo, inicio_controle: val('f-inicio') || null };
      if (!novo) { args.id = f.id; args.ativo = val('f-ativo') === 'true'; }
      const r = await chamar('admin_salvar_funcionario', args);
      if (!r.ok) return formFuncionario(f, msgErro(r.erro));
      await carregarFuncs(); toast('Funcionário salvo.');
      if (novo) { abaFuncionarios(); formFuncionario(S.funcs.find((x) => x.id === r.id)); } else abaFuncionarios();
    };
    if (!novo) {
      $('r-cadastrar').onclick = () => cadastrarRosto(f);
      if ($('r-apagar')) $('r-apagar').onclick = async () => {
        if (!confirm('Apagar o cadastro do rosto de ' + f.nome + '? Ele passa a marcar só pelo PIN.')) return;
        const r = await chamar('admin_apagar_rosto', { funcionario_id: f.id });
        if (!r.ok) return toast(msgErro(r.erro));
        await carregarFuncs(); toast('Cadastro do rosto apagado.'); abaFuncionarios();
      };
      $('j-salvar').onclick = async () => {
        const dsel = [...document.querySelectorAll('.j-dia:checked')].map((c) => Number(c.value));
        const r = await chamar('admin_salvar_jornada', { funcionario_id: f.id, vigencia_inicio: val('j-vig'), dias_trabalho: dsel,
          entrada: val('j-ent'), saida: val('j-sai'), intervalo_min: Number(val('j-int') || 15) });
        if (!r.ok) return formFuncionario(f, msgErro(r.erro));
        await carregarFuncs(); toast('Jornada salva.'); abaFuncionarios();
      };
    }
  }
  function formRostoHtml(f) {
    return '<hr style="border:none;border-top:.5px solid var(--line);margin:16px 0"><h3>Rosto (reconhecimento facial)</h3>' +
      '<p class="muted" style="margin-bottom:8px">' + (f.rosto_amostras
        ? 'Cadastrado em ' + esc(dataHora(f.rosto_em)) + ' (' + esc(f.rosto_amostras) + ' posições).'
        : 'Sem cadastro: marca pelo PIN.') +
      ' Faça o cadastro <b>no próprio tablet</b> (mesma câmera e luz do dia a dia).</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn pri" id="r-cadastrar"><i class="ti ti-face-id"></i> ' + (f.rosto_amostras ? 'Refazer cadastro' : 'Cadastrar rosto') + '</button>' +
      (f.rosto_amostras ? '<button class="btn bad" id="r-apagar">Apagar cadastro</button>' : '') + '</div><div id="r-area"></div>';
  }

  // Cadastro do rosto: 5 posições (frente, dois lados, para cima e para baixo), cada uma só com rosto
  // único, perto, com prova de vida e parado por 2 análises. Os lados não dependem de esquerda/direita
  // da imagem: basta que o segundo seja para o lado oposto ao primeiro.
  const POSES = [
    { id: 'frente', txt: 'Olhe de frente para a câmera', ok: (r) => Math.abs(r.yaw) < 0.15 && Math.abs(r.pitch) < 0.15 },
    { id: 'lado_a', txt: 'Vire o rosto um pouco para um lado', ok: (r) => Math.abs(r.yaw) > 0.2 },
    { id: 'lado_b', txt: 'Agora um pouco para o outro lado', ok: (r, am) => Math.abs(r.yaw) > 0.2 && Math.sign(r.yaw) !== Math.sign(am.lado_a.yaw) },
    { id: 'vertical_a', txt: 'Levante um pouco o queixo', ok: (r) => Math.abs(r.pitch) > 0.15 },
    { id: 'vertical_b', txt: 'Agora abaixe um pouco o queixo', ok: (r, am) => Math.abs(r.pitch) > 0.15 && Math.sign(r.pitch) !== Math.sign(am.vertical_a.pitch) }
  ];
  const CADASTRO_INTERVALO_MS = Number((window.PONTO_CONFIG || {}).totemIntervaloMs) || 250;

  async function cadastrarRosto(f) {
    const area = $('r-area');
    let ativo = true, laco = null, estavel = 0;
    const amostras = {};
    area.innerHTML = '<div class="cad-rosto"><div class="cad-cam" id="cad-cam"></div><div>' +
      '<div class="cad-passos">' + POSES.map((p, i) => '<span class="cad-passo" data-i="' + i + '">' + (i + 1) + '</span>').join('') + '</div>' +
      '<div class="cad-txt" id="cad-txt">Ligando a câmera…</div><div class="muted" id="cad-dica"></div>' +
      '<div style="margin-top:10px"><button class="btn" id="cad-x">Cancelar</button></div></div></div>';
    const txt = (t, dica) => { $('cad-txt').textContent = t; $('cad-dica').textContent = dica || ''; };
    const fim = () => { ativo = false; clearTimeout(laco); window.PontoFoto.desligar(); };
    $('cad-x').onclick = () => { fim(); area.innerHTML = ''; };
    if (!(await window.PontoFoto.ligar($('cad-cam')))) { fim(); return txt('Câmera indisponível.', 'Libere a câmera no navegador e tente de novo.'); }
    txt('Carregando o reconhecimento…');
    try { await window.PontoRosto.iniciar(); } catch (e) { fim(); return txt('Reconhecimento indisponível neste aparelho.'); }
    let i = 0;
    const marcar = () => area.querySelectorAll('.cad-passo').forEach((el, k) => { el.className = 'cad-passo' + (k < i ? ' feito' : k === i ? ' atual' : ''); });
    marcar(); txt(POSES[0].txt);
    const passo = async () => {
      if (!ativo) return;
      let a = null;
      try { a = await window.PontoRosto.analisar(window.PontoFoto.video()); } catch (e) { a = null; }
      if (!ativo) return;
      const pose = POSES[i];
      let dica = '';
      if (!a || !a.rostos) dica = 'Nenhum rosto na câmera.';
      else if (a.rostos > 1) dica = 'Só uma pessoa na frente da câmera.';
      else if (a.rosto.largura < 0.15) dica = 'Chegue mais perto.';
      else if ((a.rosto.antispoof || 0) < 0.5 || (a.rosto.liveness || 0) < 0.5) dica = 'Rosto não confirmado como real: melhore a luz e olhe para a câmera.';
      else if (!a.rosto.descritor) dica = 'Não consegui ler o rosto.';
      else if (!pose.ok(a.rosto, amostras)) dica = '';
      else if (++estavel >= 2) {
        amostras[pose.id] = a.rosto; estavel = 0; i++; marcar();
        if (i === POSES.length) {
          fim(); txt('Salvando…');
          const r = await chamar('admin_salvar_rosto', { funcionario_id: f.id,
            amostras: POSES.map((p) => ({ posicao: p.id, descritor: amostras[p.id].descritor })) });
          if (!r.ok) return txt(msgErro(r.erro));
          await carregarFuncs(); toast('Rosto de ' + f.nome + ' cadastrado.');
          return formFuncionario(S.funcs.find((x) => x.id === f.id));
        }
        txt(POSES[i].txt);
      }
      if (dica) estavel = 0;
      $('cad-dica').textContent = dica;
      laco = setTimeout(passo, CADASTRO_INTERVALO_MS);
    };
    passo();
  }

  function formatarSaldoInicial(m) { return m ? (m < 0 ? '-' : '') + Math.floor(Math.abs(m) / 60) + ':' + String(Math.abs(m) % 60).padStart(2, '0') : '0'; }
  function formJornadaHtml(f, dias, j) {
    return '<hr style="border:none;border-top:.5px solid var(--line);margin:16px 0"><h3>Jornada</h3>' +
      '<p class="muted" style="margin-bottom:8px">A carga esperada é (saída − entrada) − intervalo. Ex.: 10:00 às 16:15 com 15 min = 6h. Uma nova vigência vale a partir da data informada; as anteriores continuam valendo para o passado.</p>' +
      '<div class="row">' + DIAS_SEMANA.map((d, i) => '<label style="display:flex;gap:4px;align-items:center"><input type="checkbox" class="j-dia" value="' + i + '"' + (dias.includes(i) ? ' checked' : '') + '> ' + d + '</label>').join('') + '</div>' +
      '<div class="row"><div class="field"><label for="j-ent">Entrada</label><input type="time" id="j-ent" value="' + esc(j ? j.entrada.slice(0, 5) : '10:00') + '"></div>' +
      '<div class="field"><label for="j-sai">Saída</label><input type="time" id="j-sai" value="' + esc(j ? j.saida.slice(0, 5) : '16:15') + '"></div>' +
      '<div class="field"><label for="j-int">Intervalo (min)</label><input type="number" id="j-int" min="0" max="240" value="' + esc(j ? j.intervalo_min : 15) + '"></div>' +
      '<div class="field"><label for="j-vig">Vale a partir de</label><input type="date" id="j-vig" value="' + hojeISO() + '"></div></div>' +
      '<button class="btn pri" id="j-salvar">Salvar jornada</button>';
  }

  /* ---------- aba: calendário e exceções ---------- */
  function domingosDoMes(ym) {
    const [a, m] = ym.split('-').map(Number); const out = [];
    for (let d = 1; d <= ultimoDia(ym); d++) if (new Date(a, m - 1, d).getDay() === 0) out.push(ym + '-' + String(d).padStart(2, '0'));
    return out;
  }

  async function abaCalendario(mes, funcSel) {
    mes = mes || mesAtual();
    funcSel = funcSel || (S.funcs[0] && S.funcs[0].id);
    const ini = mes + '-01', fim = mes + '-' + ultimoDia(mes);
    const r = await chamar('admin_excecoes', { empresa_id: S.empresa, ini, fim });
    const exc = r.ok ? r.excecoes : [];
    const doms = domingosDoMes(mes);
    const marcados = new Set(exc.filter((e) => e.tipo === 'folga_domingo' && e.funcionario_id === Number(funcSel)).map((e) => e.data_ini));

    $('aba').innerHTML =
      '<div class="card"><h2>Mês</h2><div class="row"><div class="field" style="max-width:200px"><label for="cal-mes">Mês</label><input type="month" id="cal-mes" value="' + esc(mes) + '"></div></div></div>' +

      '<div class="card"><h2>Domingos de folga</h2><p class="muted" style="margin-bottom:8px">Marque os domingos em que o funcionário folga neste mês. Salvar substitui a escolha anterior do mês.</p>' +
      '<div class="row"><div class="field" style="max-width:260px"><label for="dom-f">Funcionário</label><select id="dom-f">' + funcOpts(funcSel) + '</select></div></div>' +
      '<div class="row">' + doms.map((d) => '<label style="display:flex;gap:6px;align-items:center;border:.5px solid var(--line);border-radius:8px;padding:6px 10px"><input type="checkbox" class="dom-c" value="' + d + '"' + (marcados.has(d) ? ' checked' : '') + '> ' + esc(dataBR(d)) + '</label>').join('') + '</div>' +
      '<button class="btn pri" id="dom-salvar"' + (S.funcs.length ? '' : ' disabled') + '>Salvar domingos</button></div>' +

      '<div class="card"><h2>Trocar dia de folga</h2><p class="muted" style="margin-bottom:8px">O funcionário passa a folgar no dia novo e trabalha no dia em que normalmente folgaria.</p>' +
      '<div class="row"><div class="field"><label for="tf-f">Funcionário</label><select id="tf-f">' + funcOpts(funcSel) + '</select></div>' +
      '<div class="field"><label for="tf-novo">Novo dia de folga</label><input type="date" id="tf-novo"></div>' +
      '<div class="field"><label for="tf-antigo">Dia de folga original (vai trabalhar)</label><input type="date" id="tf-antigo"></div>' +
      '<div class="field"><label for="tf-mot">Motivo</label><input id="tf-mot"></div></div><button class="btn pri" id="tf-salvar">Trocar folga</button></div>' +

      '<div class="card"><h2>Nova exceção</h2><div class="row">' +
      '<div class="field"><label for="ex-tipo">Tipo</label><select id="ex-tipo">' + opts(TIPOS_EXCECAO, 'dia_liberado') + '</select></div>' +
      '<div class="field" id="ex-f-box"><label for="ex-f">Funcionário</label><select id="ex-f">' + funcOpts(funcSel) + '</select></div>' +
      '<div class="field"><label for="ex-ini">De</label><input type="date" id="ex-ini" value="' + hojeISO() + '"></div>' +
      '<div class="field"><label for="ex-fim">Até (vazio = 1 dia)</label><input type="date" id="ex-fim"></div></div>' +
      '<div class="row" id="ex-extra"></div>' +
      '<div class="row"><div class="field"><label for="ex-mot">Motivo</label><input id="ex-mot"></div></div>' +
      '<button class="btn pri" id="ex-salvar">Adicionar exceção</button></div>' +

      '<div class="card"><h2>Exceções de ' + esc(MESES[Number(mes.slice(5, 7)) - 1]) + '/' + esc(mes.slice(0, 4)) + '</h2>' +
      (exc.length ? '<div class="scroll"><table class="t"><tr><th>Tipo</th><th>Quem</th><th>Período</th><th>Detalhe</th><th></th></tr>' +
        exc.map((e) => '<tr><td>' + esc(TIPOS_EXCECAO[e.tipo] || e.tipo) + '</td><td>' + esc(e.funcionario || 'Toda a empresa') + '</td><td>' + esc(dataBR(e.data_ini)) +
          (e.data_fim !== e.data_ini ? ' a ' + esc(dataBR(e.data_fim)) : '') + '</td><td>' +
          esc([e.entrada && e.saida ? e.entrada.slice(0, 5) + '–' + e.saida.slice(0, 5) : '', e.minutos ? e.minutos + ' min' : '', e.motivo || ''].filter(Boolean).join(' · ')) +
          '</td><td class="n"><button class="btn sm bad" data-canc="' + e.id + '">Cancelar</button></td></tr>').join('') + '</table></div>'
        : '<p class="muted">Nenhuma exceção neste mês.</p>') + '</div>';

    $('cal-mes').onchange = (e) => e.target.value && abaCalendario(e.target.value, funcSel);
    $('dom-f').onchange = (e) => abaCalendario(mes, e.target.value);
    $('dom-salvar').onclick = async () => {
      const r2 = await chamar('admin_domingos', { funcionario_id: Number(val('dom-f')), mes: ini, domingos: [...document.querySelectorAll('.dom-c:checked')].map((c) => c.value) });
      if (!r2.ok) return toast(msgErro(r2.erro));
      toast('Domingos salvos.'); abaCalendario(mes, val('dom-f'));
    };
    $('tf-salvar').onclick = async () => {
      if (!val('tf-novo') || !val('tf-antigo')) return toast('Informe os dois dias.');
      const r2 = await chamar('admin_trocar_folga', { funcionario_id: Number(val('tf-f')), dia_novo: val('tf-novo'), dia_antigo: val('tf-antigo'), motivo: val('tf-mot') });
      if (!r2.ok) return toast(msgErro(r2.erro));
      toast('Folga trocada.'); abaCalendario(mes, funcSel);
    };
    const ajustarExtra = () => {
      const t = val('ex-tipo');
      $('ex-f-box').classList.toggle('hidden', t === 'feriado');
      $('ex-extra').innerHTML = t === 'troca_horario'
        ? '<div class="field"><label for="ex-ent">Entrada</label><input type="time" id="ex-ent"></div><div class="field"><label for="ex-sai">Saída</label><input type="time" id="ex-sai"></div>'
        : t === 'compensacao'
          ? '<div class="field"><label for="ex-min">Minutos a compensar (vazio = dia inteiro)</label><input type="number" id="ex-min" min="1"></div>' : '';
    };
    $('ex-tipo').onchange = ajustarExtra; ajustarExtra();
    $('ex-salvar').onclick = async () => {
      const t = val('ex-tipo');
      const args = { tipo: t, data_ini: val('ex-ini'), data_fim: val('ex-fim') || val('ex-ini'), motivo: val('ex-mot') };
      if (t === 'feriado') args.empresa_id = S.empresa; else args.funcionario_id = Number(val('ex-f'));
      if (t === 'troca_horario') { args.entrada = val('ex-ent'); args.saida = val('ex-sai'); }
      if (t === 'compensacao') args.minutos = val('ex-min') || null;
      const r2 = await chamar('admin_criar_excecao', args);
      if (!r2.ok) return toast(msgErro(r2.erro));
      toast('Exceção adicionada.'); abaCalendario(mes, funcSel);
    };
    $('aba').querySelectorAll('[data-canc]').forEach((b) => b.onclick = async () => {
      if (!confirm('Cancelar esta exceção? (a troca de folga cancela as duas pontas)')) return;
      const r2 = await chamar('admin_cancelar_excecao', { id: Number(b.dataset.canc) });
      if (!r2.ok) return toast(msgErro(r2.erro));
      toast('Exceção cancelada.'); abaCalendario(mes, funcSel);
    });
  }

  /* ---------- aba: correções ---------- */
  async function abaCorrecoes() {
    const r = await chamar('admin_correcoes', { empresa_id: S.empresa });
    const todas = r.ok ? r.correcoes : [];
    const pend = todas.filter((c) => c.status === 'pendente');
    const hist = todas.filter((c) => c.status !== 'pendente').slice(0, 30);
    const desc = (c) => c.tipo === 'incluir' ? 'Incluir ' + (TIPOS[c.tipo_marcacao] || '').toLowerCase() + ' em ' + dataHora(c.marcado_em) : 'Desconsiderar marcação #' + c.marcacao_id;

    $('aba').innerHTML =
      '<div class="card"><h2>Pedidos aguardando decisão</h2>' +
      (pend.length ? '<div class="scroll"><table class="t"><tr><th>Funcionário</th><th>Pedido</th><th>Motivo</th><th>Feito em</th><th></th></tr>' +
        pend.map((c) => '<tr><td>' + esc(c.funcionario) + '</td><td>' + esc(desc(c)) + '</td><td>' + esc(c.motivo) + '</td><td>' + esc(dataHora(c.criado_em)) +
          '</td><td class="n"><button class="btn sm ok" data-ap="' + c.id + '">Aprovar</button> <button class="btn sm bad" data-rec="' + c.id + '">Recusar</button></td></tr>').join('') + '</table></div>'
        : '<p class="muted">Nenhum pedido pendente.</p>') + '</div>' +

      '<div class="card"><h2>Lançar correção</h2><p class="muted" style="margin-bottom:8px">A marcação original nunca é apagada: a correção acrescenta ou desconsidera, com motivo registrado.</p>' +
      '<div class="row"><div class="field"><label for="nc-f">Funcionário</label><select id="nc-f">' + funcOpts() + '</select></div>' +
      '<div class="field"><label for="nc-tipo">O que fazer</label><select id="nc-tipo"><option value="incluir">Incluir marcação esquecida</option><option value="desconsiderar">Desconsiderar marcação indevida</option></select></div></div>' +
      '<div class="row" id="nc-campos"></div>' +
      '<div class="row"><div class="field"><label for="nc-mot">Motivo (obrigatório)</label><input id="nc-mot"></div></div>' +
      '<button class="btn pri" id="nc-ok"' + (S.funcs.length ? '' : ' disabled') + '>Lançar</button></div>' +

      '<div class="card"><h2>Histórico recente</h2>' +
      (hist.length ? '<div class="scroll"><table class="t"><tr><th>Funcionário</th><th>Correção</th><th>Origem</th><th>Situação</th><th>Motivo / decisão</th></tr>' +
        hist.map((c) => '<tr><td>' + esc(c.funcionario) + '</td><td>' + esc(desc(c)) + '</td><td>' + esc(c.origem === 'admin' ? 'Gestor' : 'Funcionário') + '</td><td><span class="badge ' +
          (c.status === 'aprovado' ? 'ok' : 'bad') + '">' + esc(c.status) + '</span></td><td>' + esc(c.motivo + (c.decisao_motivo ? ' → ' + c.decisao_motivo : '')) + '</td></tr>').join('') + '</table></div>'
        : '<p class="muted">Sem histórico.</p>') + '</div>';

    const campos = async () => {
      const t = val('nc-tipo');
      if (t === 'incluir') {
        $('nc-campos').innerHTML = '<div class="field"><label for="nc-mt">Marcação</label><select id="nc-mt">' + opts(TIPOS) + '</select></div>' +
          '<div class="field"><label for="nc-d">Dia</label><input type="date" id="nc-d" value="' + hojeISO() + '"></div>' +
          '<div class="field"><label for="nc-h">Horário</label><input type="time" id="nc-h"></div>';
      } else {
        $('nc-campos').innerHTML = '<div class="field"><label for="nc-d">Dia</label><input type="date" id="nc-d" value="' + hojeISO() + '"></div>' +
          '<div class="field"><label for="nc-m">Marcação</label><select id="nc-m"><option value="">— escolha o dia —</option></select></div>';
        const carregar = async () => {
          if (!val('nc-f') || !val('nc-d')) return;
          const m = await chamar('admin_marcacoes', { funcionario_id: Number(val('nc-f')), ini: val('nc-d'), fim: val('nc-d') });
          $('nc-m').innerHTML = m.ok && m.marcacoes.length
            ? m.marcacoes.filter((x) => !x.desconsiderada).map((x) => '<option value="' + x.id + '">' + esc(hora(x.marcado_em) + ' · ' + TIPOS[x.tipo] + ' (NSR ' + x.nsr + ')') + '</option>').join('')
            : '<option value="">Nenhuma marcação neste dia</option>';
        };
        $('nc-d').onchange = carregar; $('nc-f').onchange = carregar; carregar();
      }
    };
    $('nc-tipo').onchange = campos; campos();
    $('nc-ok').onclick = async () => {
      const t = val('nc-tipo');
      const args = { funcionario_id: Number(val('nc-f')), tipo: t, motivo: val('nc-mot') };
      if (t === 'incluir') {
        if (!val('nc-d') || !val('nc-h')) return toast('Informe dia e horário.');
        args.tipo_marcacao = val('nc-mt'); args.marcado_em = val('nc-d') + 'T' + val('nc-h');
      } else {
        if (!val('nc-m')) return toast('Escolha a marcação.');
        args.marcacao_id = Number(val('nc-m'));
      }
      const r2 = await chamar('admin_criar_correcao', args);
      if (!r2.ok) return toast(msgErro(r2.erro));
      toast('Correção lançada.'); telaPrincipal();
    };
    const decidir = async (id, aprovar) => {
      let motivo = '';
      if (!aprovar) { motivo = prompt('Motivo da recusa (opcional):') || ''; }
      const r2 = await chamar('admin_decidir_correcao', { id, aprovar, motivo });
      if (!r2.ok) return toast(msgErro(r2.erro));
      toast(aprovar ? 'Correção aprovada.' : 'Correção recusada.'); telaPrincipal();
    };
    $('aba').querySelectorAll('[data-ap]').forEach((b) => b.onclick = () => decidir(Number(b.dataset.ap), true));
    $('aba').querySelectorAll('[data-rec]').forEach((b) => b.onclick = () => decidir(Number(b.dataset.rec), false));
  }

  /* ---------- aba: relatórios ---------- */
  function abaRelatorios(estado) {
    estado = estado || { mes: mesAtual(), func: S.funcs[0] && S.funcs[0].id, rel: 'espelho' };
    $('aba').innerHTML =
      '<div class="card no-print"><h2>Relatório</h2><div class="row">' +
      '<div class="field"><label for="r-tipo">Relatório</label><select id="r-tipo">' +
      opts({ espelho: 'Espelho de ponto (mensal)', marcacoes: 'Marcações e fotos', banco: 'Banco de horas', faltas: 'Lista de faltas (empresa)' }, estado.rel) + '</select></div>' +
      '<div class="field" id="r-f-box"><label for="r-f">Funcionário</label><select id="r-f">' + funcOpts(estado.func) + '</select></div>' +
      '<div class="field"><label for="r-mes">Mês</label><input type="month" id="r-mes" value="' + esc(estado.mes) + '"></div>' +
      '<button class="btn pri" id="r-ok">Gerar</button></div></div><div id="rel" class="print-area"></div>';
    const ajusta = () => $('r-f-box').classList.toggle('hidden', val('r-tipo') === 'faltas');
    $('r-tipo').onchange = ajusta; ajusta();
    $('r-ok').onclick = () => gerarRelatorio({ mes: val('r-mes'), func: Number(val('r-f')), rel: val('r-tipo') });
    if (S.funcs.length) gerarRelatorio(estado);
  }

  async function gerarRelatorio(e) {
    const el = $('rel'); el.innerHTML = '<p class="muted">Gerando…</p>';
    const ini = e.mes + '-01', fim = e.mes + '-' + ultimoDia(e.mes);
    const titulo = MESES[Number(e.mes.slice(5, 7)) - 1] + ' de ' + e.mes.slice(0, 4);

    if (e.rel === 'faltas') {
      const r = await chamar('admin_faltas', { empresa_id: S.empresa, ini, fim });
      if (!r.ok) return el.innerHTML = msg(msgErro(r.erro));
      el.innerHTML = '<div class="card"><h2>Faltas — ' + esc(titulo) + '</h2>' +
        (r.funcionarios.length ? '<table class="t"><tr><th>Funcionário</th><th class="n">Faltas</th><th>Datas</th></tr>' +
          r.funcionarios.map((f) => '<tr><td>' + esc(f.nome) + '</td><td class="n"><b>' + esc(f.total) + '</b></td><td>' + esc(f.datas.map(dataBR).join(', ')) + '</td></tr>').join('') + '</table>'
          : '<p class="muted">Nenhuma falta no período.</p>') +
        '<p class="muted" style="margin-top:8px">Falta de dia inteiro não altera o banco de horas. O desconto do dia (e do DSR) é feito na folha.</p></div>';
      return;
    }

    if (e.rel === 'marcacoes') {
      const r = await chamar('admin_marcacoes_fotos', { funcionario_id: e.func, ini, fim });
      if (!r.ok) return el.innerHTML = msg(msgErro(r.erro));
      const nome = (S.funcs.find((f) => f.id === e.func) || {}).nome || '';
      const comFoto = r.marcacoes.filter((m) => m.foto === 'foto').map((m) => m.id);
      const urls = await window.Ponto.fotos(S.sessao, comFoto);
      const SIT = { sem_foto: ['bad', 'sem foto (câmera falhou)'], foto_nao_recebida: ['warn', 'foto não chegou'], apagada: ['', 'foto apagada (prazo)'], nenhuma: ['', 'estação sem câmera'] };
      const celFoto = (m) => {
        if (m.foto === 'foto') return urls[m.id]
          ? '<a href="' + esc(urls[m.id]) + '" target="_blank" rel="noopener"><img class="foto-mini" src="' + esc(urls[m.id]) + '" alt="Foto da marcação ' + esc(m.nsr) + '"></a>'
          : '<span class="badge">foto indisponível</span>';
        const s = SIT[m.foto] || ['', m.foto];
        return '<span class="badge ' + s[0] + '">' + esc(s[1]) + '</span>';
      };
      el.innerHTML = '<div class="card"><h2>Marcações e fotos — ' + esc(nome) + ' — ' + esc(titulo) + '</h2>' +
        (r.marcacoes.length ? '<div class="scroll"><table class="t"><tr><th>Data/hora</th><th>Marcação</th><th class="n">NSR</th><th>Estação</th><th>Identificação</th><th>Foto</th></tr>' +
          r.marcacoes.map((m) => '<tr' + (m.desconsiderada ? ' class="folga"' : '') + '><td>' + esc(dataHora(m.marcado_em)) + '</td><td>' + esc(TIPOS[m.tipo]) +
            (m.desconsiderada ? ' <span class="badge">desconsiderada</span>' : '') + '</td><td class="n">' + esc(m.nsr) + '</td><td>' + esc(m.estacao) + '</td><td>' +
            (m.origem === 'rosto' ? '<span class="badge ok">rosto</span>' : m.sem_rosto ? '<span class="badge warn">PIN sem rosto</span>' : m.origem === 'pin' ? 'PIN' : '–') +
            '</td><td>' + celFoto(m) + '</td></tr>').join('') + '</table></div>'
          : '<p class="muted">Nenhuma marcação no mês.</p>') +
        '<p class="muted" style="margin-top:8px">Clique na foto para ampliar. Os links valem 5 minutos; gere o relatório de novo se expirarem.</p></div>';
      return;
    }

    if (e.rel === 'banco') {
      const r = await chamar('admin_banco', { funcionario_id: e.func, ini, fim });
      if (!r.ok) return el.innerHTML = msg(msgErro(r.erro));
      const nome = (S.funcs.find((f) => f.id === e.func) || {}).nome || '';
      el.innerHTML = '<div class="card"><h2>Banco de horas — ' + esc(nome) + ' — ' + esc(titulo) + '</h2>' +
        '<p style="margin-bottom:10px">Saldo anterior: ' + saldoTxt(r.saldo_anterior_min) + ' &nbsp;·&nbsp; Saldo atual: <b>' + saldoTxt(r.saldo_atual_min) + '</b></p>' +
        (r.movimentos.length ? '<div class="scroll"><table class="t"><tr><th>Data</th><th>Situação</th><th class="n">Crédito / débito</th></tr>' +
          r.movimentos.map((m) => '<tr><td>' + esc(dataBR(m.data)) + '</td><td>' + esc(MOTIVO[m.motivo] || SITUACAO[m.status] || m.status) + '</td><td class="n">' + saldoTxt(m.saldo_min) + '</td></tr>').join('') + '</table></div>'
          : '<p class="muted">Sem movimentação no mês.</p>') +
        '<p class="muted" style="margin-top:8px">Banco de horas exige acordo por escrito com o funcionário; este relatório apenas calcula.</p></div>';
      return;
    }

    const r = await chamar('admin_apuracao', { funcionario_id: e.func, ini, fim });
    if (!r.ok) return el.innerHTML = msg(msgErro(r.erro));
    const emp = S.empresas.find((x) => x.id === S.empresa) || {};

    // HH:MM como na planilha; '–' quando não há valor
    const hm = (m) => m == null ? '–' : String(Math.floor(Math.abs(m) / 60)).padStart(2, '0') + ':' + String(Math.abs(m) % 60).padStart(2, '0');
    const hmSinal = (m) => (m < 0 ? '-' : m > 0 ? '+' : '') + hm(m);
    const tm = (t) => { const p = t.split(':').map(Number); return p[0] * 60 + p[1]; };
    const j = r.jornada;
    const carga = j ? (((tm(j.saida) - tm(j.entrada)) + 1440) % 1440 || 1440) - j.intervalo_min : 0;

    // Situação do dia quando não há marcações
    const rotulo = (d) => {
      if (d.status === 'falta') return '<b>FALTA</b>';
      if (d.status === 'compensado') return 'Compensação do banco de horas';
      if (d.status === 'em_andamento') return 'Em andamento';
      if (d.status === 'incompleto') return '<b>Incompleto</b> — corrigir em "Correções"';
      return esc(MOTIVO[d.motivo] || 'Folga');
    };
    const tot = { trab: 0, atr: 0, ext: 0, comp: 0, an: 0, faltas: 0 };
    const linhas = r.dias.map((d) => {
      const temMarcas = !!d.entrada;
      const saldo = d.saldo_min;
      const atr = d.status === 'trabalho' && saldo < 0 ? -saldo : 0;
      const ext = saldo > 0 ? saldo : 0;
      const comp = d.status === 'compensado' ? -saldo : 0;
      const an = d.an_min || 0;
      tot.trab += d.trabalhado_min || 0; tot.atr += atr; tot.ext += ext; tot.comp += comp; tot.an += an;
      if (d.status === 'falta') tot.faltas++;
      const cls = d.status === 'folga' ? 'folga' : d.status === 'falta' ? 'falta' : d.status === 'incompleto' ? 'inc' : d.status === 'compensado' ? 'comp' : '';
      const marcas = temMarcas
        ? '<td>' + esc(hora(d.entrada)) + '</td><td>' + esc(hora(d.saida_intervalo)) + '</td><td>' + esc(hora(d.volta_intervalo)) + '</td><td>' + esc(hora(d.saida)) + '</td>'
        : '<td colspan="4" class="c">' + rotulo(d) + '</td>';
      const al = (d.alertas || []).map((a) => '<span class="badge warn" title="' + esc(ALERTA[a] || a) + '">' + esc(ALERTA[a] || a) + '</span>').join(' ');
      return '<tr class="' + cls + '"><td>' + esc(dataBR(d.data)) + '</td><td>' + esc(DIAS_SEMANA[d.dow]) + '</td>' + marcas +
        '<td class="n">' + (d.trabalhado_min == null ? '–' : hm(d.trabalhado_min)) + '</td>' +
        '<td class="n">' + (atr ? '<span class="neg">' + hm(atr) + '</span>' : '–') + '</td>' +
        '<td class="n">' + (ext ? '<span class="pos">' + hm(ext) + '</span>' : '–') + '</td>' +
        '<td class="n">' + (comp ? hm(comp) : '–') + '</td>' +
        '<td class="n">' + (an ? hm(an) : '–') + '</td>' +
        '<td class="n banco"><span class="' + (d.banco_min > 0 ? 'pos' : d.banco_min < 0 ? 'neg' : '') + '">' + hmSinal(d.banco_min) + '</span></td>' +
        '<td class="obs">' + al + '</td></tr>';
    }).join('');

    // carga horária por dia da semana (segunda a domingo), como no canto da planilha
    const cargaDia = [1, 2, 3, 4, 5, 6, 0].map((dw) => '<tr><td>' + esc(DIAS_SEMANA[dw]) + '</td><td class="n">' + (j && j.dias_trabalho.includes(dw) ? hm(carga) : '–') + '</td></tr>').join('');
    const bancoFinal = r.dias.length ? r.dias[r.dias.length - 1].banco_min : r.saldo_anterior_min;

    el.innerHTML = '<div class="card espelho">' +
      '<div class="esp-topo"><div class="esp-empresa">' + esc(r.funcionario.empresa) + '</div>' +
      '<div class="muted">' + (r.funcionario.cnpj ? 'CNPJ ' + esc(r.funcionario.cnpj) : '') + '</div>' +
      '<div class="esp-sub">CONTROLE DE CARTÃO PONTO — ' + esc(titulo.toUpperCase()) + '</div></div>' +
      '<div class="esp-cab"><div class="esp-func"><span>Funcionário</span><b>' + esc(r.funcionario.nome) + '</b></div>' +
      '<button class="btn no-print" id="r-print"><i class="ti ti-printer"></i> Imprimir / PDF</button></div>' +
      '<div class="esp-corpo"><div class="scroll esp-tab"><table class="t esp"><thead><tr><th>Data</th><th>Dia</th><th>Entrada</th><th>Saída</th><th>Entrada</th><th>Saída</th>' +
      '<th class="n">H. Diária</th><th class="n">Atrasos</th><th class="n">Horas Extras</th><th class="n">Compensado</th><th class="n">A.N.</th><th class="n">Banco de horas</th><th>Obs.</th></tr></thead><tbody>' +
      (linhas || '<tr><td colspan="13" class="muted">Sem dias apurados neste mês (verifique a data de início do controle).</td></tr>') +
      '</tbody><tfoot><tr><th colspan="6" class="n">TOTAIS DO MÊS</th><th class="n">' + hm(tot.trab) + '</th><th class="n">' + hm(tot.atr) + '</th><th class="n">' + hm(tot.ext) +
      '</th><th class="n">' + hm(tot.comp) + '</th><th class="n">' + hm(tot.an) + '</th><th class="n">' + hmSinal(bancoFinal) + '</th><th></th></tr></tfoot></table></div>' +
      '<div class="esp-lado"><div class="esp-caixa"><div class="esp-caixa-t">CARGA HORÁRIA</div><table class="t">' + cargaDia +
      '<tr><td>Feriados</td><td class="n">folga</td></tr></table>' +
      (j ? '<div class="muted" style="margin-top:4px">' + esc(j.entrada.slice(0, 5)) + '–' + esc(j.saida.slice(0, 5)) + ' · intervalo ' + esc(j.intervalo_min) + ' min</div>' : '') + '</div>' +
      '<div class="esp-caixa"><div class="esp-caixa-t">BANCO DE HORAS</div><table class="t">' +
      '<tr><td>Saldo anterior</td><td class="n">' + hmSinal(r.saldo_anterior_min) + '</td></tr>' +
      '<tr><td>Variação no mês</td><td class="n">' + hmSinal(r.saldo_periodo_min) + '</td></tr>' +
      '<tr><td><b>Banco de horas atual</b></td><td class="n"><b class="' + (r.saldo_banco_min > 0 ? 'pos' : r.saldo_banco_min < 0 ? 'neg' : '') + '">' + hmSinal(r.saldo_banco_min) + '</b></td></tr>' +
      '<tr><td>Faltas no mês</td><td class="n"><b>' + tot.faltas + '</b></td></tr></table></div></div></div>' +
      '<p class="muted" style="margin-top:8px">Horários no fuso de Recife. A.N. = minutos trabalhados entre 22h e 5h (sem conversão da hora noturna reduzida). Falta não altera o banco de horas; compensação abate. Marcações originais são imutáveis; correções constam na aba "Correções". Banco de horas exige acordo por escrito com o funcionário.</p>' +
      '<div class="so-print assinaturas"><div>______________________________<br>Funcionário</div><div>______________________________<br>' + esc(emp.nome || 'Empresa') + '</div></div></div>';
    $('r-print').onclick = () => window.print();
  }

  /* ---------- aba: empresas e estações ---------- */
  // Quadro de saúde: online = sinal nos últimos 10 min; relógio OK = diferença de até 5 min.
  function saudeEstacao(s) {
    if (!s.ativa) return '<span class="muted">—</span>';
    if (!s.ultimo_contato) return '<span class="badge">nunca conectou</span>';
    const partes = [s.online ? '<span class="badge ok">online</span>' : '<span class="badge bad">fora do ar</span>',
      '<span class="muted">último contato ' + esc(dataHora(s.ultimo_contato)) + '</span>'];
    if (s.tira_foto && s.camera_ok === false) partes.push('<span class="badge bad">câmera com falha</span>');
    if (s.relogio_ok === false) {
      const m = Math.round(Math.abs(s.relogio_dif_ms) / 60000);
      partes.push('<span class="badge warn">relógio ' + m + ' min ' + (s.relogio_dif_ms > 0 ? 'adiantado' : 'atrasado') + '</span>');
    }
    return partes.join(' ');
  }

  function formEstacao(s, erro) {
    const ids = s ? s.empresa_ids : [S.empresa];
    $('form-es').innerHTML = '<div class="card" style="margin-top:12px;background:var(--bg)"><h3>' + (s ? 'Editar ' + esc(s.nome) : 'Nova estação') + '</h3>' + msg(erro) +
      '<div class="row"><div class="field" style="max-width:280px"><label for="es-nome">Nome</label><input id="es-nome" placeholder="Ex.: Tablet da entrada" value="' + esc(s ? s.nome : '') + '"></div></div>' +
      '<div class="row"><span class="muted">Empresas atendidas (uma aba para cada):</span>' +
      S.empresas.map((e) => '<label style="display:flex;gap:4px;align-items:center"><input type="checkbox" class="es-emp" value="' + e.id + '"' + (ids.includes(e.id) ? ' checked' : '') + '> ' + esc(e.nome) + '</label>').join('') + '</div>' +
      '<div class="row"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="es-imp"' + (!s || s.imprime ? ' checked' : '') + '> Imprime o comprovante (impressora térmica)</label>' +
      '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="es-foto"' + (s && s.tira_foto ? ' checked' : '') + '> Tira foto de prova (câmera frontal)</label>' +
      '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="es-rosto"' + (s && s.reconhece_rosto ? ' checked' : '') + '> Reconhece rosto (modo totem)</label>' +
      '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="es-res"' + (s && s.reserva ? ' checked' : '') + '> Estação reserva (contingência)</label></div>' +
      '<div style="display:flex;gap:8px"><button class="btn pri" id="es-ok">' + (s ? 'Salvar' : 'Gerar código de ativação') + '</button><button class="btn" id="es-x">Cancelar</button></div></div>';
    $('es-x').onclick = () => { $('form-es').innerHTML = ''; };
    // reconhecer rosto usa a câmera: liga a foto junto
    const sincronizar = () => { if ($('es-rosto').checked) $('es-foto').checked = true; $('es-foto').disabled = $('es-rosto').checked; };
    $('es-rosto').onchange = sincronizar; sincronizar();
    $('es-ok').onclick = async () => {
      const args = { nome: val('es-nome'), empresa_ids: [...document.querySelectorAll('.es-emp:checked')].map((c) => Number(c.value)),
        imprime: $('es-imp').checked, tira_foto: $('es-foto').checked || $('es-rosto').checked, reconhece_rosto: $('es-rosto').checked, reserva: $('es-res').checked };
      if (!args.empresa_ids.length) return formEstacao(s, 'Marque pelo menos uma empresa.');
      const r = s ? await chamar('admin_salvar_estacao', Object.assign({ id: s.id }, args)) : await chamar('admin_criar_estacao', args);
      if (!r.ok) return formEstacao(s, msgErro(r.erro));
      if (s) { toast('Estação salva.'); abaConfig(); } else abaConfig(r.token);
    };
  }

  // Plano gratuito do Supabase: 1 GB de Storage para o projeto todo; avisa acima de 80%.
  async function mostrarEspaco() {
    const r = await chamar('admin_espaco');
    const el = $('espaco');
    if (!el) return;
    if (!r.ok) { el.innerHTML = msg(msgErro(r.erro)); return; }
    const mb = (b) => (b / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' MB';
    const pct = r.storage_bytes == null ? null : Math.round(r.storage_bytes * 100 / r.limite_bytes);
    el.innerHTML = 'Fotos do ponto: <b>' + esc(mb(r.fotos_bytes)) + '</b> (' + esc(r.fotos_qtd) + ' fotos)' +
      (pct == null ? '' : ' · Storage do projeto: <b>' + esc(mb(r.storage_bytes)) + '</b> de 1 GB (' + pct + '%) ' +
        (pct >= 80 ? '<span class="badge bad">acima de 80%</span>' : '<span class="badge ok">ok</span>'));
  }

  // Calibração da primeira semana: similaridade de cada tentativa contra o limiar atual.
  async function mostrarTentativas() {
    const r = await chamar('admin_reconhecimentos', { limite: 40 });
    const el = $('tentativas');
    if (!el) return;
    if (!r.ok) { el.innerHTML = msg(msgErro(r.erro)); return; }
    const RES = { reconhecido: ['ok', 'reconhecido'], nao_reconhecido: ['bad', 'não reconhecido'], prova_de_vida: ['warn', 'prova de vida'],
      sem_cadastro: ['', 'sem cadastro'], cancelado: ['', 'cancelado ("não sou eu")'] };
    const n = (x) => x == null ? '–' : Number(x).toFixed(2);
    el.innerHTML = '<p class="muted" style="margin-bottom:8px">Limiar atual: <b>' + esc(n(r.limiar)) + '</b> · margem mínima para a 2ª pessoa: <b>' + esc(n(r.margem)) +
      '</b>. Use esta lista na primeira semana para calibrar (me passe os números).</p>' +
      (r.tentativas.length ? '<div class="scroll"><table class="t"><tr><th>Quando</th><th>Estação</th><th>Resultado</th><th>Pessoa mais parecida</th><th class="n">Similaridade</th><th class="n">Margem</th><th class="n">Antispoof</th><th class="n">Vida</th></tr>' +
        r.tentativas.map((t) => { const x = RES[t.resultado] || ['', t.resultado];
          return '<tr><td>' + esc(dataHora(t.em)) + '</td><td>' + esc(t.estacao) + '</td><td><span class="badge ' + x[0] + '">' + esc(x[1]) + '</span>' + (t.marcou ? ' <span class="muted">marcou</span>' : '') +
            '</td><td>' + esc(t.funcionario || '–') + '</td><td class="n">' + esc(n(t.similaridade)) + '</td><td class="n">' + esc(n(t.margem)) +
            '</td><td class="n">' + esc(n(t.antispoof)) + '</td><td class="n">' + esc(n(t.liveness)) + '</td></tr>'; }).join('') + '</table></div>'
        : '<p class="muted">Nenhuma tentativa ainda.</p>');
  }

  async function abaConfig(novoToken) {
    let estacoes = [];
    if (S.empresas.length) { const r = await chamar('admin_estacoes'); estacoes = r.ok ? r.estacoes : []; }
    const site = location.origin + location.pathname.replace(/admin\/?(index\.html)?$/, '');

    $('aba').innerHTML =
      '<div class="card"><h2>Empresas</h2>' +
      (S.empresas.length ? '<table class="t"><tr><th>Nome</th><th>CNPJ</th><th>Endereço (sai no comprovante)</th><th></th></tr>' +
        S.empresas.map((e) => '<tr><td>' + esc(e.nome) + '</td><td>' + esc(e.cnpj || '') + '</td><td>' + esc(e.endereco || '') + '</td><td class="n"><button class="btn sm" data-eemp="' + e.id + '">Editar</button></td></tr>').join('') + '</table>'
        : '<p class="muted">Nenhuma empresa. Cadastre a primeira abaixo.</p>') +
      '<div id="form-emp" style="margin-top:12px"></div><div style="margin-top:10px"><button class="btn sm pri" id="nova-emp">+ Nova empresa</button></div></div>' +

      (S.empresa ? '<div class="card"><h2>Estações (tablets e computadores de marcação)</h2>' +
        (novoToken ? '<div class="msg aviso"><b>Código de ativação (aparece só uma vez):</b><br><code id="tok" style="font-size:16px;word-break:break-all">' + esc(novoToken) + '</code>' +
          '<br><br>No tablet ou computador, abra <b>' + esc(site) + '</b> e cole esse código. <button class="btn sm" id="copiar">Copiar código</button></div>' : '') +
        (estacoes.length ? '<div class="scroll"><table class="t"><tr><th>Nome</th><th>Empresas</th><th>Uso</th><th>Saúde</th><th>Situação</th><th></th></tr>' +
          estacoes.map((s) => '<tr><td>' + esc(s.nome) + '</td><td>' + esc((s.empresas || []).join(', ')) + '</td><td>' +
            (s.reserva ? 'Reserva' : 'Principal') + (s.imprime ? ' · imprime' : '') + (s.reconhece_rosto ? ' · rosto' : s.tira_foto ? ' · foto' : '') + '</td><td>' + saudeEstacao(s) + '</td><td>' +
            (s.ativa ? '<span class="badge ok">ativa</span>' : '<span class="badge">desativada</span>') + '</td><td class="n">' +
            (s.ativa ? '<button class="btn sm" data-edes="' + s.id + '">Editar</button> <button class="btn sm bad" data-des="' + s.id + '">Desativar</button>' : '') + '</td></tr>').join('') + '</table></div>'
          : '<p class="muted">Nenhuma estação.</p>') +
        '<div id="form-es"></div><div style="margin-top:10px"><button class="btn sm pri" id="es-nova">+ Nova estação</button></div></div>' +

        '<div class="card"><h2>Espaço das fotos</h2><div id="espaco" class="muted">Calculando…</div></div>' +

        (estacoes.some((s) => s.reconhece_rosto) ? '<div class="card"><h2>Reconhecimento facial: últimas tentativas</h2><div id="tentativas" class="muted">Carregando…</div></div>' : '') +

        '<div class="card"><h2>Integridade dos registros</h2><p class="muted" style="margin-bottom:8px">Confere a numeração (NSR) e o encadeamento de hash de todas as marcações da empresa.</p>' +
        '<button class="btn" id="verif">Verificar agora</button> <span id="verif-res"></span></div>' : '');

    const formEmp = (e) => {
      $('form-emp').innerHTML = '<div class="row"><div class="field"><label for="em-n">Nome</label><input id="em-n" value="' + esc(e ? e.nome : '') + '"></div>' +
        '<div class="field"><label for="em-c">CNPJ</label><input id="em-c" value="' + esc(e && e.cnpj || '') + '"></div>' +
        '<div class="field"><label for="em-e">Endereço</label><input id="em-e" value="' + esc(e && e.endereco || '') + '"></div>' +
        '<button class="btn pri" id="em-ok">Salvar</button></div>';
      $('em-ok').onclick = async () => {
        const r = await chamar('admin_salvar_empresa', { id: e ? e.id : null, nome: val('em-n'), cnpj: val('em-c'), endereco: val('em-e') });
        if (!r.ok) return toast(msgErro(r.erro));
        toast('Empresa salva.'); await carregarBase(); if (!S.empresa) S.empresa = r.id; telaPrincipal();
      };
    };
    $('nova-emp').onclick = () => formEmp(null);
    $('aba').querySelectorAll('[data-eemp]').forEach((b) => b.onclick = () => formEmp(S.empresas.find((x) => x.id === Number(b.dataset.eemp))));
    if (S.empresa) {
      $('es-nova').onclick = () => formEstacao(null);
      $('aba').querySelectorAll('[data-edes]').forEach((b) => b.onclick = () => formEstacao(estacoes.find((x) => x.id === Number(b.dataset.edes))));
      $('aba').querySelectorAll('[data-des]').forEach((b) => b.onclick = async () => {
        if (!confirm('Desativar esta estação? O computador deixa de poder marcar ponto.')) return;
        await chamar('admin_desativar_estacao', { id: Number(b.dataset.des) }); abaConfig();
      });
      mostrarEspaco();
      if ($('tentativas')) mostrarTentativas();
      $('verif').onclick = async () => {
        const r = await chamar('admin_verificar_cadeia', { empresa_id: S.empresa });
        $('verif-res').innerHTML = !r.ok ? '<span class="badge bad">erro</span>'
          : r.integra ? '<span class="badge ok">Íntegro — nenhuma alteração detectada</span>'
            : '<span class="badge bad">Inconsistência a partir do NSR ' + esc(r.primeiro_nsr_invalido) + '</span>';
      };
      const cp = $('copiar');
      if (cp) cp.onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('tok').textContent).then(() => toast('Código copiado.')); };
    }
  }

  iniciar();
})();

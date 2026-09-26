// Foto como prova (especificação 11.4): câmera frontal sempre ligada na tela da estação;
// a foto é o quadro do instante em que a pessoa toca em "Registrar". Também calcula o
// SHA-256 e envia o arquivo. Sem câmera, capturarAgora() devolve null e a marcação segue sem foto.
(function () {
  const TAM = 240;             // lado da foto, em px
  const ESPERA_MS = 5000;      // tempo máximo para a câmera abrir
  const RELIGAR_MS = 10000;    // nova tentativa depois de uma falha ou queda da câmera

  let stream = null, video = null, alvo = null, religar = null;
  let abrindo = null;       // pedido de câmera em andamento (nunca dois ao mesmo tempo)
  let bloqueada = false;    // permissão negada/fechada: não insiste sozinho (senão o aviso some e volta)
  let vigiando = false;

  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const paraBlob = (canvas, tipo, q) => new Promise((r) => { try { canvas.toBlob(r, tipo, q); } catch (e) { r(null); } });
  const MIDIA = { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false };

  function ativa() {
    return !!(stream && video && video.videoWidth && stream.getVideoTracks().some((t) => t.readyState === 'live'));
  }
  function parar() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; video = null;
  }
  function agendarReligar() {
    if (religar || !alvo || bloqueada) return;
    religar = setTimeout(() => { religar = null; ligar(); }, RELIGAR_MS);
  }
  // Mensagem no quadro da câmera (ex.: pedir para permitir). Com botão, o toque também serve de gesto do usuário.
  function aviso(texto, comBotao) {
    if (!alvo) return;
    alvo.hidden = false;
    alvo.innerHTML = '<div class="cam-aviso"><span>' + texto + '</span>' +
      (comBotao ? '<button type="button" class="btn sm">Ativar câmera</button>' : '') + '</div>';
    const b = alvo.querySelector('button');
    if (b) b.onclick = () => { bloqueada = false; ligar(); };
  }
  async function permissao() {
    try { return (await navigator.permissions.query({ name: 'camera' })).state; } catch (e) { return 'desconhecida'; }
  }
  // Quando a permissão muda (ex.: liberada no cadeado da barra de endereço), tenta de novo sozinho.
  async function vigiarPermissao() {
    if (vigiando) return;
    vigiando = true;
    try {
      const st = await navigator.permissions.query({ name: 'camera' });
      st.onchange = () => { if (st.state !== 'denied' && alvo) { bloqueada = false; ligar(); } };
    } catch (e) { /* navegador sem Permissions API */ }
  }
  // Pede a câmera. Se já tem permissão, espera no máximo ESPERA_MS; se o aviso de permissão está
  // aberto, espera a pessoa decidir (sem prazo). Stream que chegar depois do prazo é fechado.
  async function pedirCamera(md, comPrazo) {
    const pedido = md.getUserMedia(MIDIA);
    if (!comPrazo) return pedido;
    let venceu = false;
    const prazo = esperar(ESPERA_MS).then(() => { venceu = true; throw new Error('prazo'); });
    pedido.then((s) => { if (venceu) s.getTracks().forEach((t) => t.stop()); }, () => {});
    return Promise.race([pedido, prazo]);
  }

  // Liga a câmera e mostra a imagem ao vivo em "container" (fica ligada até desligar()).
  function ligar(container) {
    if (container) alvo = container;
    if (!alvo) return Promise.resolve(false);
    if (ativa()) return Promise.resolve(true);
    if (!abrindo) abrindo = abrir().finally(() => { abrindo = null; });
    return abrindo;
  }

  async function abrir() {
    parar();
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { PontoFoto.cameraOk = false; alvo.hidden = true; return false; }
    vigiarPermissao();
    const perm = await permissao();
    if (perm === 'denied') {
      bloqueada = true; PontoFoto.cameraOk = false;
      aviso('Câmera bloqueada neste navegador. Libere no cadeado ao lado do endereço.', true);
      return false;
    }
    if (perm === 'prompt') aviso('Toque em <b>Permitir</b> no aviso do navegador para usar a câmera.');
    try {
      stream = await pedirCamera(md, perm === 'granted');
      alvo.innerHTML = '<video playsinline muted autoplay></video>';
      video = alvo.querySelector('video');
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* autoplay já cuida */ }
      for (let t = 0; !video.videoWidth && t < 30; t++) await esperar(100);
      if (!video.videoWidth) throw new Error('sem imagem');
      // o Android pode derrubar a câmera (outro app, economia de energia): religa sozinho
      stream.getVideoTracks().forEach((t) => t.addEventListener('ended', agendarReligar));
      alvo.hidden = false;
      PontoFoto.cameraOk = true;
      return true;
    } catch (e) {
      parar();
      PontoFoto.cameraOk = false;
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        // negou ou fechou o aviso: não pede de novo sozinho; o botão (ou liberar no cadeado) tenta outra vez
        bloqueada = true;
        aviso('A câmera não foi liberada.', true);
      } else if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) {
        aviso('Nenhuma câmera encontrada neste aparelho.', true);
      } else {
        aviso('Câmera indisponível. Tentando de novo…', true);
        agendarReligar();
      }
      return false;
    }
  }

  function desligar() {
    clearTimeout(religar); religar = null;
    bloqueada = false;
    parar();
    if (alvo) { alvo.hidden = true; alvo.innerHTML = ''; }
    alvo = null;
    PontoFoto.cameraOk = null;
  }

  // volta de tela apagada / aba em segundo plano, ou câmera travada sem aviso
  const tentarDeNovo = () => alvo && !ativa() && !religar && !abrindo && !bloqueada;
  document.addEventListener('visibilitychange', () => { if (!document.hidden && tentarDeNovo()) ligar(); });
  setInterval(() => { if (tentarDeNovo()) ligar(); }, 60000);

  // Quadro atual da câmera: recorte quadrado no centro, reduzido para 240 px, WebP (ou JPEG).
  // Nunca espera um aviso de permissão: a marcação não pode travar por causa da câmera.
  async function capturarAgora() {
    if (!ativa() && !abrindo && !bloqueada) await Promise.race([ligar(), esperar(3000)]);
    if (!ativa()) return null;
    try {
      const vw = video.videoWidth, vh = video.videoHeight, lado = Math.min(vw, vh) * 0.8;
      const canvas = document.createElement('canvas');
      canvas.width = TAM; canvas.height = TAM;
      canvas.getContext('2d').drawImage(video, (vw - lado) / 2, (vh - lado) / 2, lado, lado, 0, 0, TAM, TAM);
      let blob = await paraBlob(canvas, 'image/webp', 0.7);
      if (!blob || blob.type !== 'image/webp') blob = await paraBlob(canvas, 'image/jpeg', 0.75);   // navegador sem WebP
      PontoFoto.cameraOk = !!blob;
      return blob || null;
    } catch (e) {
      PontoFoto.cameraOk = false;
      return null;
    }
  }

  async function hash(blob) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Sobe a foto pela Edge Function (a marcação já está gravada). Tenta 3 vezes.
  async function enviar(blob, dados) {
    const cfg = window.PONTO_CONFIG || {};
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(cfg.url + '/functions/v1/ponto-foto', {
          method: 'POST',
          headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey, 'Content-Type': blob.type,
                     'x-ponto-token': dados.token, 'x-marcacao-id': String(dados.marcacaoId) },
          body: blob
        });
        if (r.ok) return true;
        if (r.status >= 400 && r.status < 500) return false;   // recusa definitiva: não adianta repetir
      } catch (e) { /* rede: tenta de novo */ }
      await esperar([1000, 3000, 9000][i]);
    }
    return false;
  }

  const PontoFoto = { ligar, desligar, capturarAgora, hash, enviar, cameraOk: null };
  window.PontoFoto = PontoFoto;
})();

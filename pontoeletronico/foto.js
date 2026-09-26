// Foto como prova (especificação 11.4): câmera frontal sempre ligada na tela da estação;
// a foto é o quadro do instante em que a pessoa toca em "Registrar". Também calcula o
// SHA-256 e envia o arquivo. Sem câmera, capturarAgora() devolve null e a marcação segue sem foto.
(function () {
  const TAM = 240;             // lado da foto, em px
  const ESPERA_MS = 5000;      // tempo máximo para a câmera abrir
  const RELIGAR_MS = 10000;    // nova tentativa depois de uma falha ou queda da câmera

  let stream = null, video = null, alvo = null, religar = null;

  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const comPrazo = (p, ms) => Promise.race([p, esperar(ms).then(() => { throw new Error('prazo'); })]);
  const paraBlob = (canvas, tipo, q) => new Promise((r) => { try { canvas.toBlob(r, tipo, q); } catch (e) { r(null); } });

  function ativa() {
    return !!(stream && video && video.videoWidth && stream.getVideoTracks().some((t) => t.readyState === 'live'));
  }
  function parar() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; video = null;
  }
  function agendarReligar() {
    if (religar || !alvo) return;
    religar = setTimeout(() => { religar = null; ligar(); }, RELIGAR_MS);
  }

  // Liga a câmera e mostra a imagem ao vivo em "container" (fica ligada até desligar()).
  async function ligar(container) {
    if (container) alvo = container;
    if (!alvo) return false;
    if (ativa()) return true;
    parar();
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { PontoFoto.cameraOk = false; alvo.hidden = true; return false; }
    try {
      stream = await comPrazo(md.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }), ESPERA_MS);
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
      alvo.hidden = true;
      PontoFoto.cameraOk = false;
      agendarReligar();
      return false;
    }
  }

  function desligar() {
    clearTimeout(religar); religar = null;
    parar();
    if (alvo) { alvo.hidden = true; alvo.innerHTML = ''; }
    alvo = null;
    PontoFoto.cameraOk = null;
  }

  // volta de tela apagada / aba em segundo plano, ou câmera travada sem aviso
  document.addEventListener('visibilitychange', () => { if (!document.hidden && alvo && !ativa()) ligar(); });
  setInterval(() => { if (alvo && !ativa() && !religar) ligar(); }, 60000);

  // Quadro atual da câmera: recorte quadrado no centro, reduzido para 240 px, WebP (ou JPEG).
  async function capturarAgora() {
    if (!ativa()) await ligar();
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

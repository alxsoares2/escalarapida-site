// Foto como prova (especificação 11.4): captura na câmera frontal, SHA-256 e envio.
// Sem câmera (ou sem permissão), capturar() devolve null e a marcação segue sem foto.
(function () {
  const TAM = 240;          // lado da foto, em px
  const ESPERA_MS = 5000;   // tempo máximo para a câmera abrir

  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const comPrazo = (p, ms) => Promise.race([p, esperar(ms).then(() => { throw new Error('prazo'); })]);
  const paraBlob = (canvas, tipo, q) => new Promise((r) => { try { canvas.toBlob(r, tipo, q); } catch (e) { r(null); } });

  // Mostra a câmera dentro de "container" com moldura oval e contagem; devolve o Blob ou null.
  async function capturar(container, segundos) {
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { PontoFoto.cameraOk = false; return null; }
    let stream = null;
    try {
      stream = await comPrazo(md.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }), ESPERA_MS);
      container.innerHTML = '<div class="cam"><video playsinline muted autoplay></video><div class="cam-oval"></div>' +
        '<div class="cam-msg">Olhe para a câmera</div><div class="cam-cont"></div></div>';
      const video = container.querySelector('video');
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* autoplay já cuida */ }
      for (let t = 0; !video.videoWidth && t < 30; t++) await esperar(100);
      if (!video.videoWidth) throw new Error('sem imagem');

      const cont = container.querySelector('.cam-cont');
      for (let s = segundos || 3; s > 0; s--) { cont.textContent = s; await esperar(1000); }
      cont.textContent = '';

      // recorte quadrado no centro (onde fica a moldura), reduzido para 240 px
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
    } finally {
      if (stream) stream.getTracks().forEach((t) => t.stop());
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

  const PontoFoto = { capturar, hash, enviar, cameraOk: null };
  window.PontoFoto = PontoFoto;
})();

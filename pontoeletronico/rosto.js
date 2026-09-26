// Reconhecimento facial no navegador (especificação 11.4A): carrega a biblioteca @vladmandic/human
// (versão fixa, do jsDelivr; o navegador guarda os modelos em cache) e analisa o quadro da câmera.
// Só produz números (descritor do rosto e notas de prova de vida); quem compara é o servidor.
(function () {
  const VERSAO = '3.3.6';
  const BASE = 'https://cdn.jsdelivr.net/npm/@vladmandic/human@' + VERSAO;
  let human = null, carregando = null;

  const CONFIG = {
    modelBasePath: BASE + '/models/',
    backend: 'webgl',
    cacheSensitivity: 0,          // cada quadro é analisado de novo (sem reaproveitar resultado)
    debug: false,
    filter: { enabled: true, equalization: true },
    face: {
      enabled: true,
      detector: { rotation: false, maxDetected: 2, minConfidence: 0.5, skipFrames: 0, skipTime: 0 },
      mesh: { enabled: true },                                 // necessário para o ângulo do rosto
      attention: { enabled: false },
      iris: { enabled: false },
      description: { enabled: true, skipFrames: 0, skipTime: 0 },   // descritor (faceres)
      emotion: { enabled: false },
      antispoof: { enabled: true, skipFrames: 0, skipTime: 0 },     // foto/tela na frente da câmera
      liveness: { enabled: true, skipFrames: 0, skipTime: 0 }       // rosto real
    },
    body: { enabled: false }, hand: { enabled: false }, object: { enabled: false },
    gesture: { enabled: false }, segmentation: { enabled: false }
  };

  // Carrega a biblioteca e os modelos (alguns MB na primeira vez). Rejeita se não houver WebGL/rede.
  function iniciar() {
    if (human) return Promise.resolve(true);
    if (!carregando) {
      carregando = (async () => {
        const mod = await import(BASE + '/dist/human.esm.js');
        const H = mod.Human || mod.default;
        const h = new H(CONFIG);
        await h.load();
        await h.warmup();
        human = h;
        return true;
      })().catch((e) => { carregando = null; throw e; });
    }
    return carregando;
  }

  // Analisa o quadro atual do vídeo. Um rosto só: devolve descritor, notas e posição
  // (largura e centro relativos à imagem, ângulos em radianos).
  async function analisar(video) {
    if (!human || !video || !video.videoWidth) return { rostos: 0 };
    const r = await human.detect(video);
    const faces = (r && r.face) || [];
    if (faces.length !== 1) return { rostos: faces.length };
    const f = faces[0];
    const ang = (f.rotation && f.rotation.angle) || {};
    const b = f.boxRaw || [0, 0, 0, 0];
    return {
      rostos: 1,
      rosto: {
        descritor: f.embedding && f.embedding.length ? Array.from(f.embedding, (n) => Math.round(n * 1e5) / 1e5) : null,
        antispoof: typeof f.real === 'number' ? f.real : null,
        liveness: typeof f.live === 'number' ? f.live : null,
        yaw: ang.yaw || 0,
        pitch: ang.pitch || 0,
        largura: b[2],
        centroX: b[0] + b[2] / 2,
        centroY: b[1] + b[3] / 2
      }
    };
  }

  window.PontoRosto = { iniciar, analisar, pronto: () => !!human };
})();

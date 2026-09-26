// Lógica da Edge Function "ponto-foto" (especificação 11.4). Sem dependências: roda no Deno
// (Supabase) e no Node (testes, com um banco em memória e um Storage simulado).
//
//   POST image/webp|jpeg|png  + cabeçalhos x-ponto-token e x-marcacao-id
//        -> estação envia a foto de uma marcação; o SHA-256 do arquivo precisa ser o
//           foto_hash gravado na marcação (que já está na cadeia de hash).
//   POST application/json {acao:'ver', sessao, ids:[marcacao_id...]}
//        -> gestor recebe links temporários (5 min) das fotos.
//
// Dependências injetadas:
//   sql(texto, parametros) -> Promise<linhas[]>   (conexão direta ao banco, como dono)
//   storage.upload(caminho, bytes, tipo)          (compartimento privado ponto-fotos)
//   storage.signedUrls(caminhos, segundos) -> Promise<string[]>

export const LIMITE_BYTES = 100 * 1024;
const TIPOS = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-ponto-token, x-marcacao-id',
  'Access-Control-Max-Age': '86400'
};
const STATUS = {
  estacao_invalida: 401, sessao_invalida: 401, marcacao_invalida: 404, foto_nao_confere: 403,
  prazo_esgotado: 410, foto_ja_enviada: 409, foto_invalida: 415, foto_grande: 413, pedido_invalido: 400
};

const resposta = (corpo, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const erro = (codigo) => resposta({ ok: false, erro: codigo }, STATUS[codigo] || 500);

async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function criarHandler({ sql, storage }) {
  async function enviar(req) {
    const tipo = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = TIPOS[tipo];
    if (!ext) return erro('foto_invalida');
    const token = req.headers.get('x-ponto-token') || '';
    const id = Number(req.headers.get('x-marcacao-id'));
    if (!token || !Number.isSafeInteger(id) || id <= 0) return erro('pedido_invalido');
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.length) return erro('foto_invalida');
    if (bytes.length > LIMITE_BYTES) return erro('foto_grande');

    const hash = await sha256Hex(bytes);
    const [{ r }] = await sql('select ponto.foto_autorizar($1, $2, $3, $4) as r', [token, id, hash, ext]);
    if (!r.ok) return erro(r.erro);
    try {
      await storage.upload(r.caminho, bytes, tipo);
    } catch (e) {
      // Já existe = envio anterior subiu o arquivo e caiu antes de registrar. O caminho é
      // único por marcação e aquele envio também passou pela conferência do hash.
      if (!/exist|duplicate/i.test(String(e && (e.message || e.error)))) throw e;
    }
    await sql('select ponto.foto_registrar($1, $2, $3, $4)', [id, r.caminho, bytes.length, tipo]);
    return resposta({ ok: true });
  }

  async function ver(corpo) {
    const ids = Array.isArray(corpo.ids) ? corpo.ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : [];
    if (!corpo.sessao || !ids.length || ids.length > 500) return erro('pedido_invalido');
    let linhas;
    try {
      linhas = await sql('select marcacao_id, caminho from ponto.foto_caminhos_admin($1, $2::bigint[])', [corpo.sessao, ids]);
    } catch (e) {
      if (/E:sessao_invalida/.test(String(e && e.message))) return erro('sessao_invalida');
      throw e;
    }
    const urls = {};
    if (linhas.length) {
      const links = await storage.signedUrls(linhas.map((l) => l.caminho), 300);
      linhas.forEach((l, i) => { if (links[i]) urls[String(l.marcacao_id)] = links[i]; });
    }
    return resposta({ ok: true, urls });
  }

  return async function handler(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return erro('pedido_invalido');
    try {
      const tipo = (req.headers.get('content-type') || '').toLowerCase();
      if (tipo.startsWith('application/json')) {
        let corpo;
        try { corpo = await req.json(); } catch (e) { return erro('pedido_invalido'); }
        if (corpo && corpo.acao === 'ver') return await ver(corpo);
        return erro('pedido_invalido');
      }
      return await enviar(req);
    } catch (e) {
      console.error('ponto-foto:', e && e.message);
      return resposta({ ok: false, erro: 'erro_interno' }, 500);   // sem detalhes para fora
    }
  };
}

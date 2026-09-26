// Edge Function "ponto-foto": liga a lógica de handler.js ao banco e ao Storage do Supabase.
// Fica em dev/ (bloqueado no site público pelo .htaccess). Publicação:
//   npx supabase functions deploy ponto-foto --project-ref dhmlltvdyhavpoyazaph --no-verify-jwt --workdir dev
// --no-verify-jwt: a função se autentica sozinha (token da estação ou sessão do gestor).
// SUPABASE_DB_URL, SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são fornecidas pelo próprio Supabase.
import postgres from 'npm:postgres@3.4.5';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { criarHandler } from './handler.js';

const BUCKET = 'ponto-fotos';
const db = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 2 });
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false }
});

const handler = criarHandler({
  sql: (texto: string, parametros: unknown[]) => db.unsafe(texto, parametros as never[]),
  storage: {
    async upload(caminho: string, bytes: Uint8Array, tipo: string) {
      const { error } = await sb.storage.from(BUCKET).upload(caminho, bytes, { contentType: tipo, upsert: false });
      if (error) throw error;
    },
    async signedUrls(caminhos: string[], segundos: number) {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(caminhos, segundos);
      if (error) throw error;
      return (data || []).map((d) => d.signedUrl);
    }
  }
});

Deno.serve(handler);

// Gera um código de instalação de uso único para criar a conta do admin pela página.
// Só o hash vai para o banco; o código aparece aqui uma vez.
// Uso:  node --env-file=<arquivo .env com DATABASE_URL> db/criar-codigo-instalacao.mjs
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL não definida.'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const { rows } = await client.query('select count(*)::int as n from ponto.admin');
  if (rows[0].n > 0) {
    console.error('Já existe um administrador; não é preciso código de instalação.');
    process.exit(1);
  }
  const codigo = randomBytes(9).toString('base64url');   // 12 caracteres
  const hash = createHash('sha256').update(codigo, 'utf8').digest('hex');
  await client.query(
    `insert into ponto.config (chave, valor) values ('codigo_instalacao_hash', $1)
     on conflict (chave) do update set valor = excluded.valor`, [hash]);
  console.log('Código de instalação (uso único): ' + codigo);
} finally {
  await client.end();
}

// Aplica as migrations de db/migrations no banco apontado por DATABASE_URL.
// Uso:  node --env-file=<arquivo .env com DATABASE_URL> db/migrate.mjs
// Cada arquivo roda numa transação e é registrado em ponto.migracoes (não repete).
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não definida.');
  process.exit(1);
}

const dir = new URL('./migrations/', import.meta.url);
const arquivos = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query('create schema if not exists ponto');
  await client.query(`create table if not exists ponto.migracoes (
    nome text primary key, aplicada_em timestamptz not null default now())`);
  const feitas = new Set((await client.query('select nome from ponto.migracoes')).rows.map((r) => r.nome));

  let aplicadas = 0;
  for (const nome of arquivos) {
    if (feitas.has(nome)) continue;
    console.log(`aplicando ${nome} ...`);
    try {
      await client.query('begin');
      await client.query(readFileSync(new URL(nome, dir), 'utf8'));
      await client.query('insert into ponto.migracoes (nome) values ($1)', [nome]);
      await client.query('commit');
      aplicadas++;
    } catch (e) {
      await client.query('rollback');
      console.error(`FALHOU em ${nome}: ${e.message}`);
      process.exitCode = 1;
      break;
    }
  }
  console.log(aplicadas ? `${aplicadas} migration(s) aplicada(s).` : 'nada a aplicar.');
} finally {
  await client.end();
}

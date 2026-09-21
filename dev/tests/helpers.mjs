import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdirSync, readFileSync } from 'node:fs';

// Banco em memória com todas as migrations aplicadas.
export async function novoBanco() {
  const db = new PGlite({ extensions: { pgcrypto } });
  const dir = new URL('../db/migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(f, dir), 'utf8'));
  }
  return db;
}

// 'YYYY-MM-DD HH:MM' (horário de Recife) -> ISO com fuso.
export const recife = (s) => s.replace(' ', 'T') + ':00-03:00';

// Substitui a única fonte de "agora" (só existe nos testes).
export function fixarRelogio(db, quando) {
  const iso = quando.includes('-03:00') ? quando : recife(quando);
  return db.exec(`create or replace function ponto.agora() returns timestamptz
    language sql volatile as $$ select '${iso}'::timestamptz $$`);
}

// Empresa + funcionária (PIN 1234) + jornada 6x1 (dom a sex, 10:00-16:15, 15 min) + estação.
export async function cenario(db) {
  await fixarRelogio(db, '2026-09-01 08:00');
  await db.exec(`
    insert into ponto.empresa (nome, cnpj, endereco) values ('Basílico', '00.000.000/0001-00', 'Rua A, 1');
    insert into ponto.funcionario (empresa_id, nome, cpf, pin_hash, inicio_controle)
      values (1, 'Ana', '111', extensions.crypt('1234', extensions.gen_salt('bf', 4)), '2026-09-01'),
             (1, 'Beto', '222', extensions.crypt('9999', extensions.gen_salt('bf', 4)), '2026-09-01');
    insert into ponto.jornada (funcionario_id, vigencia_inicio, dias_trabalho, entrada, saida, intervalo_min)
      values (1, '2026-01-01', '{0,1,2,3,4,5}', '10:00', '16:15', 15),
             (2, '2026-01-01', '{5}', '18:00', '00:15', 15);
    insert into ponto.estacao (empresa_id, nome, token_hash) values (1, 'Balcão', ponto.sha256_hex('tok-estacao'));
  `);
  return { func: 1, beto: 2, estacao: 1, empresa: 1, token: 'tok-estacao' };
}

// Registra uma marcação no horário informado (via a função interna real).
export async function marca(db, func, quando, tipo, estacao = 1) {
  await fixarRelogio(db, quando);
  const r = await db.query('select * from ponto.registrar_marcacao($1::smallint, $2::integer, $3::ponto.tipo_marcacao)',
    [estacao, func, tipo]);
  return r.rows[0];
}

// Marca um dia inteiro: lista de [hora, tipo]; hora 'HH:MM' do próprio dia ou 'YYYY-MM-DD HH:MM'.
export async function dia(db, func, data, marcas) {
  for (const [hora, tipo] of marcas) {
    await marca(db, func, hora.length === 5 ? `${data} ${hora}` : hora, tipo);
  }
}

// Chamada como o frontend faz.
export async function rpc(db, fn, args = {}) {
  const r = await db.query('select public.ponto_rpc($1, $2::jsonb) as r', [fn, JSON.stringify(args)]);
  return r.rows[0].r;
}

export const CHEIO = [['10:00', 'entrada'], ['13:00', 'saida_intervalo'], ['13:15', 'volta_intervalo'], ['16:15', 'saida']];

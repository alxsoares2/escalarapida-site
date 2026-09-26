import test from 'node:test';
import assert from 'node:assert/strict';
import { novoBanco, cenario, marca, fixarRelogio, rpc } from './helpers.mjs';

const erro = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

async function pronto() {
  const db = await novoBanco();
  const c = await cenario(db);
  await fixarRelogio(db, '2026-09-14 09:00');
  return { db, c };
}

test('registro imutável, NSR sequencial e cadeia de hash', async (t) => {
  const { db } = await pronto();
  await marca(db, 1, '2026-09-14 10:00', 'entrada');
  await marca(db, 2, '2026-09-14 10:01', 'entrada');
  await marca(db, 1, '2026-09-14 13:00', 'saida_intervalo');

  await t.test('NSR 1..N por empresa, sem buracos', async () => {
    const r = await db.query('select nsr::int from ponto.marcacao order by nsr');
    assert.deepEqual(r.rows.map((x) => x.nsr), [1, 2, 3]);
  });
  await t.test('UPDATE, DELETE e TRUNCATE são bloqueados', async () => {
    assert.match(await erro(db.exec("update ponto.marcacao set tipo = 'saida' where id = 1")), /imutável/);
    assert.match(await erro(db.exec('delete from ponto.marcacao')), /imutável/);
    assert.match(await erro(db.exec('truncate ponto.marcacao cascade')), /imutável/);
  });
  await t.test('cadeia íntegra; adulteração é detectada no NSR certo', async () => {
    assert.equal((await db.query('select ponto.verificar_cadeia(1::smallint) v')).rows[0].v, null);
    await db.exec(`alter table ponto.marcacao disable trigger marcacao_imutavel_ud;
                   update ponto.marcacao set marcado_em = marcado_em + interval '1 hour' where nsr = 2;
                   alter table ponto.marcacao enable trigger marcacao_imutavel_ud;`);
    assert.equal(Number((await db.query('select ponto.verificar_cadeia(1::smallint) v')).rows[0].v), 2);
  });
});

test('sequência de marcações e proteção contra toque duplo', async (t) => {
  const { db } = await pronto();
  await t.test('não dá para começar pela saída do intervalo', async () => {
    assert.match(await erro(marca(db, 1, '2026-09-14 10:00', 'saida_intervalo')), /fora_de_sequencia/);
  });
  await marca(db, 1, '2026-09-14 10:00', 'entrada');
  await t.test('toque duplo em menos de 30 s é recusado', async () => {
    assert.match(await erro(marca(db, 1, '2026-09-14 10:00', 'saida')), /marcacao_repetida/);
  });
  await t.test('depois da entrada: intervalo ou saída direta; não outra entrada', async () => {
    assert.match(await erro(marca(db, 1, '2026-09-14 10:05', 'entrada')), /fora_de_sequencia/);
    await marca(db, 1, '2026-09-14 13:00', 'saida_intervalo');
    // depois da saída para o intervalo: volta ou saída (saiu no intervalo, 5.4A); nunca outra entrada
    assert.deepEqual((await db.query("select ponto.proximos_tipos(1)::text[] p")).rows[0].p, ['volta_intervalo', 'saida']);
    assert.match(await erro(marca(db, 1, '2026-09-14 13:10', 'entrada')), /fora_de_sequencia/);
    await marca(db, 1, '2026-09-14 13:15', 'volta_intervalo');
    await marca(db, 1, '2026-09-14 16:15', 'saida');
  });
  await t.test('passadas 14 h da última marcação, recomeça em "entrada"', async () => {
    await marca(db, 2, '2026-09-14 18:00', 'entrada');
    assert.deepEqual((await db.query("select ponto.proximos_tipos(2)::text[] p")).rows[0].p, ['saida_intervalo', 'saida']);
    await fixarRelogio(db, '2026-09-15 09:00');
    assert.deepEqual((await db.query("select ponto.proximos_tipos(2)::text[] p")).rows[0].p, ['entrada']);
  });
});

test('PIN: 5 erros bloqueiam por 5 minutos', async (t) => {
  const { db, c } = await pronto();
  const chamar = (pin) => rpc(db, 'estado', { token: c.token, funcionario_id: 1, pin });

  await t.test('PIN correto entra e mostra as marcações válidas', async () => {
    const r = await chamar('1234');
    assert.equal(r.ok, true);
    assert.deepEqual(r.proximos, ['entrada']);
  });
  await t.test('erros contam e o 5º bloqueia, mesmo com o PIN certo depois', async () => {
    for (let i = 1; i <= 4; i++) assert.equal((await chamar('0000')).erro, 'pin_invalido');
    assert.equal((await chamar('0000')).erro, 'bloqueado');
    assert.equal((await chamar('1234')).erro, 'bloqueado');
  });
  await t.test('depois de 5 minutos volta a funcionar', async () => {
    await fixarRelogio(db, '2026-09-14 09:06');
    assert.equal((await chamar('1234')).ok, true);
  });
  await t.test('acerto zera o contador de erros', async () => {
    await chamar('0000'); await chamar('0000');
    await chamar('1234');
    for (let i = 0; i < 4; i++) await chamar('0000');
    assert.equal((await chamar('1234')).ok, true);   // 4 erros após o acerto: ainda não bloqueou
  });
});

test('estação: token, funcionário de outra empresa e comprovante', async (t) => {
  const { db, c } = await pronto();
  await db.exec(`insert into ponto.empresa (nome) values ('Outra');
    insert into ponto.funcionario (empresa_id, nome, pin_hash, inicio_controle)
      values (2, 'Carla', extensions.crypt('4321', extensions.gen_salt('bf', 4)), '2026-09-01');`);

  await t.test('token errado é recusado', async () => {
    assert.equal((await rpc(db, 'estacao', { token: 'errado' })).erro, 'estacao_invalida');
    assert.equal((await rpc(db, 'registrar', { token: 'errado', funcionario_id: 1, pin: '1234', tipo: 'entrada' })).erro, 'estacao_invalida');
  });
  await t.test('a estação só lista funcionários da própria empresa', async () => {
    const r = await rpc(db, 'estacao', { token: c.token });
    assert.deepEqual(r.funcionarios.map((f) => f.nome), ['Ana', 'Beto']);
    assert.equal(r.empresa.nome, 'Basílico');
  });
  await t.test('não dá para marcar por funcionário de outra empresa', async () => {
    const r = await rpc(db, 'registrar', { token: c.token, funcionario_id: 3, pin: '4321', tipo: 'entrada' });
    assert.equal(r.erro, 'funcionario_invalido');
  });
  await t.test('registrar devolve o comprovante com NSR e hash', async () => {
    const r = await rpc(db, 'registrar', { token: c.token, funcionario_id: 1, pin: '1234', tipo: 'entrada' });
    assert.equal(r.ok, true);
    assert.equal(r.comprovante.nsr, 1);
    assert.equal(r.comprovante.funcionario, 'Ana');
    assert.equal(r.comprovante.cnpj, '00.000.000/0001-00');
    assert.match(r.comprovante.hash, /^[0-9a-f]{64}$/);
  });
  await t.test('PIN errado não registra nada', async () => {
    const antes = (await db.query('select count(*)::int n from ponto.marcacao')).rows[0].n;
    await fixarRelogio(db, '2026-09-14 10:00');
    const r = await rpc(db, 'registrar', { token: c.token, funcionario_id: 2, pin: '0000', tipo: 'entrada' });
    assert.equal(r.erro, 'pin_invalido');
    assert.equal((await db.query('select count(*)::int n from ponto.marcacao')).rows[0].n, antes);
  });
});

test('pedido de correção do funcionário e decisão do dono', async (t) => {
  const { db, c } = await pronto();
  await db.exec(`insert into ponto.admin (email, senha_hash)
    values ('dono@teste.com', extensions.crypt('senha-teste', extensions.gen_salt('bf', 4)))`);
  await fixarRelogio(db, '2026-09-15 09:00');
  const sessao = (await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' })).sessao;
  const pedido = { token: c.token, funcionario_id: 1, pin: '1234', tipo_marcacao: 'entrada', marcado_em: '2026-09-14T10:00', motivo: 'esqueci' };

  let id;
  await t.test('pedido entra pendente e NÃO altera a apuração', async () => {
    const r = await rpc(db, 'solicitar_correcao', pedido);
    assert.equal(r.ok, true); id = r.id;
    const d = await db.query(`select status from ponto.apurar(1, '2026-09-14', '2026-09-14')`);
    assert.equal(d.rows[0].status, 'falta');
  });
  await t.test('exige motivo e data plausível', async () => {
    assert.equal((await rpc(db, 'solicitar_correcao', { ...pedido, motivo: '  ' })).erro, 'motivo_obrigatorio');
    assert.equal((await rpc(db, 'solicitar_correcao', { ...pedido, marcado_em: '2026-12-01T10:00' })).erro, 'data_invalida');
    assert.equal((await rpc(db, 'solicitar_correcao', { ...pedido, marcado_em: '2025-01-01T10:00' })).erro, 'data_invalida');
  });
  await t.test('o dono aprova e a marcação passa a valer', async () => {
    assert.equal((await rpc(db, 'admin_decidir_correcao', { sessao, id, aprovar: true, motivo: 'ok' })).ok, true);
    const d = await db.query(`select status from ponto.apurar(1, '2026-09-14', '2026-09-14')`);
    assert.equal(d.rows[0].status, 'incompleto');   // tem entrada, falta o resto
  });
  await t.test('decisão só vale uma vez; correção não pode ser apagada', async () => {
    assert.equal((await rpc(db, 'admin_decidir_correcao', { sessao, id, aprovar: false })).erro, 'correcao_invalida');
    assert.match(await erro(db.exec('delete from ponto.ajuste')), /não podem ser apagadas/);
    assert.match(await erro(db.exec("update ponto.ajuste set motivo = 'x' where id = 1")), /decidida uma vez/);
  });
  await t.test('recusado não entra na apuração', async () => {
    const r = await rpc(db, 'solicitar_correcao', { ...pedido, tipo_marcacao: 'saida', marcado_em: '2026-09-14T16:15' });
    await rpc(db, 'admin_decidir_correcao', { sessao, id: r.id, aprovar: false, motivo: 'não confere' });
    const d = await db.query(`select saida from ponto.apurar(1, '2026-09-14', '2026-09-14')`);
    assert.equal(d.rows[0].saida, null);
  });
  await t.test('limite de 5 pedidos pendentes por funcionário', async () => {
    let ultimo;
    for (let i = 0; i < 6; i++) ultimo = await rpc(db, 'solicitar_correcao', { ...pedido, marcado_em: `2026-09-0${i + 1}T10:00` });
    assert.equal(ultimo.erro, 'muitos_pedidos_pendentes');
  });
});

test('API: só funções api_*, admin exige sessão, login com bloqueio', async (t) => {
  const { db } = await pronto();
  await db.exec(`insert into ponto.admin (email, senha_hash)
    values ('dono@teste.com', extensions.crypt('senha-teste', extensions.gen_salt('bf', 4)))`);

  await t.test('função inexistente ou fora do padrão api_*', async () => {
    for (const fn of ['nao_existe', 'verificar_pin', 'registrar_marcacao', 'x; drop schema ponto', 'ADMIN_LOGIN', '', null]) {
      assert.equal((await rpc(db, fn)).erro, 'funcao_desconhecida', String(fn));
    }
  });
  await t.test('operações de admin sem sessão (ou com sessão falsa) são recusadas', async () => {
    for (const fn of ['admin_empresas', 'admin_funcionarios', 'admin_criar_estacao', 'admin_apuracao', 'admin_criar_correcao', 'admin_salvar_funcionario']) {
      assert.equal((await rpc(db, fn, {})).erro, 'sessao_invalida', fn);
      assert.equal((await rpc(db, fn, { sessao: 'abc' })).erro, 'sessao_invalida', fn);
    }
  });
  await t.test('erro interno não vaza detalhes', async () => {
    const login = await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' });
    const r = await rpc(db, 'admin_apuracao', { sessao: login.sessao, funcionario_id: 'abc', ini: 'x', fim: 'y' });
    assert.deepEqual([r.ok, r.erro], [false, 'erro_interno']);
  });
  await t.test('sessão expira em 12 h e logout invalida', async () => {
    const { sessao } = await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' });
    assert.equal((await rpc(db, 'admin_empresas', { sessao })).ok, true);
    await fixarRelogio(db, '2026-09-14 21:30');
    assert.equal((await rpc(db, 'admin_empresas', { sessao })).erro, 'sessao_invalida');
    await fixarRelogio(db, '2026-09-14 09:00');
    const s2 = (await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' })).sessao;
    await rpc(db, 'admin_logout', { sessao: s2 });
    assert.equal((await rpc(db, 'admin_empresas', { sessao: s2 })).erro, 'sessao_invalida');
  });
  await t.test('5 senhas erradas bloqueiam o login por 15 minutos', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'errada' })).erro, 'credenciais_invalidas');
    }
    assert.equal((await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' })).erro, 'bloqueado');
    await fixarRelogio(db, '2026-09-14 09:16');
    assert.equal((await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' })).ok, true);
  });
});

test('cadastros pelo painel: PIN, estação e token guardado só como hash', async (t) => {
  const { db } = await pronto();
  await db.exec(`insert into ponto.admin (email, senha_hash)
    values ('dono@teste.com', extensions.crypt('senha-teste', extensions.gen_salt('bf', 4)))`);
  const sessao = (await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-teste' })).sessao;

  await t.test('PIN precisa ter 4 a 6 dígitos', async () => {
    for (const pin of ['123', '1234567', 'abcd', '12 34']) {
      assert.equal((await rpc(db, 'admin_salvar_funcionario', { sessao, empresa_id: 1, nome: 'Novo', pin })).erro, 'pin_invalido', pin);
    }
    assert.equal((await rpc(db, 'admin_salvar_funcionario', { sessao, empresa_id: 1, nome: 'Novo' })).erro, 'pin_obrigatorio');
  });
  await t.test('funcionário novo entra com PIN em bcrypt (nunca em texto)', async () => {
    const r = await rpc(db, 'admin_salvar_funcionario', { sessao, empresa_id: 1, nome: 'Duda', pin: '246810' });
    assert.equal(r.ok, true);
    const h = (await db.query('select pin_hash from ponto.funcionario where id = $1', [r.id])).rows[0].pin_hash;
    assert.match(h, /^\$2[aby]\$/);
    assert.ok(!h.includes('246810'));
  });
  await t.test('trocar o PIN desbloqueia o funcionário', async () => {
    await db.exec("update ponto.funcionario set bloqueado_ate = '2099-01-01', pin_erros = 3 where id = 1");
    assert.equal((await rpc(db, 'admin_salvar_funcionario', { sessao, id: 1, nome: 'Ana', pin: '5555' })).ok, true);
    const f = (await db.query('select bloqueado_ate, pin_erros from ponto.funcionario where id = 1')).rows[0];
    assert.equal(f.bloqueado_ate, null);
    assert.equal(f.pin_erros, 0);
  });
  await t.test('token da estação aparece uma vez e funciona; o banco só guarda o hash', async () => {
    const r = await rpc(db, 'admin_criar_estacao', { sessao, empresa_id: 1, nome: 'Caixa 2' });
    assert.equal(r.ok, true);
    assert.equal(r.token.length, 48);
    const linhas = (await db.query('select token_hash from ponto.estacao where id = $1', [r.id])).rows;
    assert.notEqual(linhas[0].token_hash, r.token);
    assert.equal((await rpc(db, 'estacao', { token: r.token })).estacao.nome, 'Caixa 2');
    const lista = await rpc(db, 'admin_estacoes', { sessao, empresa_id: 1 });
    assert.ok(!JSON.stringify(lista).includes(r.token));
    await rpc(db, 'admin_desativar_estacao', { sessao, id: r.id });
    assert.equal((await rpc(db, 'estacao', { token: r.token })).erro, 'estacao_invalida');
  });
  await t.test('jornada com vigência: vale a mais recente até a data', async () => {
    assert.equal((await rpc(db, 'admin_salvar_jornada', { sessao, funcionario_id: 1, vigencia_inicio: '2026-09-20',
      dias_trabalho: [1, 2, 3, 4, 5, 6], entrada: '08:00', saida: '14:15', intervalo_min: 15 })).ok, true);
    const antes = await db.query(`select prevista_entrada::text e from ponto.apurar(1, '2026-09-19', '2026-09-19')`);
    await fixarRelogio(db, '2026-09-21 12:00');
    const r = await db.query(`select data::text d, prevista_entrada::text e from ponto.apurar(1, '2026-09-19', '2026-09-21') order by data`);
    assert.deepEqual(r.rows.map((x) => x.e), ['10:00:00', '08:00:00', '08:00:00']);
  });
});

test('primeiro acesso do admin por código de instalação (uso único)', async (t) => {
  const { db } = await pronto();
  await db.exec(`insert into ponto.config (chave, valor) values ('codigo_instalacao_hash', ponto.sha256_hex('CODIGO-123'))`);

  await t.test('sem admin, a página é avisada de que precisa do primeiro acesso', async () => {
    assert.equal((await rpc(db, 'admin_status')).precisa_primeiro_acesso, true);
  });
  await t.test('código errado, e-mail ruim e senha curta são recusados', async () => {
    assert.equal((await rpc(db, 'admin_primeiro_acesso', { codigo: 'errado', email: 'a@b.com', senha: 'senha-bem-longa' })).erro, 'codigo_invalido');
    assert.equal((await rpc(db, 'admin_primeiro_acesso', { codigo: 'CODIGO-123', email: 'sem-arroba', senha: 'senha-bem-longa' })).erro, 'email_invalido');
    assert.equal((await rpc(db, 'admin_primeiro_acesso', { codigo: 'CODIGO-123', email: 'a@b.com', senha: 'curta' })).erro, 'senha_curta');
  });
  await t.test('código certo cria o admin e o código deixa de valer', async () => {
    assert.equal((await rpc(db, 'admin_primeiro_acesso', { codigo: 'CODIGO-123', email: 'Dono@Teste.com', senha: 'senha-bem-longa' })).ok, true);
    assert.equal((await rpc(db, 'admin_status')).precisa_primeiro_acesso, false);
    assert.equal((await rpc(db, 'admin_primeiro_acesso', { codigo: 'CODIGO-123', email: 'outro@x.com', senha: 'outra-senha-longa' })).erro, 'ja_configurado');
    assert.equal((await db.query("select count(*)::int n from ponto.config")).rows[0].n, 0);
    const login = await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-bem-longa' });
    assert.equal(login.ok, true);
  });
  await t.test('troca de senha exige a atual e encerra as outras sessões', async () => {
    const s1 = (await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-bem-longa' })).sessao;
    const s2 = (await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-bem-longa' })).sessao;
    assert.equal((await rpc(db, 'admin_trocar_senha', { sessao: s1, atual: 'errada', nova: 'nova-senha-longa' })).erro, 'senha_atual_incorreta');
    assert.equal((await rpc(db, 'admin_trocar_senha', { sessao: s1, atual: 'senha-bem-longa', nova: 'curta' })).erro, 'senha_curta');
    assert.equal((await rpc(db, 'admin_trocar_senha', { sessao: s1, atual: 'senha-bem-longa', nova: 'nova-senha-longa' })).ok, true);
    assert.equal((await rpc(db, 'admin_empresas', { sessao: s1 })).ok, true);
    assert.equal((await rpc(db, 'admin_empresas', { sessao: s2 })).erro, 'sessao_invalida');
    assert.equal((await rpc(db, 'admin_login', { email: 'dono@teste.com', senha: 'senha-bem-longa' })).erro, 'credenciais_invalidas');
  });
});

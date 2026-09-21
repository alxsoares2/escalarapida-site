// Cliente da API do ponto + utilitários de formatação. Sem dependências.
(function () {
  const TZ = 'America/Recife';

  // Toda chamada passa por public.ponto_rpc(p_fn, p_args). Nunca lança por erro de regra:
  // devolve {ok:false, erro:'codigo'}. Só falhas de rede viram {ok:false, erro:'rede'}.
  async function rpc(fn, args) {
    const cfg = window.PONTO_CONFIG;
    if (!cfg || !cfg.anonKey || cfg.anonKey.startsWith('COLE_AQUI')) {
      return { ok: false, erro: 'sem_configuracao' };
    }
    try {
      const r = await fetch(cfg.url + '/rest/v1/rpc/ponto_rpc', {
        method: 'POST',
        headers: {
          apikey: cfg.anonKey,
          Authorization: 'Bearer ' + cfg.anonKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ p_fn: fn, p_args: args || {} })
      });
      if (!r.ok) return { ok: false, erro: 'rede' };
      return await r.json();
    } catch (e) {
      return { ok: false, erro: 'rede' };
    }
  }

  const ERROS = {
    rede: 'Sem conexão com o servidor. Tente de novo.',
    sem_configuracao: 'Sistema ainda não configurado.',
    erro_interno: 'Erro inesperado. Tente de novo.',
    estacao_invalida: 'Este computador não está autorizado (ou foi desativado).',
    funcionario_invalido: 'Funcionário não encontrado.',
    pin_invalido: 'PIN incorreto.',
    bloqueado: 'Bloqueado por tentativas erradas. Aguarde alguns minutos.',
    marcacao_fora_de_sequencia: 'Essa marcação não é a esperada agora.',
    marcacao_repetida: 'Você acabou de marcar. Aguarde alguns segundos.',
    data_invalida: 'Data ou horário inválido.',
    motivo_obrigatorio: 'Informe o motivo.',
    muitos_pedidos_pendentes: 'Você já tem 5 pedidos aguardando o gestor.',
    sessao_invalida: 'Sessão expirada. Entre novamente.',
    credenciais_invalidas: 'E-mail ou senha incorretos.',
    codigo_invalido: 'Código de instalação inválido.',
    ja_configurado: 'O acesso já foi criado. Entre com seu e-mail e senha.',
    email_invalido: 'E-mail inválido.',
    senha_curta: 'A senha precisa ter pelo menos 10 caracteres.',
    senha_atual_incorreta: 'Senha atual incorreta.',
    pin_obrigatorio: 'Informe um PIN de 4 a 6 dígitos.',
    nome_obrigatorio: 'Informe o nome.',
    dias_obrigatorios: 'Marque pelo menos um dia de trabalho.',
    domingo_invalido: 'Só é possível escolher domingos do mês selecionado.',
    correcao_invalida: 'Essa correção já foi decidida ou não existe.',
    excecao_invalida: 'Exceção não encontrada.',
    empresa_obrigatoria: 'Escolha a empresa.',
    funcao_desconhecida: 'Operação desconhecida.'
  };
  const msgErro = (c) => ERROS[c] || 'Não foi possível concluir (' + c + ').';

  // Escapa texto do usuário antes de entrar em innerHTML.
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Datas/horas sempre no fuso de Recife, independente do computador.
  const hora = (iso) => iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—';
  const dataHora = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
  const dataBR = (ymd) => ymd ? ymd.slice(8, 10) + '/' + ymd.slice(5, 7) + '/' + ymd.slice(0, 4) : '';
  const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  // Minutos -> "1h05", "45min", "-20min", "+1h30".
  function min(m, comSinal) {
    if (m == null) return '—';
    const sinal = m < 0 ? '-' : (comSinal && m > 0 ? '+' : '');
    const a = Math.abs(m), h = Math.floor(a / 60), r = a % 60;
    return sinal + (h ? h + 'h' + (r ? String(r).padStart(2, '0') : '') : r + 'min');
  }

  const TIPOS = {
    entrada: 'Entrada', saida_intervalo: 'Saída para intervalo',
    volta_intervalo: 'Volta do intervalo', saida: 'Saída'
  };

  // Hoje em Recife como YYYY-MM-DD.
  const hojeISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });

  window.Ponto = { rpc, msgErro, esc, hora, dataHora, dataBR, DIAS_SEMANA, MESES, min, TIPOS, hojeISO, TZ };
})();

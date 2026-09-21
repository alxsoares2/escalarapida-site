// Configuração pública do ponto eletrônico.
// A chave "anon" do Supabase é PÚBLICA por desenho (fica visível no navegador de qualquer forma).
// Ela só consegue executar public.ponto_rpc; todo o resto é bloqueado no banco.
// NUNCA colocar aqui a chave service_role.
window.PONTO_CONFIG = {
  url: 'https://dhmlltvdyhavpoyazaph.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRobWxsdHZkeWhhdnBveWF6YXBoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5Mjg5NjksImV4cCI6MjA5ODUwNDk2OX0.lCTjHMVXZloENjmwl9h3LNI-B6nUMoLOHNm3-F9pjdc',

  // Impressão do comprovante (impressora térmica não fiscal, ex.: Elgin i9)
  imprimirAoMarcar: true,   // imprime sozinho depois de cada marcação
  larguraCupomMm: 80        // largura da bobina em mm: 80 ou 58
};

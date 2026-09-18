'use strict';

// ============================================================
// Teste do módulo Trello (src/trello.js). Sem rede.
// O gabarito dos títulos são cartões REAIS do quadro de produção do DTFclub.
// ============================================================

const crypto = require('crypto');
const t = require('../src/trello');

let falhas = 0;
function checar(nome, condicao, extra) {
  if (condicao) { console.log('[trello] OK   ' + nome); return; }
  falhas++;
  console.error('[trello] FALHOU ' + nome + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
}

// ---- título no padrão da equipe (cartões reais do quadro) ----
const tit = t.montarTituloCartao;
checar('#2974 - 8168 - GREEN SOLARI - 6 METROS',
  tit({ pedido: '2974', telefone: '5581991238168', nome: 'Green Solari', quantidade: '6 metros' }) === '#2974 - 8168 - GREEN SOLARI - 6 METROS',
  tit({ pedido: '2974', telefone: '5581991238168', nome: 'Green Solari', quantidade: '6 metros' }));
checar('#2999 - 2380 - MARCELINHO - 100 UNIDADES',
  tit({ pedido: 2999, telefone: '5581988882380', nome: 'Marcelinho', quantidade: '100 unidades' }) === '#2999 - 2380 - MARCELINHO - 100 UNIDADES');
checar('observação entre parênteses (#2583 ... AGUARDANDO CLIENTE ENVIAR ARTE)',
  tit({ pedido: '2583', telefone: '5581900000156', nome: 'MNeves', quantidade: '2 metros', observacao: 'aguardando cliente enviar arte' })
    === '#2583 - 0156 - MNEVES - 2 METROS (AGUARDANDO CLIENTE ENVIAR ARTE)');
checar('sem pedido fica como "6040 - ELETROTEL"',
  tit({ telefone: '5581999996040', nome: 'Eletrotel' }) === '6040 - ELETROTEL', tit({ telefone: '5581999996040', nome: 'Eletrotel' }));
checar('emoji some do nome ("🥶 Green Solari")', t.limparNomeParaCartao('🥶 Green  Solari') === 'GREEN SOLARI', t.limparNomeParaCartao('🥶 Green  Solari'));
checar('lead só com emoji não deixa " -  - " no título',
  tit({ pedido: '1', telefone: '5581999991234', nome: '🥶' }) === '#1 - 1234', tit({ pedido: '1', telefone: '5581999991234', nome: '🥶' }));
checar('pedido com "#" digitado não vira "##"', tit({ pedido: '#2974', telefone: '5581991238168', nome: 'X' }).startsWith('#2974 -'));

// ---- assinatura do webhook ----
const secret = 's3cr3t';
const callback = 'https://app.movatak.com.br/movatak/webhook/trello';
const corpo = '{"action":{"type":"updateCard","data":{"card":{"id":"abc","name":"Pedido é ação"}}}}';
const sig = crypto.createHmac('sha1', secret).update(corpo + callback).digest('base64');
checar('assinatura válida é aceita', t.verificarAssinaturaTrello(corpo, callback, sig, secret));
checar('corpo adulterado é recusado', !t.verificarAssinaturaTrello(corpo.replace('abc', 'xyz'), callback, sig, secret));
checar('secret errado é recusado', !t.verificarAssinaturaTrello(corpo, callback, sig, 'outro'));
checar('sem assinatura é recusado', !t.verificarAssinaturaTrello(corpo, callback, '', secret));
checar('JSON re-serializado com escape (\\u00e9) NÃO passa — tem que ser o corpo cru',
  !t.verificarAssinaturaTrello(JSON.stringify(JSON.parse(corpo)).replace('é', '\\u00e9'), callback, sig, secret));

// ---- interpretação dos eventos ----
const mover = { action: { type: 'updateCard', data: { card: { id: 'c1', closed: false },
  listBefore: { id: 'L1', name: 'ARTES PARA PRODUZIR' }, listAfter: { id: 'L2', name: 'NA MÁQUINA' } } } };
const ev = t.interpretarEventoTrello(mover);
checar('mover de lista vira a etapa da lista nova', ev && ev.etapa === 'NA MÁQUINA' && ev.listaId === 'L2' && !ev.arquivado, ev);
const arquivar = { action: { type: 'updateCard', data: { card: { id: 'c1', closed: true }, old: { closed: false } } } };
checar('arquivar = Concluído', (t.interpretarEventoTrello(arquivar) || {}).etapa === t.ETAPA_CONCLUIDO);
const desarq = { action: { type: 'updateCard', data: { card: { id: 'c1', closed: false }, old: { closed: true } } } };
checar('desarquivar é reconhecido', (t.interpretarEventoTrello(desarq) || {}).desarquivado === true);
const renomear = { action: { type: 'updateCard', data: { card: { id: 'c1' }, old: { name: 'x' } } } };
checar('renomear cartão não muda etapa (ignora)', t.interpretarEventoTrello(renomear) === null);
const comentar = { action: { type: 'commentCard', data: { card: { id: 'c1' }, text: 'oi' } } };
checar('comentário é ignorado', t.interpretarEventoTrello(comentar) === null);
checar('payload vazio é ignorado', t.interpretarEventoTrello({}) === null);

// ---- trava ----
checar('desligado não é configurado', !t.trelloConfigurado({ trello_ativo: false, trello_board_id: 'b', trello_api_key: 'k', trello_token: 't' }));
checar('sem quadro não é configurado', !t.trelloConfigurado({ trello_ativo: true, trello_board_id: null, trello_api_key: 'k', trello_token: 't' }));
checar('completo é configurado', t.trelloConfigurado({ trello_ativo: true, trello_board_id: 'b', trello_api_key: 'k', trello_token: 't' }));

if (falhas) { console.error('\n[trello] ' + falhas + ' falha(s).'); process.exit(1); }
console.log('\n[trello] OK — todas as verificações passaram.');

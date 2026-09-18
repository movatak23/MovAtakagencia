'use strict';

// ============================================================
// Teste do módulo Meta CAPI (src/meta_capi.js).
//
// Verifica o que a Meta rejeita na prática: telefone fora do E.164, contato não
// hasheado, action_source errado e evento com nome inválido. Nenhuma chamada de rede:
// testa só a montagem e as travas. Roda em `npm test`.
// ============================================================

const crypto = require('crypto');
const capi = require('../src/meta_capi');

let falhas = 0;
function checar(nome, condicao, extra) {
  if (condicao) { console.log('[meta-capi] OK   ' + nome); return; }
  falhas++;
  console.error('[meta-capi] FALHOU ' + nome + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
}

// ---- telefone -> E.164 só dígitos ----
const n = capi.normalizarTelefoneParaMeta;
checar('celular com DDD ganha o 55', n('81987654321') === '5581987654321', n('81987654321'));
checar('número já com DDI fica igual', n('5581987654321') === '5581987654321');
checar('máscara é limpa', n('+55 (81) 98765-4321') === '5581987654321', n('+55 (81) 98765-4321'));
checar('fixo de 10 dígitos também', n('8133334444') === '558133334444', n('8133334444'));
checar('vazio vira null', n('') === null);
checar('lixo vira null', n('abc') === null);
checar('id de grupo (longo demais) vira null', n('120363156176120070') === null, n('120363156176120070'));

// ---- hash ----
const esperado = crypto.createHash('sha256').update('5581987654321').digest('hex');
checar('telefone sai hasheado em SHA-256', capi.hashSha256('5581987654321') === esperado);
const ud = capi.montarUserData({ telefone: '+55 81 98765-4321' });
checar('user_data manda ph como array', Array.isArray(ud.ph) && ud.ph.length === 1);
checar('user_data NÃO leva telefone em texto puro',
  JSON.stringify(ud).indexOf('5581987654321') === -1, ud);
checar('lead sem telefone não gera user_data', capi.montarUserData({ telefone: null }) === null);

// ---- payload ----
const cliente = { id: 1, meta_capi_ativo: true, meta_dataset_id: '123', meta_access_token: 'tok' };
const lead = { id: 42, telefone: '5581987654321' };
const quando = new Date('2026-09-18T01:23:45Z');
const p = capi.montarPayload(cliente, lead, 'Purchase', { valor: 250.5, quando });
const ev = p.data[0];
checar('action_source é physical_store (exigido em offline)', ev.action_source === 'physical_store', ev.action_source);
checar('event_time em segundos', ev.event_time === Math.floor(quando.getTime() / 1000), ev.event_time);
checar('valor e moeda entram em custom_data',
  ev.custom_data.value === 250.5 && ev.custom_data.currency === 'BRL', ev.custom_data);
checar('sem valor não manda custom_data',
  capi.montarPayload(cliente, lead, 'Lead', { quando }).data[0].custom_data === undefined);
checar('event_id é estável no mesmo minuto',
  capi.montarEventId(42, 'Purchase', quando) === capi.montarEventId(42, 'Purchase', quando));
checar('event_id muda em minuto diferente',
  capi.montarEventId(42, 'Purchase', quando) !== capi.montarEventId(42, 'Purchase', new Date('2026-09-18T01:24:45Z')));
checar('test_event_code só aparece quando configurado',
  p.test_event_code === undefined &&
  capi.montarPayload({ ...cliente, meta_test_event_code: 'TEST123' }, lead, 'Lead', { quando }).test_event_code === 'TEST123');

// ---- travas ----
checar('cliente desligado não é considerado configurado',
  !capi.clienteConfigurado({ ...cliente, meta_capi_ativo: false }));
checar('sem dataset não é configurado', !capi.clienteConfigurado({ ...cliente, meta_dataset_id: null }));
checar('sem token não é configurado', !capi.clienteConfigurado({ ...cliente, meta_access_token: null }));
checar('cliente completo é configurado', capi.clienteConfigurado(cliente));

(async () => {
  // Envio com cliente desligado tem que sair sem tocar a rede.
  const r1 = await capi.enviarEventoMeta({ ...cliente, meta_capi_ativo: false }, lead, 'Lead');
  checar('desligado não envia', r1.ok === false && r1.motivo === 'desligado', r1);
  const r2 = await capi.enviarEventoMeta(cliente, lead, 'EventoQueNaoExiste');
  checar('evento fora da lista é recusado antes de enviar',
    r2.ok === false && String(r2.motivo).startsWith('evento nao suportado'), r2);

  if (falhas) {
    console.error('\n[meta-capi] ' + falhas + ' falha(s).');
    process.exit(1);
  }
  console.log('\n[meta-capi] OK — todas as verificações passaram.');
})();

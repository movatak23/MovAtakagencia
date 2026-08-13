'use strict';

const { query, garantirEstruturaConversas } = require('./db');
const { emitirLeadFlags, emitirMensagemLead } = require('./realtime');

// ============================================================
// Leads — auditoria, atendimento e registro de conversas
// (movido verbatim do index.js na Fase 3a)
// ============================================================
async function registrarEventoLead(leadId, clienteId, tipo, descricao, dados = {}) {
  try {
    if (!leadId || !clienteId || !tipo) return;
    await query(
      `INSERT INTO movatak_lead_eventos (lead_id, cliente_id, tipo, descricao, dados)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [leadId, clienteId, tipo, descricao || null, JSON.stringify(dados || {})]
    );
  } catch (e) {
    // Não deixa auditoria derrubar o CRM se a migração ainda não foi aplicada.
    console.error('[evento-lead]', e.message);
  }
}

// Para TODA a automação de um lead: marca a flag, pausa follow-ups pendentes e
// cancela o questionário em andamento. Usada pelo comando de parar atendimento,
// disparado tanto pelo cliente quanto pelo vendedor/dono.
async function pararAtendimentoLead(clienteId, leadId, origem, comando) {
  await query(
    `UPDATE movatak_leads SET automacao_pausada = true, atualizado_em = NOW() WHERE id = $1`,
    [leadId]
  );
  // Se quem pediu foi o LEAD (comando dele ou transferência automática por
  // respostas inválidas), sinaliza pro time: chip "Pediu atendente" no inbox
  // e marca a conversa como não lida pra entrar no contador da aba.
  if (origem !== 'vendedor') {
    await query(
      `UPDATE movatak_leads SET pediu_atendente = true, pediu_atendente_em = NOW(), nao_lida = true WHERE id = $1`,
      [leadId]
    ).catch(() => null);
    // Tempo real: acende o chip 🙋 no inbox e o badge no cabeçalho na hora,
    // sem depender do reload do funil.
    emitirLeadFlags(clienteId, leadId, { pediu_atendente: true, nao_lida: true, automacao_pausada: true });
  }
  await query(
    `UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`,
    [leadId]
  );
  await query(
    `UPDATE movatak_questionario_estado SET status = 'cancelado', atualizado_em = NOW()
       WHERE lead_id = $1 AND status = 'em_andamento'`,
    [leadId]
  ).catch(() => null);
  await registrarEventoLead(leadId, clienteId, 'atendimento_parado', 'Automação encerrada por comando de atendente', { origem: origem || null, comando: comando || null }).catch(() => null);
  console.log(`[zapi] Atendimento parado (${origem}) -> lead ${leadId}`);
}

// Mensagem automática enviada ao LEAD quando ele mesmo usa o comando de parar
// atendimento (ex: #atendente). Avisa que em breve ele será atendido por um humano.
// O texto é configurável no painel (Auto Atendimento); se vazio, usa o padrão.
// Suporta o placeholder {nome} (primeiro nome do lead), igual às demais mensagens.
// Limpa o sinal de "pediu atendente" assim que um humano assume a conversa
// (mensagem manual pelo painel, kanban, vendedor ou WhatsApp Web), ou quando a
// automação é reativada. Condicional em pediu_atendente=true pra não gerar
// writes desnecessários em todo envio.
async function limparPedidoAtendente(leadId) {
  if (!leadId) return;
  const r = await query(
    `UPDATE movatak_leads SET pediu_atendente = false WHERE id = $1 AND pediu_atendente = true RETURNING id, cliente_id`,
    [leadId]
  ).catch(() => null);
  // Só emite se realmente mudou (o UPDATE condicional retorna linha só nesse caso).
  if (r && r.rows && r.rows.length) {
    emitirLeadFlags(r.rows[0].cliente_id, r.rows[0].id, { pediu_atendente: false });
  }
}

function normalizarReplyInfoConversa(replyInfo) {
  if (!replyInfo) return {
    reply_to_conversa_id: null,
    reply_to_msg_id: null,
    reply_to_direcao: null,
    reply_to_conteudo: null,
    reply_to_midia_url: null,
    reply_to_midia_tipo: null,
    reply_payload: null
  };
  return {
    reply_to_conversa_id: replyInfo.reply_to_conversa_id || replyInfo.conversa_id || null,
    reply_to_msg_id: replyInfo.reply_to_msg_id || replyInfo.msg_id || null,
    reply_to_direcao: replyInfo.reply_to_direcao || replyInfo.direcao || null,
    reply_to_conteudo: replyInfo.reply_to_conteudo || replyInfo.conteudo || null,
    reply_to_midia_url: replyInfo.reply_to_midia_url || replyInfo.midia_url || null,
    reply_to_midia_tipo: replyInfo.reply_to_midia_tipo || replyInfo.midia_tipo || null,
    reply_payload: replyInfo.reply_payload || null
  };
}

async function registrarConversa(leadId, clienteId, direcao, conteudo, midiaUrl, midiaTipo, msgId, replyInfo = null, origem = 'humano', midiaNome = null) {
  if (!leadId || !clienteId) return null;
  await garantirEstruturaConversas();
  // Evita duplicar a mesma mensagem do WhatsApp: se já existe uma conversa com esse
  // msg_id pra esse lead, não insere de novo.
  if (msgId) {
    const existe = await query(
      'SELECT id FROM movatak_conversas WHERE lead_id=$1 AND msg_id=$2 LIMIT 1',
      [leadId, msgId]
    ).catch(() => ({ rows: [] }));
    if (existe.rows.length) return null; // já registrada — não duplica nem reemite socket
  }
  const reply = normalizarReplyInfoConversa(replyInfo);
  const ins = await query(
    `INSERT INTO movatak_conversas
       (lead_id, cliente_id, direcao, conteudo, midia_url, midia_tipo, midia_nome, msg_id,
        reply_to_conversa_id, reply_to_msg_id, reply_to_direcao, reply_to_conteudo,
        reply_to_midia_url, reply_to_midia_tipo, reply_payload, origem)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16) RETURNING id`,
    [
      leadId, clienteId, direcao, conteudo || null, midiaUrl || null, midiaTipo || null, midiaNome || null, msgId || null,
      reply.reply_to_conversa_id, reply.reply_to_msg_id, reply.reply_to_direcao, reply.reply_to_conteudo,
      reply.reply_to_midia_url, reply.reply_to_midia_tipo, JSON.stringify(reply.reply_payload || {}),
      direcao === 'entrada' ? 'lead' : (origem || 'humano')
    ]
  ).catch(e => { console.error('[conversa] erro ao registrar:', e.message); return null; });
  if (!ins || !ins.rows.length) return null;
  const novoId = ins.rows[0].id;

  // Regra correta de leitura da caixa de entrada:
  // - entrada do cliente => fica não lida;
  // - saída do vendedor/painel/WhatsApp Web => limpa o não lido.
  // Isso evita que mensagens enviadas pelo próprio WhatsApp Web apareçam como novas.
  if (direcao === 'entrada') {
    query(`UPDATE movatak_leads SET nao_lida = true, atualizado_em = NOW() WHERE id = $1`, [leadId]).catch(() => null);
  } else if (direcao === 'saida') {
    // Não marca como lida se o lead PEDIU atendente: enquanto ele aguarda um humano,
    // a confirmação automática (e qualquer envio do bot) não pode tirar o contato da
    // aba de não-lidas. Some só quando um humano assume (abre no painel = read, ou
    // responde = limparPedidoAtendente). Leads normais (pediu_atendente=false) seguem
    // igual: saída limpa o não-lido.
    // Sync de leitura CRM->WhatsApp: assim que o CRM considera lido (saída limpou o
    // não-lido), espelha no aparelho marcando o chat como lido — cobre o caso da
    // automação (questionário/IA/follow-up) que responde sem ninguém abrir a conversa,
    // que deixava o WhatsApp com badge de não-lido pra sempre. Encadeado após o UPDATE
    // (evita corrida) e fire-and-forget. A própria função checa nao_lida e tem trava
    // anti-spam (zap_lido_msg_id), então só chama a Z-API quando há inbound novo.
    query(`UPDATE movatak_leads SET nao_lida = false, atualizado_em = NOW() WHERE id = $1 AND COALESCE(pediu_atendente, false) = false`, [leadId])
      .then(() => require('./leitura').marcarChatLidoNoZap(leadId))
      .catch(() => null);
  }

  // Avisa qualquer painel aberto desse cliente que chegou mensagem nova,
  // sem precisar dar reload na tela.
  emitirMensagemLead(clienteId, leadId, {
    id: novoId,
    direcao,
    conteudo: conteudo || '',
    midia_url: midiaUrl || null,
    midia_tipo: midiaTipo || null,
    midia_nome: midiaNome || null,
    msg_id: msgId || null,
    reply_to_conversa_id: reply.reply_to_conversa_id,
    reply_to_msg_id: reply.reply_to_msg_id,
    reply_to_direcao: reply.reply_to_direcao,
    reply_to_conteudo: reply.reply_to_conteudo,
    reply_to_midia_url: reply.reply_to_midia_url,
    reply_to_midia_tipo: reply.reply_to_midia_tipo,
    criado_em: new Date().toISOString()
  });
  return novoId;
}


module.exports = {
  registrarConversa,
  registrarEventoLead,
  pararAtendimentoLead,
  limparPedidoAtendente,
};

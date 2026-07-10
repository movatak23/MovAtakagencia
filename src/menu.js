'use strict';

// ============================================================
// Menu de Atendimento — boas-vindas, envio do menu de setores e
// tratamento da resposta do lead. (movido verbatim do index.js)
// ============================================================
const { query } = require('./db');
const { zapiEnviar, zapiMarcarNaoLido } = require('./zapi');
const { registrarConversa, registrarEventoLead, pararAtendimentoLead } = require('./leads');
const { ehGrupoOuCanal } = require('./util');
const { iniciarQuestionarioPorTemplate } = require('./questionario');

async function enviarBoasVindasLead(cliente, telefone) {
  try {
    // Trava de segurança: nunca envia boas-vindas para grupos ou canais.
    if (ehGrupoOuCanal(telefone)) return;
    const msg1 = (cliente.boas_vindas_lead_msg1 || '').trim();
    const msg2 = (cliente.boas_vindas_lead_msg2 || '').trim();
    if (!msg1 && !msg2) return; // nada preenchido → não envia nada (comportamento idêntico ao de hoje)
    if (msg1) {
      await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, msg1).catch(e => console.error('[boas-vindas][msg1]', e.message));
    }
    if (msg2) {
      const delaySeg = Math.min(Math.max(parseInt(cliente.boas_vindas_lead_delay) || 5, 1), 60);
      await new Promise(r => setTimeout(r, delaySeg * 1000));
      await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, msg2).catch(e => console.error('[boas-vindas][msg2]', e.message));
    }
  } catch (e) {
    console.error('[boas-vindas]', e.message);
  }
}

async function enviarMenuAtendimento(cliente, lead) {
  try {
    const texto = (cliente.menu_atend_texto || '').trim();
    if (!texto) return false;
    await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, lead.telefone, texto);
    await registrarConversa(lead.id, cliente.id, 'saida', texto, null, null, null, null, 'menu').catch(() => null);
    // Pausa o follow-up enquanto o lead decide o setor
    await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [lead.id]).catch(() => null);
    // Cria/atualiza o estado de menu (encerra estados antigos do mesmo lead)
    await query(`UPDATE movatak_menu_estado SET status='cancelado', atualizado_em=NOW() WHERE lead_id=$1 AND status='aguardando'`, [lead.id]).catch(() => null);
    await query(
      `INSERT INTO movatak_menu_estado (cliente_id, lead_id, status, tentativas) VALUES ($1, $2, 'aguardando', 0)`,
      [cliente.id, lead.id]
    );
    await registrarEventoLead(lead.id, cliente.id, 'menu_enviado', 'Menu de atendimento enviado ao lead', {}).catch(() => null);
    return true;
  } catch (e) {
    console.error('[menu][enviar]', e.message);
    return false;
  }
}

async function processarRespostaMenu(cliente, lead, estado, texto) {
  try {
    const mapa = Array.isArray(cliente.menu_atend_mapa) ? cliente.menu_atend_mapa : [];
    const resp = String(texto || '').trim().toLowerCase();

    // Tenta casar por resposta exata (número) OU pelo nome do setor
    let escolha = mapa.find(m => String(m.resposta).trim().toLowerCase() === resp);
    if (!escolha) {
      // Casa pelo nome do setor digitado
      const setoresRes = await query('SELECT id, nome FROM movatak_setores WHERE cliente_id=$1', [cliente.id]).catch(() => ({ rows: [] }));
      const setorPorNome = setoresRes.rows.find(s => String(s.nome).trim().toLowerCase() === resp);
      if (setorPorNome) escolha = mapa.find(m => Number(m.setor_id) === Number(setorPorNome.id));
    }

    if (escolha) {
      // Grava o setor
      await query('UPDATE movatak_leads SET setor_id=$1, atualizado_em=NOW() WHERE id=$2', [escolha.setor_id, lead.id]);
      // Move para a coluna do kanban, se a opção tiver coluna definida
      if (escolha.coluna_id) {
        await query('UPDATE movatak_leads SET funil_coluna_id=$1, atualizado_em=NOW() WHERE id=$2', [escolha.coluna_id, lead.id]).catch(() => null);
      }
      await query(`UPDATE movatak_menu_estado SET status='concluido', atualizado_em=NOW() WHERE id=$1`, [estado.id]).catch(() => null);
      await registrarEventoLead(lead.id, cliente.id, 'menu_respondido', 'Lead escolheu setor pelo menu', { resposta: resp, setor_id: escolha.setor_id, coluna_id: escolha.coluna_id || null, template_id: escolha.template_id || null }).catch(() => null);
      // Se a opção aponta para um autoatendimento próprio, inicia ele agora.
      if (escolha.template_id) {
        await iniciarQuestionarioPorTemplate(cliente, lead, escolha.template_id).catch(e => console.error('[menu][template-start]', e.message));
      }
      // Ação automática ao final do menu: marcar como não lido no WhatsApp (via Z-API)
      if (cliente.menu_atend_marcar_nao_lido && cliente.zapi_instance) {
        await zapiMarcarNaoLido(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, lead.telefone)
          .catch(e => console.error('[menu][nao-lido]', e.message));
      }
      return true;
    }

    // Resposta inválida → vai para atendimento humano (recurso existente)
    await query(`UPDATE movatak_menu_estado SET status='invalido', atualizado_em=NOW() WHERE id=$1`, [estado.id]).catch(() => null);
    await pararAtendimentoLead(cliente.id, lead.id, 'menu_invalido', texto).catch(e => console.error('[menu][parar]', e.message));
    return true;
  } catch (e) {
    console.error('[menu][resposta]', e.message);
    return false;
  }
}


module.exports = {
  enviarBoasVindasLead,
  enviarMenuAtendimento,
  processarRespostaMenu,
};

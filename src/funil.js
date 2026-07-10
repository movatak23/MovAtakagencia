'use strict';

// ============================================================
// Funil / distribuicao — move o lead entre colunas/etapas e faz a
// atribuicao balanceada de vendedores. (movido verbatim do index.js)
// ============================================================
const { query, garantirEstruturaFunil } = require('./db');
const { registrarEventoLead } = require('./leads');
const { zapiAtribuirEtiqueta, zapiRemoverEtiqueta } = require('./zapi');

// Deps ainda no index.js, injetadas no boot via init() (dependem de nicho/
// zapi-extractors que sairao depois). Corpo movido byte-identico.
let garantirFunilPadraoCliente, etapaSistemaPorSlug, sincronizarColunaComWhatsapp;
function init(deps) {
  ({ garantirFunilPadraoCliente, etapaSistemaPorSlug, sincronizarColunaComWhatsapp } = deps);
}

async function atribuirVendedorBalanceado(clienteId, leadId) {
  try {
    const vRes = await query(
      `SELECT id FROM movatak_vendedores WHERE cliente_id=$1 AND COALESCE(ativo,true)=true ORDER BY id ASC`,
      [clienteId]
    );
    if (!vRes.rows.length) return null;
    const counts = await query(
      `SELECT vendedor_id, COUNT(*)::int AS cnt
         FROM movatak_leads
        WHERE cliente_id=$1 AND vendedor_id IS NOT NULL
        GROUP BY vendedor_id`,
      [clienteId]
    );
    const countMap = {};
    for (const r of counts.rows) countMap[r.vendedor_id] = r.cnt;
    let minCnt = Infinity;
    for (const v of vRes.rows) {
      const c = countMap[v.id] || 0;
      if (c < minCnt) minCnt = c;
    }
    const candidatos = vRes.rows.filter(v => (countMap[v.id] || 0) === minCnt);
    const escolhido = candidatos[Math.floor(Math.random() * candidatos.length)];
    await query(
      `UPDATE movatak_leads SET vendedor_id=$1, atualizado_em=NOW() WHERE id=$2`,
      [escolhido.id, leadId]
    );
    console.log(`[funil] Lead ${leadId} atribuído ao vendedor ${escolhido.id} (mínimo: ${minCnt} leads)`);
    return escolhido.id;
  } catch (e) {
    console.error('[funil][distribuicao] Erro ao atribuir vendedor:', e.message);
    return null;
  }
}

async function moverLeadParaFunilSlug(clienteId, leadId, slug) {
  await garantirFunilPadraoCliente(clienteId);
  const col = await query(
    `SELECT id FROM movatak_funil_colunas WHERE cliente_id=$1 AND slug=$2 AND ativo=true LIMIT 1`,
    [clienteId, slug]
  );
  if (!col.rows.length) return;
  await moverLeadParaColunaFunil(leadId, col.rows[0].id, false);
}

async function moverLeadParaColunaFunil(leadId, colunaId, registrar = true) {
  await garantirEstruturaFunil();
  const r = await query(
    `SELECT l.id, l.cliente_id, l.telefone, l.nome, l.funil_coluna_id AS coluna_anterior_id,
            fc.id AS coluna_id, fc.nome AS coluna_nome, fc.slug, fc.etapa_sistema, fc.sincronizar_whatsapp, fc.zapi_tag_id, fc.setor_id AS coluna_setor_id,
            c.zapi_instance, c.zapi_token, c.zapi_client_token
       FROM movatak_leads l
       JOIN movatak_funil_colunas fc ON fc.id = $2 AND fc.cliente_id = l.cliente_id AND fc.ativo = true
       JOIN movatak_clientes c ON c.id = l.cliente_id
      WHERE l.id = $1`,
    [leadId, colunaId]
  );
  if (!r.rows.length) throw new Error('Lead ou coluna não encontrados.');
  const row = r.rows[0];
  let tagId = row.zapi_tag_id;

  if (row.sincronizar_whatsapp && !tagId) {
    try {
      tagId = await sincronizarColunaComWhatsapp(colunaId);
    } catch (e) {
      await query(`UPDATE movatak_funil_colunas SET zapi_sync_erro=$1, atualizado_em=NOW() WHERE id=$2`, [String(e.message || e).slice(0, 500), colunaId]).catch(() => null);
    }
  }

  const etapa = row.etapa_sistema || etapaSistemaPorSlug(row.slug);
  if (etapa === 'cliente') {
    await query(`UPDATE movatak_leads SET funil_coluna_id=$1, etapa=$2, convertido_em=COALESCE(convertido_em, NOW()), atualizado_em=NOW() WHERE id=$3`, [colunaId, etapa, leadId]);
    await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [leadId]).catch(() => null);
    // Distribuição balanceada: só atribui se ainda não tem vendedor
    const lr = await query(`SELECT vendedor_id FROM movatak_leads WHERE id=$1`, [leadId]);
    if (lr.rows[0] && !lr.rows[0].vendedor_id) {
      await atribuirVendedorBalanceado(row.cliente_id, leadId).catch(() => null);
    }
  } else if (etapa === 'descartado') {
    await query(`UPDATE movatak_leads SET funil_coluna_id=$1, etapa=$2, atualizado_em=NOW() WHERE id=$3`, [colunaId, etapa, leadId]);
    await query(`UPDATE movatak_followup SET status='pausado' WHERE lead_id=$1 AND status='pendente'`, [leadId]).catch(() => null);
  } else {
    await query(`UPDATE movatak_leads SET funil_coluna_id=$1, etapa=$2, atualizado_em=NOW() WHERE id=$3`, [colunaId, etapa, leadId]);
  }

  // O lead herda o setor da coluna para onde foi movido. Sem isso, o lead ficaria
  // na coluna de um setor mas com setor_id de outro — sumindo do filtro por setor e
  // do CRM do vendedor daquele setor. Só atualiza se a coluna tiver setor definido.
  if (row.coluna_setor_id) {
    await query(`UPDATE movatak_leads SET setor_id=$1, atualizado_em=NOW() WHERE id=$2`, [row.coluna_setor_id, leadId]).catch(() => null);
  }

  if (row.sincronizar_whatsapp && tagId && row.zapi_instance && row.zapi_token && row.zapi_client_token && row.telefone) {
    const tagsAntigas = await query(
      `SELECT zapi_tag_id FROM movatak_funil_colunas
        WHERE cliente_id=$1 AND ativo=true AND zapi_tag_id IS NOT NULL AND id <> $2`,
      [row.cliente_id, colunaId]
    ).catch(() => ({ rows: [] }));
    for (const t of tagsAntigas.rows) {
      await zapiRemoverEtiqueta(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, t.zapi_tag_id);
    }
    await zapiAtribuirEtiqueta(row.zapi_instance, row.zapi_token, row.zapi_client_token, row.telefone, tagId);
  }

  if (registrar) {
    await registrarEventoLead(leadId, row.cliente_id, 'funil_movido', `Lead movido para ${row.coluna_nome}`, { coluna_id: colunaId, coluna_nome: row.coluna_nome, etapa });
  }
  return { ok: true, coluna: { id: colunaId, nome: row.coluna_nome, etapa_sistema: etapa } };
}


module.exports = {
  init,
  atribuirVendedorBalanceado,
  moverLeadParaFunilSlug,
  moverLeadParaColunaFunil,
};

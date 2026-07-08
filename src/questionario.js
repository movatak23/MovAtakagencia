'use strict';

// ============================================================
// Questionario / Autoatendimento consultivo (motor)
// (movido verbatim do index.js na Fase 3b)
// ============================================================
const { query, garantirEstruturaPlanos, garantirEstruturaQuestionario } = require('./db');
const {
  zapiEnviar, zapiEnviarImagem, zapiEnviarVideo, zapiArquivar, zapiMarcarNaoLido, MOVATAK_ADMIN_WA
} = require('./zapi');
const { registrarConversa, registrarEventoLead } = require('./leads');
const { MOVATAK_QUEST_LEMBRETE_HORAS, MOVATAK_QUEST_MAX_LEMBRETES } = require('./config');

// Deps ainda no index.js, injetadas no boot via init() (saem quando 3d/funil
// forem extraidos). Como as funcoes movidas as referenciam por variavel de
// escopo do modulo, o corpo movido fica byte-a-byte identico ao original.
let agendarFollowupV2, enviarFollowupsPendentesDoLead,
    atribuirVendedorBalanceado, moverLeadParaFunilSlug, enviarMenuAtendimento,
    ehGrupoOuCanal, sleep, normalizarDelayQuestionario, normalizarCep, tipoMidia;
function init(deps) {
  ({ agendarFollowupV2, enviarFollowupsPendentesDoLead,
     atribuirVendedorBalanceado, moverLeadParaFunilSlug, enviarMenuAtendimento,
     ehGrupoOuCanal, sleep, normalizarDelayQuestionario, normalizarCep, tipoMidia } = deps);
}

async function reiniciarQuestionarioLead(cliente, lead, comando) {
  await query(
    `UPDATE movatak_leads SET automacao_pausada = false, pediu_atendente = false, etapa = 'followup', atualizado_em = NOW() WHERE id = $1`,
    [lead.id]
  );
  await query(
    `UPDATE movatak_questionario_estado SET status = 'cancelado', atualizado_em = NOW()
       WHERE lead_id = $1 AND status IN ('em_andamento','abandonado')`,
    [lead.id]
  ).catch(() => null);
  await registrarEventoLead(lead.id, cliente.id, 'questionario_reiniciado', 'Autoatendimento reiniciado por comando do vendedor', { comando: comando || null }).catch(() => null);
  await iniciarQuestionario(cliente, lead);
  console.log(`[zapi] Autoatendimento reiniciado -> lead ${lead.id}`);
}

async function enviarMsgQuestionario(cliente, telefone, texto, midia) {
  // Trava de segurança: nunca envia automação de questionário para grupos ou canais.
  if (ehGrupoOuCanal(telefone)) return null;
  // Encontra o lead_id pelo telefone para gravar na conversa
  const lr = await query('SELECT id FROM movatak_leads WHERE cliente_id=$1 AND telefone=$2 ORDER BY criado_em DESC LIMIT 1', [cliente.id, telefone]).catch(() => ({ rows: [] }));
  const leadId = lr.rows[0] ? lr.rows[0].id : null;
  let msgId = null;
  if (midia && String(midia).trim()) {
    const url = String(midia).trim();
    if (tipoMidia(url) === 'video') {
      msgId = await zapiEnviarVideo(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, url, texto);
    } else {
      msgId = await zapiEnviarImagem(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, url, texto);
    }
    // Passa o msg_id: sem ele, o webhook fromMe regravaria a mesma mensagem (duplicava na caixa).
    if (leadId) registrarConversa(leadId, cliente.id, 'saida', texto || '', midia, null, msgId, null, 'questionario').catch(() => null);
  } else {
    msgId = await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, texto);
    if (leadId) registrarConversa(leadId, cliente.id, 'saida', texto || '', null, null, msgId, null, 'questionario').catch(() => null);
  }
  return msgId;
}

async function cepTemCobertura(clienteId, cep) {
  try {
    const c = normalizarCep(cep);
    if (!c) return false;
    const r = await query(
      `SELECT 1 FROM movatak_cobertura_cep WHERE cliente_id = $1 AND $2 LIKE cep || '%' LIMIT 1`,
      [clienteId, c]
    );
    return r.rows.length > 0;
  } catch (e) {
    console.error('[questionario][cobertura] erro:', e.message);
    return false;
  }
}

function montarTextoPergunta(passo) {
  if (!passo) return '';
  const base = passo.pergunta || '';
  if (passo.tipo === 'sim_nao') {
    return base + '\n\n1 - Sim\n2 - Não';
  }
  if (passo.tipo === 'opcoes') {
    const ops = Array.isArray(passo.opcoes) ? passo.opcoes : [];
    const lista = ops.map((o, i) => `${i + 1} - ${o}`).join('\n');
    return base + (lista ? '\n\n' + lista : '');
  }
  return base; // texto e cep
}

function interpretarResposta(passo, texto) {
  const t = String(texto || '').trim();
  if (!t) return { ok: false };
  if (passo.tipo === 'cep') {
    const cep = normalizarCep(t);
    if (cep.length < 8) return { ok: false, motivo: 'cep_invalido' };
    return { ok: true, valor: cep.slice(0, 8) };
  }
  if (passo.tipo === 'sim_nao') {
    const l = t.toLowerCase();
    if (l === '1' || l === 'sim' || l === 's') return { ok: true, valor: 'Sim', indice: 1 };
    if (l === '2' || l === 'nao' || l === 'não' || l === 'n') return { ok: true, valor: 'Não', indice: 2 };
    return { ok: false };
  }
  if (passo.tipo === 'opcoes') {
    const ops = Array.isArray(passo.opcoes) ? passo.opcoes : [];
    const n = parseInt(t, 10);
    if (!isNaN(n) && n >= 1 && n <= ops.length) return { ok: true, valor: ops[n - 1], indice: n };
    const match = ops.findIndex(o => String(o).trim().toLowerCase() === t.toLowerCase());
    if (match >= 0) return { ok: true, valor: ops[match], indice: match + 1 };
    return { ok: false };
  }
  return { ok: true, valor: t }; // texto livre
}

function resolverSaltoQuestionario(passo, indiceOpcao, passos) {
  if (!passo || !passo.saltos || typeof passo.saltos !== 'object') return null;
  const destino = passo.saltos[String(indiceOpcao)];
  if (!destino) return null;
  if (destino === '__fim__') return -1;
  const idxDestino = passos.findIndex(p => p.id === destino);
  return idxDestino >= 0 ? idxDestino : null; // destino inválido → segue linear
}

function calcularPontuacao(cliente, respostas) {
  const passos = Array.isArray(cliente.questionario_passos) ? cliente.questionario_passos : [];
  let total = 0;
  for (const p of passos) {
    if (p.tipo === 'opcoes' && respostas[p.id] !== undefined) {
      const ops = Array.isArray(p.opcoes) ? p.opcoes : [];
      const idx = ops.findIndex(o => String(o).trim().toLowerCase() === String(respostas[p.id]).trim().toLowerCase());
      if (idx >= 0) total += (idx + 1);
    }
  }
  return total;
}

async function calcularRecomendacao(cliente, respostas) {
  try {
    const total = calcularPontuacao(cliente, respostas);
    await garantirEstruturaPlanos();
    const tplId = cliente.__quest_template_id || null;
    let rp;
    if (tplId) {
      // Planos vinculados a este template OU sem nenhum vínculo (aparecem em todos).
      rp = await query(
        `SELECT p.id, p.nome, p.valor, p.nota_minima
           FROM movatak_planos p
          WHERE p.cliente_id = $1
            AND (
              EXISTS (SELECT 1 FROM movatak_plano_templates pt WHERE pt.plano_id = p.id AND pt.template_id = $2)
              OR NOT EXISTS (SELECT 1 FROM movatak_plano_templates pt2 WHERE pt2.plano_id = p.id)
            )
          ORDER BY p.nota_minima ASC, p.valor ASC NULLS LAST, p.id ASC`,
        [cliente.id, tplId]
      );
    } else {
      // Questionário do cliente (sem template): planos sem vínculo a nenhum template.
      // Isso evita que um produto exclusivo de um template vaze para o questionário padrão.
      rp = await query(
        `SELECT p.id, p.nome, p.valor, p.nota_minima
           FROM movatak_planos p
          WHERE p.cliente_id = $1
            AND NOT EXISTS (SELECT 1 FROM movatak_plano_templates pt WHERE pt.plano_id = p.id)
          ORDER BY p.nota_minima ASC, p.valor ASC NULLS LAST, p.id ASC`,
        [cliente.id]
      );
    }
    const planos = rp.rows || [];
    if (!planos.length) return { plano: null, total };
    let escolhido = planos[0]; // padrão: menor faixa
    for (const pl of planos) {
      if ((pl.nota_minima || 0) <= total) escolhido = pl;
    }
    return { plano: escolhido, total };
  } catch (e) {
    console.error('[questionario][recomendacao] erro:', e.message);
    return { plano: null, total: 0 };
  }
}

async function avancarQuestionario(cliente, lead, estadoId, respostas, fromIdx, prefix) {
  const passos = Array.isArray(cliente.questionario_passos) ? cliente.questionario_passos : [];
  let idx = fromIdx;
  let pref = prefix || '';
  let guarda = 0;
  while (guarda++ < 50) {
    const passo = passos[idx];
    if (!passo) {
      if (pref) await enviarMsgQuestionario(cliente, lead.telefone, pref, '');
      await query(`UPDATE movatak_questionario_estado SET passo_idx=$1, respostas=$2::jsonb, status='concluido', atualizado_em=NOW() WHERE id=$3`, [idx, JSON.stringify(respostas), estadoId]).catch(() => null);
      await finalizarQuestionario(cliente, lead, respostas);
      return;
    }
    const aguarda = passo.aguardar !== false;
    const corpo = aguarda ? montarTextoPergunta(passo) : (passo.pergunta || '');
    const texto = (pref ? pref + '\n\n' : '') + corpo;
    const delaySegundos = normalizarDelayQuestionario(passo);
    if (delaySegundos > 0) {
      await sleep(delaySegundos * 1000);
    }
    await enviarMsgQuestionario(cliente, lead.telefone, texto || ' ', passo.imagem);
    pref = '';
    if (aguarda) {
      await query(`UPDATE movatak_questionario_estado SET passo_idx=$1, respostas=$2::jsonb, lembretes=0, status='em_andamento', atualizado_em=NOW() WHERE id=$3`, [idx, JSON.stringify(respostas), estadoId]).catch(() => null);
      return;
    }
    // passo só-material: não espera resposta, segue para o próximo
    await query(`UPDATE movatak_questionario_estado SET passo_idx=$1, atualizado_em=NOW() WHERE id=$2`, [idx + 1, estadoId]).catch(() => null);
    idx++;
  }
}

async function iniciarQuestionarioPorTemplate(cliente, lead, templateId) {
  try {
    const r = await query(
      `SELECT * FROM movatak_questionario_templates WHERE id = $1 AND ativo = true`,
      [templateId]
    );
    if (!r.rows.length) {
      // Template não encontrado: cai no follow-up normal para não travar o lead.
      await agendarFollowupV2(lead.id, cliente.id, 1, true);
      await enviarFollowupsPendentesDoLead(lead.id, 1);
      return;
    }
    const qt = r.rows[0];
    const clienteEfetivo = {
      ...cliente,
      questionario_ativo: true,
      questionario_intro: qt.intro,
      questionario_final: qt.final,
      questionario_intro_imagem: qt.intro_imagem,
      questionario_final_imagem: qt.final_imagem,
      questionario_passos: qt.passos || [],
      questionario_recomendacao: qt.recomendacao || [],
      questionario_comando_parar: qt.comando_parar,
      questionario_comando_ativar: qt.comando_ativar,
      __quest_template_id: qt.id
    };
    await iniciarQuestionario(clienteEfetivo, lead);
  } catch (e) {
    console.error('[menu][template]', e.message);
  }
}

async function resolverQuestionarioPorTemplateId(cliente, templateId) {
  try {
    if (!templateId) return null;
    const r = await query(
      `SELECT * FROM movatak_questionario_templates WHERE id = $1 AND ativo = true`,
      [templateId]
    );
    if (!r.rows.length) return null;
    const qt = r.rows[0];
    return {
      ...cliente,
      questionario_intro: qt.intro,
      questionario_final: qt.final,
      questionario_intro_imagem: qt.intro_imagem,
      questionario_final_imagem: qt.final_imagem,
      questionario_passos: qt.passos || [],
      questionario_recomendacao: qt.recomendacao || [],
      questionario_comando_parar: qt.comando_parar,
      questionario_comando_ativar: qt.comando_ativar,
      __quest_template_id: qt.id
    };
  } catch (e) {
    console.error('[questionario][resolver-por-id]', e.message);
    return null;
  }
}

async function resolverQuestionarioDoLead(cliente, lead) {
  try {
    if (!lead || !lead.campanha_id) return cliente;
    const r = await query(
      `SELECT qt.*
         FROM movatak_campanhas c
         JOIN movatak_questionario_templates qt
           ON qt.id = c.questionario_template_id AND qt.ativo = true
        WHERE c.id = $1`,
      [lead.campanha_id]
    );
    if (!r.rows.length) return cliente;
    const qt = r.rows[0];
    return {
      ...cliente,
      questionario_intro: qt.intro,
      questionario_final: qt.final,
      questionario_intro_imagem: qt.intro_imagem,
      questionario_final_imagem: qt.final_imagem,
      questionario_passos: qt.passos || [],
      questionario_recomendacao: qt.recomendacao || [],
      questionario_comando_parar: qt.comando_parar,
      questionario_comando_ativar: qt.comando_ativar,
      __quest_template_id: qt.id
    };
  } catch (e) {
    console.error('[questionario][resolver-template]', e.message);
    return cliente;
  }
}

async function iniciarQuestionario(cliente, lead) {
  try {
    // Defesa em profundidade: nunca inicia questionário para lead com automação
    // pausada — senão nasce um estado zumbi (pausado + questionário em_andamento),
    // cujo bot pergunta mas o webhook descarta as respostas. Relê do banco porque o
    // objeto `lead` pode estar defasado (a pausa pode ter ocorrido em paralelo).
    const pausaCheck = await query('SELECT automacao_pausada FROM movatak_leads WHERE id = $1', [lead.id]).catch(() => ({ rows: [] }));
    if (pausaCheck.rows.length && pausaCheck.rows[0].automacao_pausada) {
      console.log(`[questionario][iniciar] lead ${lead.id} com automação pausada — questionário NÃO iniciado`);
      return;
    }
    cliente = await resolverQuestionarioDoLead(cliente, lead);
    const passos = Array.isArray(cliente.questionario_passos) ? cliente.questionario_passos : [];
    if (!passos.length) {
      await agendarFollowupV2(lead.id, cliente.id, 1, true);
      await enviarFollowupsPendentesDoLead(lead.id, 1);
      return;
    }
    const nome = lead.nome ? (' ' + String(lead.nome).split(' ')[0]) : '';

    // pausa o follow-up automático enquanto o questionário roda
    await query(`UPDATE movatak_followup SET status = 'pausado' WHERE lead_id = $1 AND status = 'pendente'`, [lead.id]).catch(() => null);
    await moverLeadParaFunilSlug(cliente.id, lead.id, 'auto_atendimento').catch(e => console.error('[funil][auto_atendimento]', e.message));

    // cria estado — grava qual template originou (se houver), pra que ao processar
    // a resposta do lead a gente use ESTE template, e não re-resolva pela campanha.
    const ins = await query(
      `INSERT INTO movatak_questionario_estado (cliente_id, lead_id, telefone, passo_idx, respostas, status, template_id)
       VALUES ($1, $2, $3, 0, '{}'::jsonb, 'em_andamento', $4)
       RETURNING id`,
      [cliente.id, lead.id, lead.telefone, cliente.__quest_template_id || null]
    );
    const estadoId = ins.rows[0].id;

    // 2) introdução (opcional, texto e/ou imagem)
    const introTxt = (cliente.questionario_intro && String(cliente.questionario_intro).trim())
      ? String(cliente.questionario_intro).replace(/{nome}/g, nome)
      : '';
    const introImg = cliente.questionario_intro_imagem || '';
    if (introTxt || introImg) {
      await enviarMsgQuestionario(cliente, lead.telefone, introTxt || ' ', introImg);
    }

    // 3) primeiro passo (avança por etapas só-material até a primeira que espera resposta)
    await avancarQuestionario(cliente, lead, estadoId, {}, 0, '');

    await registrarEventoLead(lead.id, cliente.id, 'questionario_iniciado', 'Questionário consultivo iniciado', { total_perguntas: passos.length });
  } catch (e) {
    console.error('[questionario][iniciar] erro:', e.message);
  }
}

async function processarRespostaQuestionario(cliente, lead, estado, texto) {
  try {
    // Prioridade: o template que o estado registrou (campanha OU início manual pelo
    // painel). Só cai no resolver-por-campanha se o estado não tiver template gravado
    // (estados antigos, criados antes dessa coluna existir).
    const porTemplate = estado.template_id ? await resolverQuestionarioPorTemplateId(cliente, estado.template_id) : null;
    cliente = porTemplate || await resolverQuestionarioDoLead(cliente, lead);
    const passos = Array.isArray(cliente.questionario_passos) ? cliente.questionario_passos : [];
    const idx = estado.passo_idx || 0;
    const passo = passos[idx];
    if (!passo) {
      await query(`UPDATE movatak_questionario_estado SET status='concluido', atualizado_em=NOW() WHERE id=$1`, [estado.id]).catch(() => null);
      return;
    }

    const respostas = (estado.respostas && typeof estado.respostas === 'object') ? estado.respostas : {};

    // Passo só-material (não espera resposta): apenas segue adiante.
    if (passo.aguardar === false) {
      await avancarQuestionario(cliente, lead, estado.id, respostas, idx + 1, '');
      return;
    }

    const interp = interpretarResposta(passo, texto);
    if (!interp.ok) {
      const tentativas = (estado.tentativas_invalidas || 0) + 1;
      await query(
        `UPDATE movatak_questionario_estado SET tentativas_invalidas = $1, atualizado_em = NOW() WHERE id = $2`,
        [tentativas, estado.id]
      );

      if (tentativas <= 2) {
        // Ainda dentro do limite — envia dica e re-pergunta
        const dica = interp.motivo === 'cep_invalido'
          ? 'Não consegui ler o CEP. Me envia os 8 números, ex: 50000000.'
          : `Não entendi sua resposta. (${tentativas}/2)`;
        await enviarMsgQuestionario(cliente, lead.telefone, dica + '\n\n' + montarTextoPergunta(passo), passo.imagem);
      } else {
        // Limite atingido — transfere para vendedor e encerra questionário
        const cmdParar = String(cliente.questionario_comando_parar || '').trim();
        const msgTransfer = cmdParar
          ? `Vou transferir seu atendimento para um dos meus colegas. 😊\n\nSe quiser falar agora com um atendente, é só responder ${cmdParar}.`
          : 'Vou transferir seu atendimento para um dos meus colegas. 😊';
        await enviarMsgQuestionario(cliente, lead.telefone, msgTransfer, null);
        await query(`UPDATE movatak_questionario_estado SET status = 'abandonado', atualizado_em = NOW() WHERE id = $1`, [estado.id]);
        await atribuirVendedorBalanceado(cliente.id, lead.id).catch(() => null);
        await moverLeadParaFunilSlug(cliente.id, lead.id, 'em_negociacao').catch(() => null);
        await agendarFollowupV2(lead.id, cliente.id, 1, true);
        await enviarFollowupsPendentesDoLead(lead.id, 1);
        await registrarEventoLead(lead.id, cliente.id, 'questionario_transferido', 'Lead transferido após 2 respostas inválidas', { passo_idx: estado.passo_idx });
        console.log(`[questionario][transferido] lead ${lead.id} transferido após ${tentativas} tentativas inválidas`);
      }
      return;
    }

    // Resposta válida — zera o contador de tentativas inválidas
    await query(
      `UPDATE movatak_questionario_estado SET tentativas_invalidas = 0 WHERE id = $1`,
      [estado.id]
    );

    respostas[passo.id] = interp.valor;

    let notaCep = '';
    if (passo.tipo === 'cep') {
      const coberto = await cepTemCobertura(cliente.id, interp.valor);
      respostas._cobertura = coberto;
      respostas._cep = interp.valor;
      notaCep = coberto
        ? '✅ Boa notícia: atendemos a sua região!'
        : '⚠️ Vou confirmar a disponibilidade na sua região e já te retorno.';
    }

    // "Encerrar após esta pergunta": independente do tipo, ao responder esta
    // pergunta o questionário vai direto para a mensagem final (com recomendação).
    if (passo.encerrar_apos) {
      await query(`UPDATE movatak_questionario_estado SET respostas=$1::jsonb, status='concluido', atualizado_em=NOW() WHERE id=$2`, [JSON.stringify(respostas), estado.id]).catch(() => null);
      if (notaCep) await enviarMsgQuestionario(cliente, lead.telefone, notaCep, '').catch(() => null);
      await finalizarQuestionario(cliente, lead, respostas);
      return;
    }

    // Salto condicional: se a pergunta (opções/sim_não) define um destino para a
    // opção escolhida, pula para essa pergunta ou encerra (__fim__). Senão, segue linear.
    let proximoIdx = idx + 1;
    if ((passo.tipo === 'opcoes' || passo.tipo === 'sim_nao') && interp.indice) {
      const destino = resolverSaltoQuestionario(passo, interp.indice, passos);
      if (destino === -1) {
        // Salto para o fim: grava respostas e finaliza.
        await query(`UPDATE movatak_questionario_estado SET respostas=$1::jsonb, status='concluido', atualizado_em=NOW() WHERE id=$2`, [JSON.stringify(respostas), estado.id]).catch(() => null);
        if (notaCep) await enviarMsgQuestionario(cliente, lead.telefone, notaCep, '').catch(() => null);
        await finalizarQuestionario(cliente, lead, respostas);
        return;
      }
      if (destino !== null) proximoIdx = destino;
    }

    await avancarQuestionario(cliente, lead, estado.id, respostas, proximoIdx, notaCep);
  } catch (e) {
    console.error('[questionario][processar] erro:', e.message);
  }
}

async function finalizarQuestionario(cliente, lead, respostas) {
  try {
    const passos = Array.isArray(cliente.questionario_passos) ? cliente.questionario_passos : [];
    const rec = await calcularRecomendacao(cliente, respostas);
    const nome = lead.nome ? (' ' + String(lead.nome).split(' ')[0]) : '';
    const planoTxt = rec.plano
      ? (rec.plano.nome + (rec.plano.valor != null ? ' — R$ ' + Number(rec.plano.valor).toFixed(2).replace('.', ',') : ''))
      : 'um dos nossos planos';

    if (rec.plano) {
      await query(`UPDATE movatak_leads SET plano_id = $1, atualizado_em = NOW() WHERE id = $2`, [rec.plano.id, lead.id]).catch(() => null);
    }

    // Mensagem final ao concluir o questionário — pode ser desligada no painel
    // (enviar_msg_final). Default é ligado, pra preservar o comportamento atual.
    if (cliente.enviar_msg_final !== false) {
      const finalTpl = (cliente.questionario_final && String(cliente.questionario_final).trim())
        ? cliente.questionario_final
        : 'Prontinho{nome}! Com base nas suas respostas, o plano ideal pra você é: {plano}. Um consultor já vai falar com você pra finalizar. 🙌';
      const finalMsg = finalTpl.replace(/{nome}/g, nome).replace(/{plano}/g, planoTxt);
      await enviarMsgQuestionario(cliente, lead.telefone, finalMsg, cliente.questionario_final_imagem);
    }

    const resumoLinhas = passos
      .filter(p => p.pergunta_curta && String(p.pergunta_curta).trim() && respostas[p.id] !== undefined)
      .map(p => `${String(p.pergunta_curta).trim()}: ${respostas[p.id]}`);
    const cobTxt = (respostas._cobertura === true) ? 'SIM' : (respostas._cobertura === false ? 'NÃO (verificar)' : '—');
    const resumo =
      '🔔 Lead qualificado!\n' +
      `Nome: ${lead.nome || '—'}\n` +
      `Fone: ${lead.telefone}` +
      (resumoLinhas.length ? '\n' + resumoLinhas.join('\n') : '') +
      (respostas._cep ? `\nCEP: ${respostas._cep} | Cobertura: ${cobTxt}` : '') +
      (rec.plano ? `\nPlano sugerido: ${rec.plano.nome}` : '');

    const destino = cliente.whatsapp_dono || MOVATAK_ADMIN_WA;
    if (destino) {
      await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, destino, resumo)
        .catch(e => console.error('[questionario][resumo vendedor]', e.message));
    }

    await moverLeadParaFunilSlug(cliente.id, lead.id, 'em_negociacao').catch(e => console.error('[funil][em_negociacao]', e.message));
    await atribuirVendedorBalanceado(cliente.id, lead.id).catch(e => console.error('[funil][distribuicao]', e.message));

    if (cliente.acao_arquivar_ao_final) {
      await zapiArquivar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, lead.telefone)
        .catch(e => console.error('[zapi][arquivar]', e.message));
    }
    if (cliente.acao_marcar_nao_lido) {
      await zapiMarcarNaoLido(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, lead.telefone)
        .catch(e => console.error('[zapi][nao_lido]', e.message));
    }

    await registrarEventoLead(lead.id, cliente.id, 'questionario_concluido', 'Questionário concluído e plano recomendado', { respostas, plano_id: rec.plano ? rec.plano.id : null });

    // Menu de Atendimento "após questionário": agora que o lead terminou as
    // perguntas, oferece o menu de setor (se ativo e configurado para esta posição).
    if (cliente.menu_atend_ativo && cliente.menu_atend_posicao === 'apos_questionario') {
      await enviarMenuAtendimento(cliente, lead).catch(e => console.error('[menu][pos-quest]', e.message));
    }
  } catch (e) {
    console.error('[questionario][finalizar] erro:', e.message);
  }
}

async function processarQuestionariosParados() {
  try {
    await garantirEstruturaQuestionario();
    const r = await query(
      `SELECT q.*, c.zapi_instance, c.zapi_token, c.zapi_client_token,
              c.questionario_passos, c.quest_lembrete_msg, c.quest_lembrete_minutos,
              l.nome AS lead_nome, l.etapa AS lead_etapa
         FROM movatak_questionario_estado q
         JOIN movatak_clientes c ON c.id = q.cliente_id
         JOIN movatak_leads l ON l.id = q.lead_id
        WHERE q.status = 'em_andamento'
          AND COALESCE(l.automacao_pausada, false) = false
          AND q.atualizado_em < NOW() - make_interval(mins =>
                COALESCE(NULLIF(c.quest_lembrete_minutos, 0), $1::int))`,
      [MOVATAK_QUEST_LEMBRETE_HORAS * 60]
    );
    for (const est of r.rows) {
      try {
        const cliente = {
          id: est.cliente_id,
          zapi_instance: est.zapi_instance,
          zapi_token: est.zapi_token,
          zapi_client_token: est.zapi_client_token,
          questionario_passos: est.questionario_passos
        };
        const lead = { id: est.lead_id, telefone: est.telefone, nome: est.lead_nome };
        const passos = Array.isArray(est.questionario_passos) ? est.questionario_passos : [];
        const passo = passos[est.passo_idx || 0];

        if ((est.lembretes || 0) < MOVATAK_QUEST_MAX_LEMBRETES) {
          // Mensagem configurada pelo cliente. Se vazia, não envia lembrete
          // (mas ainda marca como processado para seguir o fluxo de abandono depois).
          const msgLembrete = (est.quest_lembrete_msg || '').trim();
          if (msgLembrete) {
            // Substitui {nome} pelo nome do lead (mesmo padrão dos demais textos).
            const msgFinal = msgLembrete.replace(/{nome}/g, lead.nome || 'Lead');
            await enviarMsgQuestionario(cliente, lead.telefone, msgFinal, null);
          }
          await query(`UPDATE movatak_questionario_estado SET lembretes = COALESCE(lembretes,0) + 1, atualizado_em = NOW() WHERE id = $1`, [est.id]);
          await registrarEventoLead(lead.id, est.cliente_id, 'questionario_lembrete', 'Lembrete enviado por inatividade no questionário', { passo_idx: est.passo_idx });
          console.log(`[questionario][lembrete] enviado -> lead ${lead.id}`);
        } else {
          await query(`UPDATE movatak_questionario_estado SET status = 'abandonado', atualizado_em = NOW() WHERE id = $1`, [est.id]);
          if (est.lead_etapa !== 'cliente') {
            await agendarFollowupV2(lead.id, est.cliente_id, 1, true);
            await enviarFollowupsPendentesDoLead(lead.id, 1);
          }
          await registrarEventoLead(lead.id, est.cliente_id, 'questionario_abandonado', 'Questionário sem resposta; lead devolvido ao follow-up', { passo_idx: est.passo_idx });
          console.log(`[questionario][abandonado] devolvido ao follow-up -> lead ${lead.id}`);
        }
      } catch (e) {
        console.error('[questionario][parado] erro no estado', est.id, e.message);
      }
    }
  } catch (e) {
    console.error('[questionario][parados] erro:', e.message);
  }
}


module.exports = {
  init,
  reiniciarQuestionarioLead,
  enviarMsgQuestionario,
  cepTemCobertura,
  montarTextoPergunta,
  interpretarResposta,
  resolverSaltoQuestionario,
  calcularPontuacao,
  calcularRecomendacao,
  avancarQuestionario,
  iniciarQuestionarioPorTemplate,
  resolverQuestionarioPorTemplateId,
  resolverQuestionarioDoLead,
  iniciarQuestionario,
  processarRespostaQuestionario,
  finalizarQuestionario,
  processarQuestionariosParados,
};

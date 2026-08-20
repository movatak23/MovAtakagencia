'use strict';

// ============================================================
// IA — atendimento automatico via Claude Haiku (Anthropic) +
// deteccao de campanha e travas de transferencia para humano.
// (movido verbatim do index.js na Fase 3c)
// ============================================================
const { query, garantirEstruturaConversas } = require('./db');
const { registrarEventoLead, registrarConversa, pararAtendimentoLead } = require('./leads');
const { zapiEnviar } = require('./zapi');
const { enviarMsgQuestionario } = require('./questionario');

async function localizarCampanhaPorIA(clienteId, texto) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const msg = String(texto || '').trim();
    if (msg.length < 3) return null;

    const r = await query(
      `SELECT c.id, c.nome, c.gatilho, c.template_id
         FROM movatak_campanhas c
        WHERE c.cliente_id = $1 AND c.ativo = true AND c.excluida_em IS NULL
          AND c.gatilho IS NOT NULL AND TRIM(c.gatilho) <> ''`,
      [clienteId]
    );
    const campanhas = r.rows || [];
    if (!campanhas.length) return null;

    const lista = campanhas.map((c, i) => `${i + 1}. ${c.nome} — palavras/tema: "${c.gatilho}"`).join('\n');
    const systemPrompt =
      `Você classifica a mensagem inicial de um lead que chegou pelo WhatsApp (geralmente vinda de um anúncio) ` +
      `em UMA das campanhas cadastradas. Responda APENAS com o NÚMERO da campanha que melhor corresponde à intenção do lead. ` +
      `Se nenhuma corresponder com clareza, ou se ficar em dúvida, responda APENAS "0". ` +
      `Não explique. Não invente. Só o número.\n\nCAMPANHAS:\n${lista}`;
    const userPrompt = `MENSAGEM DO LEAD:\n"${msg}"\n\nNúmero da campanha (ou 0):`;

    const resposta = await chamarHaiku(systemPrompt, userPrompt);
    const num = parseInt(String(resposta || '').replace(/[^0-9]/g, ''), 10);
    if (!num || num < 1 || num > campanhas.length) return null; // 0 = sem certeza → humano

    const escolhida = campanhas[num - 1];
    // Recarrega a campanha completa (com dados do template) no mesmo formato do gatilho.
    const full = await query(
      `SELECT c.*, t.followup_v2 AS template_followup_v2, t.boas_vindas_msg AS template_boas_vindas_msg, t.comandos AS template_comandos, t.nome AS template_nome
         FROM movatak_campanhas c
         LEFT JOIN movatak_followup_templates t ON t.id = c.template_id AND t.ativo = true
        WHERE c.id = $1`,
      [escolhida.id]
    );
    if (full.rows.length) {
      console.log('[IA-ROUTE] lead encaixado por IA na campanha "' + escolhida.nome + '" (id ' + escolhida.id + ')');
      return full.rows[0];
    }
    return null;
  } catch (e) {
    console.error('[IA-ROUTE] erro:', e.message);
    return null; // qualquer falha → comportamento atual (humano/geral)
  }
}

async function chamarHaiku(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('IA não configurada (falta ANTHROPIC_API_KEY).');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    // Sem crédito na Anthropic (billing): liga o alerta global para o CRM avisar o gestor.
    if ((resp.status === 400 || resp.status === 402) && /credit balance is too low|billing|insufficient/i.test(t)) {
      _iaSemCredito = { desde: _iaSemCredito ? _iaSemCredito.desde : new Date().toISOString() };
    }
    throw new Error('Erro na IA (' + resp.status + '): ' + t.slice(0, 200));
  }
  const data = await resp.json();
  if (_iaSemCredito) _iaSemCredito = null; // recuperou: qualquer resposta OK zera o alerta
  const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return texto;
}

// Estado global do crédito da IA (a ANTHROPIC_API_KEY é do servidor inteiro).
// null = ok; { desde } = a Anthropic recusou por falta de crédito. Zera no 1º sucesso.
let _iaSemCredito = null;
function iaSemCredito() { return _iaSemCredito; }

async function gerarRespostaIALead(leadId) {
  await garantirEstruturaConversas();

  const convR = await query(
    `SELECT * FROM (
       SELECT direcao, conteudo, criado_em FROM movatak_conversas
        WHERE lead_id = $1 AND conteudo IS NOT NULL AND conteudo <> ''
        ORDER BY criado_em DESC LIMIT 15
     ) sub ORDER BY criado_em ASC`,
    [leadId]
  );
  if (!convR.rows.length) return { erro: 'Sem mensagens nesta conversa para basear a sugestão.' };

  const leadR = await query(
    `SELECT l.nome, l.telefone, l.etapa, l.cliente_id,
            p.nome AS plano_nome, p.valor AS plano_valor,
            s.nome AS setor_nome, c.nome AS empresa_nome,
            c.ia_oferta, c.ia_tom, c.ia_resumo,
            c.questionario_intro, c.questionario_passos, c.questionario_final,
            c.followup_msgs_v2
       FROM movatak_leads l
       LEFT JOIN movatak_planos p ON p.id = l.plano_id
       LEFT JOIN movatak_setores s ON s.id = l.setor_id
       LEFT JOIN movatak_clientes c ON c.id = l.cliente_id
      WHERE l.id = $1`,
    [leadId]
  );
  const lead = leadR.rows[0];
  if (!lead) return { erro: 'Lead não encontrado.' };

  const estiloR = await query(
    `SELECT conteudo FROM movatak_conversas
      WHERE cliente_id = $1 AND direcao = 'saida'
        AND lead_id <> $2 AND conteudo IS NOT NULL AND LENGTH(conteudo) BETWEEN 15 AND 400
      ORDER BY criado_em DESC LIMIT 8`,
    [lead.cliente_id, leadId]
  ).catch(() => ({ rows: [] }));

  const conversaTxt = convR.rows.map(m =>
    (m.direcao === 'entrada' ? 'CLIENTE: ' : 'ATENDENTE: ') + (m.conteudo || '')
  ).join('\n');
  const exemplosTxt = estiloR.rows.map(r => '- ' + r.conteudo.replace(/\n+/g, ' ')).join('\n') || '(sem exemplos)';

  // Material curado: respostas rápidas + autoatendimento + followup.
  const rapidasR = await query(
    `SELECT titulo, texto FROM movatak_mensagens_rapidas
      WHERE cliente_id = $1 AND texto IS NOT NULL AND LENGTH(texto) > 0
      ORDER BY vezes_usado DESC, ordem ASC LIMIT 25`,
    [lead.cliente_id]
  ).catch(() => ({ rows: [] }));

  let materialCurado = '';
  if (rapidasR.rows.length) {
    const listaRapidas = rapidasR.rows
      .map(r => '- ' + (r.titulo ? '[' + r.titulo + '] ' : '') + String(r.texto).replace(/\n+/g, ' ').trim())
      .join('\n');
    materialCurado += `\n\nRESPOSTAS RÁPIDAS OFICIAIS (use como base para responder dúvidas comuns):\n${listaRapidas}`;
  }
  const passosQuest = Array.isArray(lead.questionario_passos) ? lead.questionario_passos : [];
  const partesAuto = [];
  if (lead.questionario_intro) partesAuto.push('Abertura: ' + String(lead.questionario_intro).replace(/\n+/g, ' ').trim());
  passosQuest.forEach((p, i) => {
    const pergunta = p && (p.pergunta || p.texto || p.titulo);
    if (pergunta) partesAuto.push(`Passo ${i + 1}: ` + String(pergunta).replace(/\n+/g, ' ').trim());
  });
  if (lead.questionario_final) partesAuto.push('Fechamento: ' + String(lead.questionario_final).replace(/\n+/g, ' ').trim());
  if (partesAuto.length) {
    materialCurado += `\n\nROTEIRO DE AUTOATENDIMENTO (siga esta linha de qualificação/abordagem):\n- ${partesAuto.join('\n- ')}`;
  }
  const fuObj = lead.followup_msgs_v2 && typeof lead.followup_msgs_v2 === 'object' ? lead.followup_msgs_v2 : {};
  const fuMsgs = [];
  Object.keys(fuObj).forEach(k => {
    const v = fuObj[k];
    if (typeof v === 'string' && v.trim()) fuMsgs.push(v.trim());
    else if (v && typeof v === 'object') {
      Object.values(v).forEach(m => { if (typeof m === 'string' && m.trim()) fuMsgs.push(m.trim()); });
    }
  });
  if (fuMsgs.length) {
    const listaFu = fuMsgs.slice(0, 10).map(m => '- ' + m.replace(/\n+/g, ' ')).join('\n');
    materialCurado += `\n\nMENSAGENS DE FOLLOWUP (tom e abordagem para reativar/retomar o lead):\n${listaFu}`;
  }

  let baseConhecimento = '';
  if (lead.ia_oferta || lead.ia_tom || lead.ia_resumo) {
    baseConhecimento = `\n\nCONHECIMENTO SOBRE A EMPRESA (use como base, é a fonte da verdade):\n`;
    if (lead.ia_oferta) baseConhecimento += `O que vende e diferencial: ${lead.ia_oferta}\n`;
    if (lead.ia_tom) baseConhecimento += `Tom de voz e regras: ${lead.ia_tom}\n`;
    if (lead.ia_resumo) baseConhecimento += `Resumo do negócio: ${lead.ia_resumo}\n`;
  }

  const systemPrompt = `Você é um atendente de vendas HUMANO da empresa "${lead.empresa_nome || 'nossa empresa'}" no WhatsApp. ` +
    `Você NÃO é um robô e jamais deve soar como um. Escreva a PRÓXIMA resposta do ATENDENTE para o cliente, ` +
    `em português brasileiro, no tom de WhatsApp: natural, humano, cordial e objetivo, como uma pessoa de verdade digitando. ` +
    `Use o CONHECIMENTO SOBRE A EMPRESA e o MATERIAL OFICIAL abaixo como base — siga o conteúdo das respostas rápidas, ` +
    `do roteiro de autoatendimento e das mensagens de followup. Você PODE adaptar as palavras ao contexto, mas mantenha o ` +
    `sentido, as informações e o tom do material oficial. Imite o estilo dos exemplos reais da equipe.\n\n` +
    `REGRAS PARA SOAR HUMANO E NÃO REPETITIVO (muito importante):\n` +
    `- Seja BREVE. Responda em 1 ou 2 frases curtas, como uma pessoa digitando no WhatsApp. NADA de textão ou parágrafos longos.\n` +
    `- Vá direto ao ponto. Se der pra responder em uma linha, responda em uma linha.\n` +
    `- NUNCA repita a mesma frase, pergunta ou estrutura que já apareceu antes na conversa. Olhe o histórico e varie sempre.\n` +
    `- Se já perguntou algo e o cliente não respondeu direto, reformule de outro jeito — não copie a pergunta anterior.\n` +
    `- Varie as saudações e conectores; evite começar toda mensagem igual. Escreva como gente, não como script.\n` +
    `- Não fique insistindo na mesma informação. Se travou, avance a conversa de outro ângulo ou passe para um humano.\n\n` +
    `QUANDO VOCÊ NÃO SOUBER A RESPOSTA (regra crítica):\n` +
    `- Se a pergunta do cliente não puder ser respondida com o material oficial, o conhecimento da empresa ou a conversa, ` +
    `NÃO invente, NÃO enrole e NÃO repita respostas genéricas.\n` +
    `- Nesse caso, responda EXATAMENTE com o marcador: [TRANSFERIR_HUMANO]\n` +
    `- Use o marcador também se o cliente pedir para falar com uma pessoa, demonstrar irritação, ou se a conversa fugir do que você domina.\n` +
    `- Não escreva mais nada junto do marcador — só ele.\n\n` +
    `ASSUNTOS PROIBIDOS — TRANSFIRA SEMPRE:\n` +
    `Você NÃO tem acesso a sistema de pedidos, pagamentos ou cadastro. Você NUNCA pode:\n` +
    `- Criar, registrar, confirmar ou "fechar" um pedido ou compra, nem informar número, status ou conteúdo de pedido.\n` +
    `- Gerar, enviar ou prometer link de pagamento, chave PIX, boleto, código de barras ou qualquer forma de cobrança.\n` +
    `- Confirmar que um pagamento foi recebido, aprovado ou identificado, ou analisar comprovantes.\n` +
    `- Tratar de cancelamento, reembolso, estorno, nota fiscal, fatura ou alteração de dados cadastrais/financeiros.\n` +
    `- Enviar QUALQUER link ou URL, mesmo que pareça existir no material.\n` +
    `Se o cliente pedir QUALQUER item acima, responda EXATAMENTE com o marcador [TRANSFERIR_HUMANO] — nada mais. ` +
    `Nunca simule ou faça de conta que executou essas ações.\n\n` +
    `O QUE VOCÊ PODE E DEVE RESPONDER NORMALMENTE (não transfira à toa):\n` +
    `- Dúvidas sobre produtos, materiais, tamanhos, modelos, especificações e disponibilidade que estejam no material oficial.\n` +
    `- Preços e condições que CONSTAM no material oficial (tabelas, respostas rápidas, conhecimento da empresa) — pode informar; ` +
    `só não pode inventar valores que não estão lá.\n` +
    `- Prazos e informações de funcionamento que estejam no material oficial.\n` +
    `- Cumprimentos, agradecimentos e conversa cotidiana de atendimento.\n` +
    `- Você PODE mencionar as formas de pagamento aceitas se isso estiver no material (ex: "aceitamos pix e cartão") — ` +
    `o que você não pode é gerar/enviar a cobrança em si.\n` +
    `Na dúvida entre transferir e responder algo que ESTÁ no material oficial: responda.\n\n` +
    `Não invente preços, prazos ou condições fora do material. Respeite sempre o que a empresa disse que NUNCA deve ser feito. ` +
    `Responda APENAS com o texto da mensagem (ou só o marcador), sem aspas, sem rótulos, sem explicação.` +
    baseConhecimento +
    materialCurado +
    `\n\nEXEMPLOS DE COMO A EQUIPE RESPONDE:\n${exemplosTxt}`;

  const userPrompt =
    `CONTEXTO DO LEAD:\n` +
    `Nome: ${lead.nome || '—'}\n` +
    `Etapa no funil: ${lead.etapa || '—'}${lead.setor_nome ? ' / ' + lead.setor_nome : ''}\n` +
    (lead.plano_nome ? `Plano de interesse: ${lead.plano_nome}${lead.plano_valor ? ' (R$ ' + lead.plano_valor + ')' : ''}\n` : '') +
    `\nCONVERSA ATÉ AGORA:\n${conversaTxt}\n\n` +
    `Escreva a próxima mensagem do ATENDENTE:`;

  const sugestao = await chamarHaiku(systemPrompt, userPrompt);
  if (!sugestao) return { erro: 'A IA não retornou sugestão.' };
  // Marcador de transferência para humano (IA não soube responder).
  if (sugestao.includes('[TRANSFERIR_HUMANO]')) {
    return { transferir: true, telefone: lead.telefone };
  }
  return { sugestao, telefone: lead.telefone };
}

async function enviarComPausasHumanas(cliente, telefone, leadId, textoCompleto) {
  const texto = String(textoCompleto || '').trim();
  if (!texto) return;
  // Quebra por frases (. ! ? e quebras de linha), mantendo pedaços curtos.
  let partes = texto
    .split(/(?<=[.!?])\s+|\n+/)
    .map(p => p.trim())
    .filter(Boolean);
  // Se ficou só um pedaço grande ou muitos pedaços minúsculos, normaliza:
  // no máximo 3 mensagens, pra não soar picotado demais.
  if (partes.length > 3) {
    const agrupadas = [];
    const porGrupo = Math.ceil(partes.length / 3);
    for (let i = 0; i < partes.length; i += porGrupo) {
      agrupadas.push(partes.slice(i, i + porGrupo).join(' '));
    }
    partes = agrupadas;
  }
  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i];
    // Pausa proporcional ao tamanho (simula digitação): ~45ms por caractere,
    // entre 0,8s e 4s. A primeira também tem uma pequena pausa inicial.
    const ms = Math.min(4000, Math.max(800, parte.length * 45));
    await new Promise(r => setTimeout(r, ms));
    await zapiEnviar(cliente.zapi_instance, cliente.zapi_token, cliente.zapi_client_token, telefone, parte).catch(() => null);
    if (leadId) await registrarConversa(leadId, cliente.id, 'saida', parte, null, null, null, null, 'ia').catch(() => null);
  }
}

function _normalizarTextoTrava(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function assuntoExigeHumano(textoLead) {
  const t = _normalizarTextoTrava(textoLead);
  if (!t) return false;
  const padroes = [
    /\bpedido(s)?\b/,                          // fazer/confirmar/status/nº do pedido
    /\b(fechar|finalizar|confirmar)\s+(a\s+)?compra\b/,
    /\bpag(ar|amento|o)\b/,                    // pagar, pagamento, "como pago"
    /\bpix\b/,
    /\bboleto(s)?\b/,
    /\blink\s+de\s+pagamento\b/,
    /\bcart(a|ã)o\s+(de\s+)?(cr(e|é)dito|d(e|é)bito)\b/,
    /\bcomprovante(s)?\b/,
    /\bnota\s+fiscal\b/, /\bnf-?e?\b/,
    /\breembolso(s)?\b/, /\bestorno(s)?\b/,
    /\bcancelar\b/, /\bcancelamento\b/,
    /\brastre(io|amento|ar)\b/,
    /\bfatura(s)?\b/, /\bcobran(c|ç)a(s)?\b/
  ];
  return padroes.some(rx => rx.test(t));
}

function respostaIAViolaTravas(textoIA) {
  const t = _normalizarTextoTrava(textoIA);
  if (!t) return false;
  const padroes = [
    /https?:\/\//, /\bwww\./, /\bwa\.me\b/, /\bbit\.ly\b/,           // qualquer URL
    /mercadopago|mpago\.|pag\.ae|pagseguro|picpay|infinitepay|stripe/,
    /\blink\s+(de\s+|do\s+|pra\s+|para\s+)?pagamento\b/,
    /\bchave\s+(pix|de\s+pagamento)\b/,
    /\bpix\s+copia\s+e\s+cola\b/,
    /\b(segue|mandei|enviei|te\s+mando|vou\s+(te\s+)?(mandar|enviar|gerar|passar))\s+(o\s+|a\s+|um\s+|uma\s+)?(pix|boleto|link|cobranca|fatura)\b/,
    /\bc(o|ó)digo\s+de\s+barras\b/,
    /\bpedido\s*(n[ºo°]|#|numero|nº)\s*\d+/,                          // "pedido nº 1234"
    /\b(seu\s+)?pedido\s+(foi\s+)?(confirmad|registrad|gerad|criad|aprovad)/,
    /\bpagamento\s+(foi\s+)?(confirmad|aprovad|recebid|identificad)/
  ];
  return padroes.some(rx => rx.test(t));
}

async function transferirIAParaHumano(cliente, lead, motivo, msgTransicao) {
  const msg = msgTransicao || 'Deixa eu confirmar isso certinho pra você com um dos meus colegas aqui da equipe. Já te retorno com a resposta, tá? 🙂';
  await enviarMsgQuestionario(cliente, lead.telefone, msg, null);
  await registrarConversa(lead.id, cliente.id, 'saida', msg, null, null, null, null, 'ia').catch(() => null);
  await pararAtendimentoLead(cliente.id, lead.id, 'ia', motivo);
  await registrarEventoLead(lead.id, cliente.id, 'ia_transferiu_humano', 'IA transferiu o lead para um atendente humano', { motivo }).catch(() => null);
  console.log(`[ia-auto] lead ${lead.id}: transferido para humano (${motivo})`);
}

// Mapa etapa -> slug da coluna de sistema (espelha slugFunilPorEtapa do index.js).
// Usado para resolver a coluna EFETIVA do lead quando funil_coluna_id ainda é NULL
// (leads que aparecem no board por fallback de etapa — o caso do "novo contato").
const IA_ETAPA_SLUG = {
  lead: 'novo_contato',
  auto_atendimento: 'auto_atendimento',
  followup: 'aguardando_resposta',
  negociacao: 'em_negociacao',
  cliente: 'cliente_fechado',
  descartado: 'perdido'
};

async function iaResponderAutomatico(cliente, lead, textoLead) {
  try {
    if (!lead) return false;
    // Resolve a coluna do MESMO jeito que o board (renderFunil): se o lead tem
    // funil_coluna_id físico, usa ele; senão, cai no slug da etapa. Sem isso, a
    // IA só respondia leads arrastados manualmente pra coluna — leads de "novo
    // contato" (funil_coluna_id NULL) ficavam de fora mesmo com o toggle ligado.
    let colR;
    if (lead.funil_coluna_id) {
      colR = await query(
        'SELECT ia_ativa FROM movatak_funil_colunas WHERE id=$1 AND ativo=true',
        [lead.funil_coluna_id]
      ).catch(() => ({ rows: [] }));
    } else {
      const slug = IA_ETAPA_SLUG[lead.etapa] || 'novo_contato';
      colR = await query(
        'SELECT ia_ativa FROM movatak_funil_colunas WHERE cliente_id=$1 AND slug=$2 AND ativo=true ORDER BY ordem ASC, id ASC LIMIT 1',
        [lead.cliente_id || cliente.id, slug]
      ).catch(() => ({ rows: [] }));
    }
    if (!colR.rows.length || !colR.rows[0].ia_ativa) return false;
    console.log(`[ia-auto] lead ${lead.id}: coluna com IA ativa — avaliando resposta (texto: "${String(textoLead || '').slice(0, 80)}")`);

    // TRAVA 1 (pré-filtro): pedido, pagamento, pix, boleto, cancelamento etc.
    // são assuntos exclusivos de humano — nem chama a IA.
    if (assuntoExigeHumano(textoLead)) {
      await transferirIAParaHumano(cliente, lead, 'assunto_transacional',
        'Boa! Esse tipo de solicitação quem cuida direto é a nossa equipe, pra garantir tudo certinho pra você. 😊 Já acionei um atendente aqui — em instantes ele te responde.');
      return true;
    }

    const gerada = await gerarRespostaIALead(lead.id);

    // Handoff: a IA não soube responder → transfere para um humano.
    if (gerada.transferir) {
      await transferirIAParaHumano(cliente, lead, 'ia_nao_soube_responder', null);
      return true;
    }

    if (gerada.erro || !gerada.sugestao) {
      console.log(`[ia-auto] lead ${lead.id}: sem resposta (${gerada.erro || 'vazia'})`);
      return false;
    }

    // TRAVA 2 (pós-filtro): mesmo com o prompt travado, se a resposta gerada
    // contiver link, pix, boleto ou "pedido/pagamento confirmado", o envio é
    // BLOQUEADO — a resposta nunca chega no lead — e ele vai pro humano.
    if (respostaIAViolaTravas(gerada.sugestao)) {
      console.warn(`[ia-auto][TRAVA] lead ${lead.id}: resposta da IA bloqueada por conter conteúdo transacional. Preview: ${gerada.sugestao.slice(0, 160)}`);
      await registrarEventoLead(lead.id, cliente.id, 'ia_resposta_bloqueada', 'Resposta da IA bloqueada pela trava de segurança (conteúdo transacional) — não foi enviada ao lead', { preview: gerada.sugestao.slice(0, 300) }).catch(() => null);
      await transferirIAParaHumano(cliente, lead, 'resposta_bloqueada_trava', null);
      return true;
    }

    await enviarComPausasHumanas(cliente, lead.telefone, lead.id, gerada.sugestao);
    await registrarEventoLead(lead.id, cliente.id, 'ia_resposta_automatica', 'IA respondeu automaticamente (coluna com IA ativa)', { preview: gerada.sugestao.slice(0, 160) }).catch(() => null);
    console.log(`[ia-auto] lead ${lead.id}: IA respondeu automaticamente`);
    return true;
  } catch (e) {
    console.error(`[ia-auto] erro no lead ${lead && lead.id}:`, e.message);
    return false;
  }
}


module.exports = {
  localizarCampanhaPorIA,
  chamarHaiku,
  gerarRespostaIALead,
  enviarComPausasHumanas,
  _normalizarTextoTrava,
  assuntoExigeHumano,
  respostaIAViolaTravas,
  transferirIAParaHumano,
  iaResponderAutomatico,
  iaSemCredito,
};

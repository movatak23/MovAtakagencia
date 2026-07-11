'use strict';

// ============================================================
// Utilitarios — telefone, midia, CEP, storage e alertas.
// Folha da arvore de dependencias (movido verbatim do index.js).
// ============================================================
const axios = require('axios');
const crypto = require('crypto');
const { query } = require('./db');
const { zapiEnviar } = require('./zapi');

async function enviarAlerta(instance, token, clientToken, destinatario, msg) {
  try {
    await zapiEnviar(instance, token, clientToken, destinatario, msg);
  } catch(e) {
    console.error('[enviarAlerta]', e.message);
  }
}

async function registrarErroZapi(clienteId, mensagem, detalhes = {}) {
  try {
    await query(
      `UPDATE movatak_clientes
          SET ultimo_erro_zapi_em = NOW(), ultimo_erro_zapi = $1
        WHERE id = $2`,
      [String(mensagem || '').slice(0, 500), clienteId]
    );
  } catch (e) {
    console.error('[zapi-status]', e.message);
  }
}

function ehGrupoOuCanal(chave) {
  const s = String(chave || '').toLowerCase();
  if (!s) return false;
  if (s.includes('@g.us') || s.includes('@newsletter') || s.includes('@broadcast')) return true;
  const soDigitos = s.replace(/\D/g, '');
  if (soDigitos.length > 15) return true; // ids de grupo são bem mais longos que telefones
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extrairDigitosTelefone(valor) {
  if (!valor) return null;
  const raw = String(valor);
  if (raw.includes('@g.us') || raw.includes('@newsletter')) return null;
  const digitos = raw.replace(/\D/g, '');
  if (digitos.length < 10 || digitos.length > 15) return null;
  return digitos;
}

function telefonesEquivalentes(a, b) {
  const da = extrairDigitosTelefone(a);
  const db = extrairDigitosTelefone(b);
  if (!da || !db) return false;
  const va = variantesTelefone(da);
  const vb = variantesTelefone(db);
  return va.some(x => vb.includes(x));
}

function variantesTelefone(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  if (!d) return [];
  const set = new Set([d]);
  // Formato BR: 55 (DDI) + DD (2) + número (8 ou 9 dígitos)
  if (d.startsWith('55') && d.length >= 12) {
    const ddi = d.slice(0, 2);
    const ddd = d.slice(2, 4);
    const numero = d.slice(4);
    if (numero.length === 9 && numero[0] === '9') {
      // tem o 9 → adiciona versão sem o 9
      set.add(ddi + ddd + numero.slice(1));
    } else if (numero.length === 8) {
      // sem o 9 → adiciona versão com o 9
      set.add(ddi + ddd + '9' + numero);
    }
  }
  return Array.from(set);
}

function normalizarCep(cep) {
  return String(cep || '').replace(/\D/g, '');
}

function tipoMidia(url, hint) {
  if (hint === 'audio' || hint === 'video' || hint === 'imagem' || hint === 'documento') return hint;
  const u = String(url || '');
  if (/\.(mp4|webm|mov|m4v|3gp)(\?|$)/i.test(u)) return 'video';
  if (/\.(ogg|oga|opus|mp3|m4a|wav|weba|aac)(\?|$)/i.test(u)) return 'audio';
  return 'imagem';
}

async function uploadSupabase(buffer, contentType, ext) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const bucket = process.env.SUPABASE_BUCKET || 'movatak';
  if (!base || !key) throw new Error('Storage não configurado: defina SUPABASE_URL e SUPABASE_SERVICE_KEY no Railway.');
  const nome = 'quest/' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + '.' + ext;
  const url = `${base.replace(/\/$/, '')}/storage/v1/object/${bucket}/${nome}`;
  await axios.post(url, buffer, {
    headers: {
      'Authorization': 'Bearer ' + key,
      'apikey': key,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
  return `${base.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${nome}`;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}


module.exports = {
  enviarAlerta,
  registrarErroZapi,
  ehGrupoOuCanal,
  sleep,
  extrairDigitosTelefone,
  telefonesEquivalentes,
  variantesTelefone,
  normalizarCep,
  tipoMidia,
  uploadSupabase,
  csvEscape,
};

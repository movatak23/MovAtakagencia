'use strict';

const crypto = require('crypto');

// ============================================================
// VERSÃO — incrementar a cada atualização
// ============================================================
const MOVATAK_VERSION = 'v2.18.0-fix-lid-duplicata-naolida';

// ============================================================
// Cloudflare R2 (armazenamento de anexos). Carregado de forma segura: se a lib
// @aws-sdk/client-s3 ainda não estiver instalada, ou faltarem variáveis de ambiente,
// o sistema continua funcionando normalmente — só os anexos ficam indisponíveis.
// Credenciais vêm SEMPRE do ambiente (Railway), nunca hardcoded.
// ============================================================
let r2Client = null;
let R2_PutObjectCommand = null, R2_GetObjectCommand = null, R2_DeleteObjectCommand = null;
let R2_ListBucketsCommand = null;
const R2_BUCKET = (process.env.R2_BUCKET || '').trim();
let R2_BUCKET_REAL = R2_BUCKET; // resolvido na inicialização via auto-descoberta
const R2_PRONTO = !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT && R2_BUCKET);
try {
  if (R2_PRONTO) {
    const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListBucketsCommand } = require('@aws-sdk/client-s3');
    R2_PutObjectCommand = PutObjectCommand;
    R2_GetObjectCommand = GetObjectCommand;
    R2_DeleteObjectCommand = DeleteObjectCommand;
    R2_ListBucketsCommand = ListBucketsCommand;
    r2Client = new S3Client({
      region: 'auto',
      endpoint: (process.env.R2_ENDPOINT || '').trim(),
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    });
    console.log('[R2] cliente inicializado, bucket (variável):', R2_BUCKET);
    // Auto-descoberta: lista os buckets reais e usa o nome exato. Resolve qualquer
    // diferença invisível (espaço, caixa, nome digitado errado) entre a variável e
    // o bucket de verdade. Roda em background para não atrasar o boot.
    (async () => {
      try {
        const lista = await r2Client.send(new R2_ListBucketsCommand({}));
        const nomes = (lista.Buckets || []).map(b => b.Name);
        if (nomes.length) {
          const match = nomes.find(n => n.toLowerCase() === R2_BUCKET.toLowerCase());
          R2_BUCKET_REAL = match || nomes[0];
          console.log('[R2] auto-descoberta — buckets reais:', JSON.stringify(nomes), '| usando:', R2_BUCKET_REAL);
        } else {
          console.log('[R2] auto-descoberta — nenhum bucket retornado pela conta');
        }
      } catch (e) {
        console.error('[R2] auto-descoberta falhou (mantendo nome da variável):', e.message);
      }
    })();
  } else {
    console.log('[R2] variáveis de ambiente ausentes — anexos desabilitados');
  }
} catch (e) {
  console.error('[R2] falha ao inicializar (lib @aws-sdk/client-s3 instalada?):', e.message);
  r2Client = null;
}

// Faz upload de um Buffer para o R2 e retorna a chave (caminho) do objeto.
async function r2Upload(chave, buffer, contentType) {
  if (!r2Client) throw new Error('R2 não configurado.');
  await r2Client.send(new R2_PutObjectCommand({
    Bucket: R2_BUCKET_REAL, Key: chave, Body: buffer, ContentType: contentType || 'application/octet-stream'
  }));
  return chave;
}

// Baixa um objeto do R2 e retorna { buffer, contentType }.
async function r2Download(chave) {
  if (!r2Client) throw new Error('R2 não configurado.');
  const resp = await r2Client.send(new R2_GetObjectCommand({ Bucket: R2_BUCKET_REAL, Key: chave }));
  const chunks = [];
  for await (const c of resp.Body) chunks.push(c);
  return { buffer: Buffer.concat(chunks), contentType: resp.ContentType || 'application/octet-stream' };
}

async function r2Delete(chave) {
  if (!r2Client) throw new Error('R2 não configurado.');
  await r2Client.send(new R2_DeleteObjectCommand({ Bucket: R2_BUCKET_REAL, Key: chave }));
}

// Logs completos somente quando necessário. Em produção, deixe MOVATAK_DEBUG=false
// para não poluir o Railway com payloads grandes da Z-API/Rastreiobot.
const MOVATAK_DEBUG = String(process.env.MOVATAK_DEBUG || '').toLowerCase() === 'true';
function logDebug(...args) {
  if (MOVATAK_DEBUG) console.log(...args);
}

// Regras anti-spam e segurança operacional.
// Ajustáveis via Railway sem mexer no código.
const MOVATAK_REENTRADA_FU1_HORAS = parseInt(process.env.MOVATAK_REENTRADA_FU1_HORAS || '6', 10);
const MOVATAK_MAX_AUTO_MSG_DIA = parseInt(process.env.MOVATAK_MAX_AUTO_MSG_DIA || '6', 10);
const MOVATAK_QUEST_LEMBRETE_HORAS = parseInt(process.env.MOVATAK_QUEST_LEMBRETE_HORAS || '6', 10);
const MOVATAK_QUEST_MAX_LEMBRETES = parseInt(process.env.MOVATAK_QUEST_MAX_LEMBRETES || '1', 10);

const DEFAULT_CLIENTE_PERMISSOES = {
  ver_dashboard: true,
  ver_cpl: true,
  ver_vendedores: true,
  ver_campanhas: true,
  ver_eventos: true,
  editar_vendedores: false,
  editar_followup: false,
  editar_campanhas: false,
  exportar_csv: true
};

function normalizarPermissoes(permissoes) {
  return { ...DEFAULT_CLIENTE_PERMISSOES, ...(permissoes || {}) };
}

function hashSenha(senha) {
  if (!senha) return null;
  return crypto.createHash('sha256').update(String(senha) + ':' + (process.env.MOVATAK_SECRET || 'movatak')).digest('hex');
}

function gerarToken(prefixo) {
  return prefixo + '_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
}

// ---- Controle de execução de crons (hardening pós-incidente) ----
// No serviço reserva, setar MOVATAK_CRON_ATIVO=false evita cron duplicado no mesmo banco.
const CRON_ATIVO = String(process.env.MOVATAK_CRON_ATIVO ?? 'true').toLowerCase() !== 'false';

module.exports = {
  MOVATAK_VERSION,
  R2_BUCKET,
  R2_PRONTO,
  r2Client,
  r2Upload,
  r2Download,
  r2Delete,
  R2_ListBucketsCommand,
  get R2_BUCKET_REAL() { return R2_BUCKET_REAL; },
  MOVATAK_DEBUG,
  logDebug,
  MOVATAK_REENTRADA_FU1_HORAS,
  MOVATAK_MAX_AUTO_MSG_DIA,
  MOVATAK_QUEST_LEMBRETE_HORAS,
  MOVATAK_QUEST_MAX_LEMBRETES,
  DEFAULT_CLIENTE_PERMISSOES,
  normalizarPermissoes,
  hashSenha,
  gerarToken,
  CRON_ATIVO,
};

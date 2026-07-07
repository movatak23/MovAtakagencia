'use strict';

// ============================================================
// Smoke test da refatoração.
//
// Objetivo: confirmar que index.js e todos os módulos em src/ carregam
// (require) sem lançar erro, com variáveis de ambiente falsas — SEM
// conectar num banco de verdade e SEM depender de credenciais reais.
//
// Uso: npm run smoke
// ============================================================

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const SRC_DIR = path.join(RAIZ, 'src');

const ENV_FALSO = {
  ...process.env,
  DATABASE_URL: 'postgres://smoke:smoke@127.0.0.1:59999/smoke_test_nao_existe',
  MOVATAK_SECRET: 'smoke-secret',
  MOVATAK_PORT: '',
  PORT: String(33210 + Math.floor(Math.random() * 500)),
  MOVATAK_CRON_ATIVO: 'false',
  MOVATAK_DEBUG: 'false',
  ZAPI_CAPTACAO_INSTANCE: 'smoke-instance',
  ZAPI_CAPTACAO_TOKEN: 'smoke-token',
  ZAPI_CAPTACAO_CLIENT_TOKEN: 'smoke-client-token',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_ENDPOINT: '',
  R2_BUCKET: '',
  ANTHROPIC_API_KEY: 'smoke-key',
  OPENAI_API_KEY: 'smoke-key',
  GOOGLE_PLACES_API_KEY: 'smoke-key',
};

function listarArquivosJs(dir) {
  if (!fs.existsSync(dir)) return [];
  const resultado = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const caminho = path.join(dir, entrada.name);
    if (entrada.isDirectory()) resultado.push(...listarArquivosJs(caminho));
    else if (entrada.name.endsWith('.js')) resultado.push(caminho);
  }
  return resultado;
}

// Requer cada módulo de src/ isoladamente, num processo filho, com o mesmo
// env falso. Um módulo com efeito colateral no require (ex.: abrir servidor)
// não deve travar os demais — por isso cada um roda no seu próprio processo.
function checarRequireIsolado(arquivo) {
  return new Promise((resolve) => {
    const codigo = `require(${JSON.stringify(arquivo)}); process.exit(0);`;
    const filho = spawn(process.execPath, ['-e', codigo], {
      cwd: RAIZ,
      env: ENV_FALSO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    filho.stderr.on('data', (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => {
      filho.kill('SIGKILL');
      resolve({ arquivo, ok: false, erro: 'timeout ao carregar o módulo (>5s)' });
    }, 5000);
    filho.on('exit', (codeSaida) => {
      clearTimeout(timeout);
      if (codeSaida === 0) resolve({ arquivo, ok: true });
      else resolve({ arquivo, ok: false, erro: stderr.trim() || `exit code ${codeSaida}` });
    });
  });
}

// index.js hoje inicia um servidor HTTP de verdade ao ser carregado
// (httpServer.listen). Por isso, ao invés de require() direto, sobe como
// processo separado e considera sucesso assim que ele loga que subiu —
// sem esperar as migrações de banco (que falham contra o DATABASE_URL
// falso, mas de forma tratada, só gerando um console.error).
function checarBootIndex() {
  return new Promise((resolve) => {
    const arquivoIndex = path.join(RAIZ, 'index.js');
    const filho = spawn(process.execPath, [arquivoIndex], {
      cwd: RAIZ,
      env: ENV_FALSO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let resolvido = false;

    const finalizar = (ok, erro) => {
      if (resolvido) return;
      resolvido = true;
      clearTimeout(timeout);
      filho.kill('SIGKILL');
      resolve({ arquivo: 'index.js', ok, erro });
    };

    filho.stdout.on('data', (d) => {
      stdout += d.toString();
      if (/rodando na porta/i.test(stdout)) finalizar(true);
    });
    filho.stderr.on('data', (d) => { stderr += d.toString(); });
    filho.on('exit', (codeSaida) => {
      if (!resolvido) finalizar(false, stderr.trim() || `processo saiu sozinho com code ${codeSaida}`);
    });
    const timeout = setTimeout(() => {
      finalizar(false, 'timeout esperando o log de boot (>8s)\n' + stderr);
    }, 8000);
  });
}

async function main() {
  const arquivosSrc = listarArquivosJs(SRC_DIR);
  const tarefas = [checarBootIndex(), ...arquivosSrc.map(checarRequireIsolado)];
  const resultados = await Promise.all(tarefas);

  let falhou = false;
  for (const r of resultados) {
    const relativo = path.relative(RAIZ, path.isAbsolute(r.arquivo) ? r.arquivo : path.join(RAIZ, r.arquivo));
    if (r.ok) {
      console.log(`[smoke] OK   ${relativo}`);
    } else {
      falhou = true;
      console.error(`[smoke] FAIL ${relativo}\n${r.erro}`);
    }
  }

  if (falhou) {
    console.error('\n[smoke] Falhou. Veja os erros acima.');
    process.exit(1);
  }
  console.log(`\n[smoke] OK — ${resultados.length} módulo(s) carregado(s) sem erro.`);
}

main();

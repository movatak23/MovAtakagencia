#!/usr/bin/env node
/**
 * Suíte de testes das funções puras do MovaAtak.
 *
 * Como funciona: extrai as funções puras diretamente do index.js (por regex no
 * fonte) e as avalia isoladamente. Isso permite testar sem subir servidor nem
 * conectar ao banco. Rode ANTES de cada deploy:
 *
 *     node test-movatak.js
 *
 * Saída: lista de PASS/FAIL e código de saída 1 se algo falhar (trava deploy).
 *
 * Cobre os bugs corrigidos para impedir regressão:
 *  - variantesTelefone: mismatch do 9º dígito (bug do contador / reentrada)
 *  - textoBateGatilho: respostas curtas disparando reentrada (bug "começa de novo")
 *  - contemComando: falso positivo de substring (bug "banana" vs vendedora Ana)
 *  - resolverSaltoQuestionario: saltos condicionais
 *  - erroEstruturaBanco: mascaramento de erro de query (bug do GROUP BY)
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

// Extrai o corpo de uma função declarada (function nome(...) { ... }) do fonte.
function extrairFuncao(nome) {
  const re = new RegExp('function ' + nome + '\\s*\\([\\s\\S]*?\\n\\}\\n', 'm');
  const m = SRC.match(re);
  if (!m) throw new Error('Função não encontrada no index.js: ' + nome);
  return m[0];
}

// Monta um sandbox com as funções puras (respeitando dependências entre elas).
const codigo = [
  'normalizarTexto',
  'normalizarGatilho',
  'normalizarComandoComparacao',
  'variantesTelefone',
  'textoBateGatilho',
  'contemComando',
  'resolverSaltoQuestionario',
  'erroEstruturaBanco'
].map(extrairFuncao).join('\n');

// eslint-disable-next-line no-eval
eval(codigo);

let passou = 0, falhou = 0;
const falhas = [];

function eq(desc, obtido, esperado) {
  const a = JSON.stringify(Array.isArray(obtido) ? obtido.slice().sort() : obtido);
  const b = JSON.stringify(Array.isArray(esperado) ? esperado.slice().sort() : esperado);
  const ok = a === b;
  if (ok) { passou++; }
  else { falhou++; falhas.push(`${desc}\n    esperado: ${b}\n    obtido:   ${a}`); }
  console.log((ok ? '  ✓ ' : '  ✗ ') + desc);
}

function grupo(nome, fn) { console.log('\n' + nome); fn(); }

// ============ variantesTelefone ============
grupo('variantesTelefone (mismatch do 9º dígito)', () => {
  eq('com 9 (13 díg) gera versão sem 9', variantesTelefone('5581976041948'), ['5581976041948', '558176041948']);
  eq('sem 9 (12 díg) gera versão com 9', variantesTelefone('558176041948'), ['558176041948', '5581976041948']);
  eq('formatado é limpo e expandido', variantesTelefone('+55 (81) 97604-1948'), ['5581976041948', '558176041948']);
  eq('sem DDI 55 fica como veio', variantesTelefone('81976041948'), ['81976041948']);
  eq('vazio retorna lista vazia', variantesTelefone(''), []);
});

// ============ textoBateGatilho ============
grupo('textoBateGatilho (respostas curtas não disparam reentrada)', () => {
  const G = 'Olá! Vi seu anúncio e tenho interesse no plano de internet';
  eq('resposta "Esse" NÃO bate', textoBateGatilho('Esse', G), false);
  eq('resposta "internet" NÃO bate', textoBateGatilho('internet', G), false);
  eq('resposta "sim" NÃO bate', textoBateGatilho('sim', G), false);
  eq('gatilho exato bate', textoBateGatilho(G, G), true);
  eq('frase substancial do anúncio bate', textoBateGatilho('tenho interesse no plano de internet', G), true);
});

// ============ contemComando ============
grupo('contemComando (sem falso positivo de substring)', () => {
  eq('"banana" NÃO bate slug "ana"', contemComando('banana', ['ana']), false);
  eq('"semana que vem" NÃO bate "ana"', contemComando('semana que vem', ['ana']), false);
  eq('"ana" isolado bate', contemComando('ana', ['ana']), true);
  eq('"obrigado ana" bate (palavra isolada)', contemComando('obrigado ana', ['ana']), true);
  eq('"fechado #ana" bate "#ana"', contemComando('fechado #ana', ['#ana']), true);
  eq('"banana" NÃO bate "#ana"', contemComando('banana', ['#ana']), false);
  eq('"#parar" bate', contemComando('#parar', ['#parar']), true);
  eq('"quero parar isso" NÃO bate "#parar"', contemComando('quero parar isso', ['#parar']), false);
});

// ============ resolverSaltoQuestionario ============
grupo('resolverSaltoQuestionario (saltos condicionais)', () => {
  const passos = [{ id: 'q1' }, { id: 'q2', saltos: { '1': 'q3', '2': '__fim__' } }, { id: 'q3' }, { id: 'q4' }];
  eq('opção 1 → índice de q3 (2)', resolverSaltoQuestionario(passos[1], 1, passos), 2);
  eq('opção 2 → fim (-1)', resolverSaltoQuestionario(passos[1], 2, passos), -1);
  eq('opção sem regra → linear (null)', resolverSaltoQuestionario(passos[1], 3, passos), null);
  eq('pergunta sem saltos → null', resolverSaltoQuestionario(passos[0], 1, passos), null);
  eq('destino inexistente → null', resolverSaltoQuestionario({ saltos: { '1': 'qX' } }, 1, passos), null);
});

// ============ erroEstruturaBanco ============
grupo('erroEstruturaBanco (não mascara erro de query)', () => {
  eq('coluna não existe → silencia (true)', erroEstruturaBanco({ message: 'column "x" does not exist' }), true);
  eq('tabela não existe → silencia (true)', erroEstruturaBanco({ message: 'relation "y" does not exist' }), true);
  eq('GROUP BY → NÃO silencia (false)', erroEstruturaBanco({ message: 'column "c.questionario_ativo" must appear in the GROUP BY clause' }), false);
  eq('ambiguidade → NÃO silencia (false)', erroEstruturaBanco({ message: 'column reference "id" is ambiguous' }), false);
  eq('syntax error → NÃO silencia (false)', erroEstruturaBanco({ message: 'syntax error at or near' }), false);
});

// ============ resultado ============
console.log('\n' + '─'.repeat(50));
console.log(`Total: ${passou + falhou}  |  PASS: ${passou}  |  FAIL: ${falhou}`);
if (falhou) {
  console.log('\nFALHAS:');
  falhas.forEach(f => console.log('  • ' + f));
  process.exit(1);
}
console.log('Tudo verde. Seguro para deploy.');
process.exit(0);

'use strict';

// ============================================================
// Teste de regressão dos COMANDOS internos.
//
// Por que existe: em 17/09/2026 a mensagem rápida "Olá, tudo bem? Sou a #atendente
// Rebeka..." foi lida como COMANDO DE CONVERSÃO e marcou 94 leads como cliente,
// pausando os follow-ups deles. A causa foi o fallback de comando pelo NOME do
// vendedor SEM '#', que casava com a palavra "Rebeka" em qualquer lugar do texto.
//
// Este teste trava as duas garantias:
//   1. comandosDoVendedor só gera a forma COM '#';
//   2. um texto que apenas CITA o nome do vendedor não vira comando.
//
// Uso: npm test   (roda junto do smoke)
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX = path.join(__dirname, '..', 'index.js');
const src = fs.readFileSync(INDEX, 'utf8');

// Lê a função direto do index.js (elas não são exportadas). Se alguém renomear ou
// mover, o teste FALHA de propósito — é um alarme, não um incômodo.
function pegarFuncao(nome) {
  const i = src.indexOf('function ' + nome + '(');
  if (i < 0) throw new Error('função ' + nome + ' não encontrada no index.js — foi renomeada/movida?');
  let profundidade = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') profundidade++;
    else if (src[k] === '}') {
      profundidade--;
      if (profundidade === 0) return src.slice(i, k + 1);
    }
  }
  throw new Error('não consegui delimitar a função ' + nome);
}

const ctx = {};
vm.createContext(ctx);
['normalizarTexto', 'normalizarComandoComparacao', 'contemComando', 'slugComando', 'comandosDoVendedor']
  .forEach(n => vm.runInContext(pegarFuncao(n), ctx));

let falhas = 0;
function checar(nome, condicao, extra) {
  if (condicao) { console.log('[comandos] OK   ' + nome); return; }
  falhas++;
  console.error('[comandos] FALHOU ' + nome + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
}

const rebeka = { id: 9, nome: 'Rebeka', comando: '#rebeka' };
const ronaldo = { id: 8, nome: 'Ronaldo Valério', comando: null };
const bate = (v, t) => ctx.contemComando(t, ctx.comandosDoVendedor(v));

// O texto real que causou o incidente.
const SAUDACAO = 'Olá, tudo bem? Sou a #atendente Rebeka e estou disponível para te atender';

checar('comando do vendedor nunca é gerado sem #',
  ctx.comandosDoVendedor(rebeka).every(c => c.startsWith('#')), ctx.comandosDoVendedor(rebeka));
checar('fallback pelo nome gera #slug',
  ctx.comandosDoVendedor(ronaldo).includes('#ronaldovalerio'), ctx.comandosDoVendedor(ronaldo));
checar('a mensagem de saudação NÃO é comando (o incidente de 17/09)', !bate(rebeka, SAUDACAO));
checar('citar o nome no meio do texto não converte', !bate(rebeka, 'vou pedir pra Rebeka te ajudar'));
checar('citar o nome junto de outro # também não', !bate(rebeka, 'a Rebeka já respondeu, digite #atendente'));
checar('#rebeka continua convertendo', bate(rebeka, '#rebeka'));
checar('#rebeka no fim da frase continua', bate(rebeka, 'Fechado! #rebeka'));
checar('#ronaldovalerio pelo nome continua', bate(ronaldo, 'venda fechada #ronaldovalerio'));
checar('comando de um não casa com o outro', !bate(ronaldo, 'Fechado! #rebeka'));

if (falhas) {
  console.error('\n[comandos] ' + falhas + ' falha(s) — NÃO suba isto: risco de marcar lead como cliente sozinho.');
  process.exit(1);
}
console.log('\n[comandos] OK — ' + 9 + ' verificações passaram.');

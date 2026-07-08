'use strict';

const { Server: SocketIOServer } = require('socket.io');
const { query } = require('./db');

// ============================================================
// Socket.io — tela de atendimento em tempo real
// Mantém app.listen funcionando igual antes: criamos um servidor HTTP
// explícito só para poder amarrar o socket nele, sem mudar nenhuma rota.
// ============================================================
let io = null;

function inicializarRealtime(httpServer) {
  io = new SocketIOServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
  });

  io.use(async (socket, next) => {
    const auth = socket.handshake.auth || {};
    const secret = auth.secret;
    if (secret && secret === process.env.MOVATAK_SECRET) {
      socket.data.role = 'admin';
      return next();
    }
    const vendedorToken = auth.vendedorToken;
    if (vendedorToken) {
      try {
        const r = await query(
          `SELECT v.id, v.cliente_id
             FROM movatak_vendedores v
             JOIN movatak_clientes c ON c.id = v.cliente_id
            WHERE v.acesso_token = $1 AND v.ativo = true AND c.ativo = true
            LIMIT 1`,
          [vendedorToken]
        );
        if (r.rows.length) {
          socket.data.role = 'vendedor';
          socket.data.vendedorId = r.rows[0].id;
          socket.data.clienteId = r.rows[0].cliente_id;
          return next();
        }
      } catch (e) {
        return next(new Error('Não autorizado.'));
      }
    }
    return next(new Error('Não autorizado.'));
  });

  io.on('connection', (socket) => {
    // Cada painel entra na "sala" do cliente que está vendo, para não
    // receber eventos de outros ISPs clientes do Movatak. Vendedores só entram
    // na sala do próprio cliente, mesmo se tentarem informar outro ID no front.
    socket.on('entrar-cliente', (clienteId) => {
      if (!clienteId) return;
      if (socket.data.role === 'vendedor' && Number(clienteId) !== Number(socket.data.clienteId)) return;
      socket.join(`cliente-${clienteId}`);
    });
  });

  return io;
}

// Chame esta função em qualquer ponto do código que precise avisar o
// painel em tempo real sobre uma mensagem nova de um lead.
function emitirMensagemLead(clienteId, leadId, mensagem) {
  if (!clienteId) return;
  io.to(`cliente-${clienteId}`).emit('mensagem:nova', { leadId, mensagem });
}

function emitirMensagemApagada(clienteId, leadId, conversaId) {
  if (!clienteId) return;
  io.to(`cliente-${clienteId}`).emit('mensagem:apagada', { leadId, conversaId });
}

function emitirStatusMensagem(clienteId, leadId, conversaId, status) {
  if (!clienteId) return;
  io.to(`cliente-${clienteId}`).emit('mensagem:status', { leadId, conversaId, status });
}

// Avisa os painéis abertos, em tempo real, que flags de um lead mudaram
// (ex: pediu_atendente, nao_lida, automacao_pausada). O front aplica no
// estado em memória e re-renderiza inbox/badges sem esperar o reload.
function emitirLeadFlags(clienteId, leadId, flags) {
  if (!clienteId || !leadId) return;
  io.to(`cliente-${clienteId}`).emit('lead:flags', { leadId, flags: flags || {} });
}

module.exports = {
  inicializarRealtime,
  emitirMensagemLead,
  emitirMensagemApagada,
  emitirStatusMensagem,
  emitirLeadFlags,
};

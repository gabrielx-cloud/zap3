const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { maxHttpBufferSize: 25e6 }); // Limite de 25MB
const fs = require('fs');
const path = require('path');

// ==========================================
// 1. ARMAZENAMENTO EM ARQUIVO JSON
// ==========================================
const DB_FILE = path.join(__dirname, 'banco.json');
const MAX_MENSAGENS = 200; // Evita que o banco.json fique gigante com fotos Base64

function lerBanco() {
  if (!fs.existsSync(DB_FILE)) {
    const inicial = { users: [], avatars: {}, messages: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(inicial));
    return inicial;
  }
  try {
    const dados = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    if (!dados.avatars) dados.avatars = {};
    if (!dados.messages) dados.messages = [];
    if (!dados.users) dados.users = [];
    return dados;
  } catch (erro) {
    console.error('Erro ao ler banco.json, recriando arquivo:', erro);
    const inicial = { users: [], avatars: {}, messages: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(inicial));
    return inicial;
  }
}

function salvarBanco(dados) {
  // Mantém apenas as últimas MAX_MENSAGENS para não travar o servidor
  if (dados.messages.length > MAX_MENSAGENS) {
    dados.messages = dados.messages.slice(-MAX_MENSAGENS);
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(dados));
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) {
      console.error('Erro ao carregar o index.html:', err);
      res.status(500).send('Erro interno ao carregar a página do chat.');
    }
  });
});

const onlineUsers = new Map();

// ==========================================
// 2. EVENTOS DO SOCKET.IO
// ==========================================
io.on('connection', (socket) => {
  console.log('Nova conexão:', socket.id);

  socket.on('error', (erro) => {
    console.error('Erro no socket:', erro);
  });

  // Envia os avatares salvos ao conectar
  try {
    const dbInicial = lerBanco();
    socket.emit('avatars update', dbInicial.avatars);
  } catch (erro) {
    console.error('Erro ao ler avatares iniciais:', erro);
  }

  // Autentica, valida nome, entra na Geral e retorna o histórico inicial
  socket.on('autenticar', (nome, callback) => {
    try {
      const username = nome ? nome.trim() : '';
      if (!username) {
        return callback({ ok: false, error: 'Por favor, preencha um nome válido.' });
      }

      if (onlineUsers.has(username) && onlineUsers.get(username) !== socket.id) {
        return callback({ ok: false, error: 'Este nome já está em uso no momento.' });
      }

      const db = lerBanco();
      if (!db.users.includes(username)) {
        db.users.push(username);
        salvarBanco(db);
      }

      socket.username = username;
      onlineUsers.set(username, socket.id);

      socket.join('Geral');
      socket.currentRoom = 'Geral';

      const historicoGeral = db.messages.filter((m) => m.room === 'Geral').slice(-50);

      io.emit('online users', Array.from(onlineUsers.keys()));
      io.emit('novo usuario', username);

      callback({
        ok: true,
        username,
        avatar: db.avatars[username] || null,
        historicoGeral
      });
    } catch (erro) {
      console.error('Erro na autenticação:', erro);
      callback({ ok: false, error: 'Erro interno ao entrar no chat.' });
    }
  });

  // Atualizar foto de perfil
  socket.on('update avatar', (avatarDataUrl) => {
    try {
      if (!socket.username) {
        return socket.emit('erro chat', 'Preencha seu nome antes de trocar a foto de perfil.');
      }
      if (!avatarDataUrl || typeof avatarDataUrl !== 'string') {
        return socket.emit('erro chat', 'Imagem de perfil inválida.');
      }

      const db = lerBanco();
      db.avatars[socket.username] = avatarDataUrl;
      salvarBanco(db);

      io.emit('avatars update', db.avatars);
    } catch (erro) {
      console.error('Erro ao salvar avatar:', erro);
      socket.emit('erro chat', 'Erro ao atualizar foto de perfil.');
    }
  });

  // Entrar em uma sala e carregar histórico
  socket.on('join room', (room) => {
    try {
      if (!socket.username) return;
      socket.rooms.forEach((r) => {
        if (r !== socket.id) socket.leave(r);
      });
      socket.join(room);
      socket.currentRoom = room;

      const db = lerBanco();
      const historicoSala = db.messages.filter((m) => m.room === room).slice(-50);
      socket.emit('room history', historicoSala);
    } catch (erro) {
      console.error('Erro ao entrar na sala:', erro);
      socket.emit('erro chat', 'Não foi possível carregar o histórico da sala.');
    }
  });

  // Enviar mensagem de texto na sala
  socket.on('chat message', (content) => {
    try {
      if (!socket.username) {
        return socket.emit('erro chat', 'Você precisa preencher seu nome antes de enviar mensagens.');
      }
      if (!content || typeof content !== 'string' || !content.trim()) {
        return socket.emit('erro chat', 'A mensagem não pode estar vazia.');
      }

      const room = socket.currentRoom || 'Geral';
      const db = lerBanco();
      db.messages.push({
        sender: socket.username,
        recipient: null,
        room,
        content: content.trim(),
        timestamp: new Date().toISOString()
      });
      salvarBanco(db);

      io.to(room).emit('chat message', { sender: socket.username, content: content.trim(), room });
    } catch (erro) {
      console.error('Erro ao enviar mensagem:', erro);
      socket.emit('erro chat', 'Erro interno ao enviar mensagem.');
    }
  });

  // Enviar foto na conversa (sala ou privado) com legenda opcional
  socket.on('chat image', ({ image, caption, isPrivate, recipient }) => {
    try {
      if (!socket.username) {
        return socket.emit('erro chat', 'Preencha seu nome antes de enviar fotos.');
      }
      if (!image || typeof image !== 'string') {
        return socket.emit('erro chat', 'Imagem inválida.');
      }

      const legenda = caption ? caption.trim() : '';
      const db = lerBanco();

      if (isPrivate && recipient) {
        db.messages.push({
          sender: socket.username,
          recipient,
          room: null,
          image,
          caption: legenda,
          timestamp: new Date().toISOString()
        });
        salvarBanco(db);

        const msgData = { sender: socket.username, recipient, image, caption: legenda };
        const recipientSocketId = onlineUsers.get(recipient);
        if (recipientSocketId) io.to(recipientSocketId).emit('private message', msgData);
        socket.emit('private message', msgData);
      } else {
        const room = socket.currentRoom || 'Geral';
        db.messages.push({
          sender: socket.username,
          recipient: null,
          room,
          image,
          caption: legenda,
          timestamp: new Date().toISOString()
        });
        salvarBanco(db);

        io.to(room).emit('chat message', { sender: socket.username, image, caption: legenda, room });
      }
    } catch (erro) {
      console.error('Erro ao enviar foto:', erro);
      socket.emit('erro chat', 'Erro ao processar a foto.');
    }
  });

  // Carregar histórico privado
  socket.on('load private history', (otherUser) => {
    try {
      if (!socket.username) return;
      const db = lerBanco();
      const historicoPrivado = db.messages
        .filter(
          (m) =>
            (m.sender === socket.username && m.recipient === otherUser) ||
            (m.sender === otherUser && m.recipient === socket.username)
        )
        .slice(-50);

      socket.emit('private history', { withUser: otherUser, messages: historicoPrivado });
    } catch (erro) {
      console.error('Erro ao carregar privado:', erro);
      socket.emit('erro chat', 'Erro ao carregar mensagens privadas.');
    }
  });

  // Enviar mensagem privada
  socket.on('private message', ({ recipient, content }) => {
    try {
      if (!socket.username) {
        return socket.emit('erro chat', 'Preencha seu nome antes de enviar mensagens.');
      }
      if (!recipient || !content || typeof content !== 'string' || !content.trim()) {
        return socket.emit('erro chat', 'Destinatário e mensagem são obrigatórios.');
      }

      const db = lerBanco();
      db.messages.push({
        sender: socket.username,
        recipient,
        room: null,
        content: content.trim(),
        timestamp: new Date().toISOString()
      });
      salvarBanco(db);

      const msgData = { sender: socket.username, recipient, content: content.trim() };
      const recipientSocketId = onlineUsers.get(recipient);
      if (recipientSocketId) io.to(recipientSocketId).emit('private message', msgData);
      socket.emit('private message', msgData);
    } catch (erro) {
      console.error('Erro ao enviar mensagem privada:', erro);
      socket.emit('erro chat', 'Erro ao enviar mensagem privada.');
    }
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      onlineUsers.delete(socket.username);
      io.emit('online users', Array.from(onlineUsers.keys()));
    }
  });
});

http.on('error', (erro) => {
  console.error('Erro no servidor HTTP:', erro.message);
});

http.listen(3000, () => {
  console.log('Servidor rodando na porta 3000 - Link http://localhost:3000');
});
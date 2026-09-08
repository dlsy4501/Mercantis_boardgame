const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const {
  createGameState, resolveTurn, freshMeta,
  computeStandings, awardCoins, pickRandomRune, resolveAuction, checkPregameExit
} = require('./game-logic');

const PORT = process.env.PORT || 3000;
const TURN_TIMEOUT_MS = 25000;
const BID_TIMEOUT_MS = 20000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// rooms[code] = {
//   hostTag, players: [tag,...], status: 'waiting'|'pregame'|'playing'|'over',
//   state: <메인 게임 상태 or null>, pendingActions: {},
//   pregame: { state, meta, bidding: bool, rune, bids, bidStartedAt } | null
// }
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function publicLobby(room) {
  return { hostTag: room.hostTag, players: room.players, status: room.status };
}
function broadcastLobby(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('lobby-update', publicLobby(room));
}
function broadcastState(code) {
  const room = rooms[code];
  if (!room || !room.state) return;
  io.to(code).emit('state-update', room.state);
}
function broadcastPregameState(code) {
  const room = rooms[code];
  if (!room || !room.pregame) return;
  io.to(code).emit('pregame-state-update', { state: room.pregame.state, meta: room.pregame.meta });
}
function broadcastAuction(code) {
  const room = rooms[code];
  if (!room || !room.pregame) return;
  io.to(code).emit('pregame-auction', {
    rune: room.pregame.rune, meta: room.pregame.meta,
    bidTags: Object.keys(room.pregame.bids)
  });
}

/* ================= 메인 게임 턴 진행 ================= */
function scheduleTimeoutCheck(code) {
  const room = rooms[code];
  if (!room || room.status !== 'playing') return;
  const turnAtSchedule = room.state.turn;
  setTimeout(() => {
    const r = rooms[code];
    if (!r || !r.state || r.state.phase !== 'playing') return;
    if (r.state.turn !== turnAtSchedule) return;
    tryResolveMain(code, true);
  }, TURN_TIMEOUT_MS + 500);
}
function tryResolveMain(code, forceTimeout) {
  const room = rooms[code];
  if (!room || !room.state || room.state.phase !== 'playing') return;
  const state = room.state;
  const aliveTags = state.seatOrder.filter(t => state.players[t].alive);
  const needed = aliveTags.filter(t => state.players[t].hand.length > 0);
  const submitted = needed.filter(t => room.pendingActions[t] !== undefined);
  const timedOut = forceTimeout || (Date.now() - state.turnStartedAt) > TURN_TIMEOUT_MS;
  if (submitted.length < needed.length && !timedOut) return;

  resolveTurn(state, room.pendingActions);
  room.pendingActions = {};
  broadcastState(code);
  if (state.phase === 'over') {
    room.status = 'over';
  } else {
    scheduleTimeoutCheck(code);
  }
}

/* ================= 전초전(사전 미니게임) 턴 진행 ================= */
function scheduleMiniTimeoutCheck(code) {
  const room = rooms[code];
  if (!room || !room.pregame || room.pregame.bidding) return;
  const turnAtSchedule = room.pregame.state.turn;
  setTimeout(() => {
    const r = rooms[code];
    if (!r || !r.pregame || r.pregame.bidding) return;
    if (r.pregame.state.turn !== turnAtSchedule) return;
    tryResolveMini(code, true);
  }, TURN_TIMEOUT_MS + 500);
}
function tryResolveMini(code, forceTimeout) {
  const room = rooms[code];
  if (!room || !room.pregame || room.pregame.bidding) return;
  const state = room.pregame.state;
  if (state.phase !== 'playing') return;
  const aliveTags = state.seatOrder.filter(t => state.players[t].alive);
  const needed = aliveTags.filter(t => state.players[t].hand.length > 0);
  const submitted = needed.filter(t => room.pendingActions[t] !== undefined);
  const timedOut = forceTimeout || (Date.now() - state.turnStartedAt) > TURN_TIMEOUT_MS;
  if (submitted.length < needed.length && !timedOut) return;

  resolveTurn(state, room.pendingActions);
  room.pendingActions = {};

  if (state.phase === 'over') {
    // 미니게임 한 판 종료 -> 등수/코인 지급 -> 다음 경매로
    const standings = computeStandings(state);
    const msg = awardCoins(room.pregame.meta, standings);
    io.to(code).emit('pregame-round-result', { msg, meta: room.pregame.meta });

    const exitTag = checkPregameExit(room.pregame.meta);
    if (exitTag) {
      // 전초전 종료 -> 본게임으로
      room.status = 'playing';
      room.state = createGameState(room.players.slice(), room.pregame.meta);
      const finalMeta = room.pregame.meta;
      room.pregame = null;
      io.to(code).emit('pregame-summary', { meta: finalMeta });
      broadcastLobby(code);
      broadcastState(code);
      scheduleTimeoutCheck(code);
    } else {
      startNextAuction(code);
    }
  } else {
    broadcastPregameState(code);
    scheduleMiniTimeoutCheck(code);
  }
}

function startNextAuction(code) {
  const room = rooms[code];
  room.pregame.bidding = true;
  room.pregame.rune = pickRandomRune();
  room.pregame.bids = {};
  room.pregame.bidStartedAt = Date.now();
  broadcastAuction(code);
  scheduleBidTimeoutCheck(code);
}
function scheduleBidTimeoutCheck(code) {
  setTimeout(() => {
    const room = rooms[code];
    if (!room || !room.pregame || !room.pregame.bidding) return;
    tryResolveBids(code, true);
  }, BID_TIMEOUT_MS + 500);
}
function tryResolveBids(code, forceTimeout) {
  const room = rooms[code];
  if (!room || !room.pregame || !room.pregame.bidding) return;
  const pg = room.pregame;
  const timedOut = forceTimeout || (Date.now() - pg.bidStartedAt) > BID_TIMEOUT_MS;
  if (Object.keys(pg.bids).length < room.players.length && !timedOut) return;

  pg.bidding = false;
  const result = resolveAuction(pg.meta, pg.rune, pg.bids);
  io.to(code).emit('pregame-auction-result', { msg: result.msg, meta: pg.meta });

  // 다음 미니게임 라운드 시작
  pg.state = createGameState(room.players.slice(), pg.meta);
  room.pendingActions = {};
  broadcastPregameState(code);
  scheduleMiniTimeoutCheck(code);
}

/* ================= 소켓 이벤트 ================= */
io.on('connection', (socket) => {
  socket.data.tag = null;
  socket.data.code = null;

  socket.on('create-room', ({ tag }, cb) => {
    tag = (tag || '').trim().slice(0, 12);
    if (!tag) return cb({ ok: false, error: '상단 이름을 입력하세요.' });
    const code = genCode();
    rooms[code] = {
      hostTag: tag, players: [tag], status: 'waiting',
      state: null, pendingActions: {}, pregame: null
    };
    socket.data.tag = tag; socket.data.code = code;
    socket.join(code);
    cb({ ok: true, code });
    broadcastLobby(code);
  });

  socket.on('join-room', ({ tag, code }, cb) => {
    tag = (tag || '').trim().slice(0, 12);
    code = (code || '').trim().toUpperCase();
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: '해당 방 코드를 찾을 수 없습니다.' });
    if (room.status !== 'waiting') return cb({ ok: false, error: '이미 시작된 방입니다.' });
    if (room.players.includes(tag)) return cb({ ok: false, error: '이미 사용 중인 상단 이름입니다.' });
    if (room.players.length >= 6) return cb({ ok: false, error: '이 방은 가득 찼습니다 (최대 6개 상단).' });
    room.players.push(tag);
    socket.data.tag = tag; socket.data.code = code;
    socket.join(code);
    cb({ ok: true, code });
    broadcastLobby(code);
  });

  // 전초전 없이 바로 본게임
  socket.on('start-game', (_, cb) => {
    const code = socket.data.code, tag = socket.data.tag;
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: '방을 찾을 수 없습니다.' });
    if (room.hostTag !== tag) return cb && cb({ ok: false, error: '호스트만 시작할 수 있습니다.' });
    if (room.players.length < 3 || room.players.length > 6) return cb && cb({ ok: false, error: '3~6개 상단이 필요합니다.' });
    room.state = createGameState(room.players.slice(), null);
    room.status = 'playing';
    room.pendingActions = {};
    cb && cb({ ok: true });
    broadcastLobby(code);
    broadcastState(code);
    scheduleTimeoutCheck(code);
  });

  // 전초전(경매)부터 시작
  socket.on('start-pregame', (_, cb) => {
    const code = socket.data.code, tag = socket.data.tag;
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: '방을 찾을 수 없습니다.' });
    if (room.hostTag !== tag) return cb && cb({ ok: false, error: '호스트만 시작할 수 있습니다.' });
    if (room.players.length < 3 || room.players.length > 6) return cb && cb({ ok: false, error: '3~6개 상단이 필요합니다.' });
    const meta = {};
    room.players.forEach(t => { meta[t] = freshMeta(); });
    room.status = 'pregame';
    room.pregame = { state: null, meta, bidding: false, rune: null, bids: {}, bidStartedAt: 0 };
    room.pendingActions = {};
    cb && cb({ ok: true });
    broadcastLobby(code);
    startNextAuction(code); // 시작 금화로 첫 경매부터
  });

  // 경매 입찰 (전초전 중)
  socket.on('submit-bid', ({ amount }) => {
    const code = socket.data.code, tag = socket.data.tag;
    const room = rooms[code];
    if (!room || !room.pregame || !room.pregame.bidding) return;
    const meta = room.pregame.meta[tag];
    if (!meta) return;
    amount = Number(amount) || 0;
    if (amount === 1) return; // 1금화는 유효하지 않음
    if (amount < 0 || amount > meta.coins) return;
    room.pregame.bids[tag] = amount;
    io.to(code).emit('bid-submission-update', { bidTags: Object.keys(room.pregame.bids) });
    tryResolveBids(code, false);
  });

  // 카드 액션 제출 (본게임 또는 전초전 미니게임 공용)
  socket.on('submit-action', ({ type, cardId }) => {
    const code = socket.data.code, tag = socket.data.tag;
    const room = rooms[code];
    if (!room) return;
    room.pendingActions[tag] = { type, cardId };
    if (room.status === 'playing') {
      io.to(code).emit('submission-update', { submittedTags: Object.keys(room.pendingActions) });
      tryResolveMain(code, false);
    } else if (room.status === 'pregame' && room.pregame && !room.pregame.bidding) {
      io.to(code).emit('submission-update', { submittedTags: Object.keys(room.pendingActions) });
      tryResolveMini(code, false);
    }
  });

  socket.on('disconnect', () => {
    // 방은 유지 (재접속 여지를 위해 별도 제거 로직은 두지 않음)
  });
});

server.listen(PORT, () => {
  console.log(`메르칸티스 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});

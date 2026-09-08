const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const {
  createGameState, resolveTurn, freshMeta,
  computeStandings, awardCoins, awardLandIncome,
  pickRandomLandYield, resolveLandAuction, checkGoalReached,
  GOAL_COINS
} = require('./game-logic');

const PORT = process.env.PORT || 3000;
const TURN_TIMEOUT_MS = 25000;
const BID_TIMEOUT_MS = 20000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// rooms[code] = {
//   hostTag, players: [tag,...], status: 'waiting'|'playing'|'over',
//   meta: { tag: {coins, lands} },   // 게임 시작부터 끝까지 유지되는 코인/영토 정보
//   state: <체인게임 현재 라운드 상태 or null>, pendingActions: {},
//   auction: { yieldValue, bids, bidStartedAt } | null
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
  io.to(code).emit('state-update', { state: room.state, meta: room.meta });
}
function broadcastAuction(code) {
  const room = rooms[code];
  if (!room || !room.auction) return;
  io.to(code).emit('land-auction', {
    yieldValue: room.auction.yieldValue, meta: room.meta,
    bidTags: Object.keys(room.auction.bids)
  });
}

/* ================= 체인게임 턴 진행 ================= */
function scheduleTimeoutCheck(code) {
  const room = rooms[code];
  if (!room || room.status !== 'playing' || !room.state) return;
  const turnAtSchedule = room.state.turn;
  setTimeout(() => {
    const r = rooms[code];
    if (!r || !r.state || r.state.phase !== 'playing') return;
    if (r.state.turn !== turnAtSchedule) return;
    tryResolveTurn(code, true);
  }, TURN_TIMEOUT_MS + 500);
}

function tryResolveTurn(code, forceTimeout) {
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

  if (state.phase === 'over') {
    finishRound(code);
  } else {
    broadcastState(code);
    scheduleTimeoutCheck(code);
  }
}

/* ================= 라운드 종료 → 코인 지급 → 경매 or 게임 종료 ================= */
function finishRound(code) {
  const room = rooms[code];
  const standings = computeStandings(room.state);
  const rankMsg = awardCoins(room.meta, standings);
  awardLandIncome(room.meta);

  io.to(code).emit('round-result', { msg: rankMsg, meta: room.meta, state: room.state });

  const winnerTag = checkGoalReached(room.meta);
  if (winnerTag) {
    room.status = 'over';
    io.to(code).emit('game-over', { winnerTag, meta: room.meta });
    broadcastLobby(code);
    return;
  }

  startNextAuction(code);
}

function startNextAuction(code) {
  const room = rooms[code];
  room.auction = {
    yieldValue: pickRandomLandYield(),
    bids: {},
    bidStartedAt: Date.now()
  };
  room.pendingActions = {};
  broadcastAuction(code);
  scheduleBidTimeoutCheck(code);
}

function scheduleBidTimeoutCheck(code) {
  setTimeout(() => {
    const room = rooms[code];
    if (!room || !room.auction) return;
    tryResolveBids(code, true);
  }, BID_TIMEOUT_MS + 500);
}

function tryResolveBids(code, forceTimeout) {
  const room = rooms[code];
  if (!room || !room.auction) return;
  const auction = room.auction;
  const timedOut = forceTimeout || (Date.now() - auction.bidStartedAt) > BID_TIMEOUT_MS;
  if (Object.keys(auction.bids).length < room.players.length && !timedOut) return;

  const result = resolveLandAuction(room.meta, auction.yieldValue, auction.bids);
  room.auction = null;
  io.to(code).emit('land-auction-result', { msg: result.msg, meta: room.meta });

  // 다음 체인게임 라운드 시작
  room.state = createGameState(room.players.slice());
  room.pendingActions = {};
  broadcastState(code);
  scheduleTimeoutCheck(code);
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
      meta: {}, state: null, pendingActions: {}, auction: null
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

  socket.on('start-game', (_, cb) => {
    const code = socket.data.code, tag = socket.data.tag;
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: '방을 찾을 수 없습니다.' });
    if (room.hostTag !== tag) return cb && cb({ ok: false, error: '호스트만 시작할 수 있습니다.' });
    if (room.players.length < 3 || room.players.length > 6) return cb && cb({ ok: false, error: '3~6개 상단이 필요합니다.' });
    const meta = {};
    room.players.forEach(t => { meta[t] = freshMeta(); });
    room.meta = meta;
    room.state = createGameState(room.players.slice());
    room.status = 'playing';
    room.pendingActions = {};
    room.auction = null;
    cb && cb({ ok: true });
    broadcastLobby(code);
    broadcastState(code);
    scheduleTimeoutCheck(code);
  });

  // 영토 경매 입찰
  socket.on('submit-bid', ({ amount }) => {
    const code = socket.data.code, tag = socket.data.tag;
    const room = rooms[code];
    if (!room || !room.auction) return;
    const meta = room.meta[tag];
    if (!meta) return;
    amount = Number(amount) || 0;
    if (amount === 1) return; // 1코인은 유효하지 않음
    if (amount < 0 || amount > meta.coins) return;
    room.auction.bids[tag] = amount;
    io.to(code).emit('bid-submission-update', { bidTags: Object.keys(room.auction.bids) });
    tryResolveBids(code, false);
  });

  // 체인게임 카드 액션 제출
  socket.on('submit-action', ({ type, cardId }) => {
    const code = socket.data.code, tag = socket.data.tag;
    const room = rooms[code];
    if (!room || room.status !== 'playing' || !room.state) return;
    room.pendingActions[tag] = { type, cardId };
    io.to(code).emit('submission-update', { submittedTags: Object.keys(room.pendingActions) });
    tryResolveTurn(code, false);
  });

  socket.on('disconnect', () => {
    // 방은 유지 (재접속 여지를 위해 별도 제거 로직은 두지 않음)
  });
});

server.listen(PORT, () => {
  console.log(`메르칸티스 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});

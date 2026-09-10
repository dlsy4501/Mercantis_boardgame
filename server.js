const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const {
  createGameState, resolveTurn, defaultAction, freshMeta,
  computeStandings, awardCoins, awardLandIncome,
  pickRandomLandYield, resolveLandAuction, checkGoalReached, goalCoinsFor
} = require('./game-logic');

const PORT = process.env.PORT || 3000;
const TURN_TIMEOUT_MS = 15000;
const BID_TIMEOUT_MS = 15000;
const BOT_AUTO_BID = 2; // 봇이 경매에서 자동으로 제시하는 고정 입찰액
const AUCTION_RESULT_DISPLAY_MS = 4000; // 경매 결과를 보여주고 다음 라운드로 넘어가기까지 대기 시간
const ANIM_STEP_MS = 430; // 클라이언트가 턴 결과 이벤트 하나를 재생하는 데 걸리는 시간과 맞춤 (기존 650의 1.5배 속도)

// 클라이언트가 이전 턴 결과를 재생하는 동안은 실제로 카드를 낼 수 없으므로,
// 그 재생 시간만큼 타임아웃 기준 시각을 미뤄줘야 "고민 시간"이 15초 그대로 보장된다.
function animGraceMs(state) {
  return (state.events ? state.events.length : 0) * ANIM_STEP_MS;
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// rooms[code] = {
//   hostTag, players: [tag,...], bots: Set<tag>, status: 'waiting'|'playing'|'over',
//   meta: { tag: {coins, lands} },   // 게임 시작부터 끝까지 유지되는 코인/상관 정보
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
  return { hostTag: room.hostTag, players: room.players, bots: Array.from(room.bots), status: room.status };
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
    bidTags: Object.keys(room.auction.bids), bidStartedAt: room.auction.bidStartedAt
  });
}

// 봇은 사람의 제출을 기다리지 않도록, 턴이 시작되자마자 기본 행동(가장 약한 부채 전가 카드,
// 없으면 보험/면책)을 즉시 제출해둔다.
function autoSubmitBotActions(code) {
  const room = rooms[code];
  if (!room || !room.state) return;
  const state = room.state;
  state.seatOrder.forEach(t => {
    if (!room.bots.has(t)) return;
    const p = state.players[t];
    if (!p.alive || p.hand.length === 0) return;
    if (room.pendingActions[t] !== undefined) return;
    const action = defaultAction(p);
    room.pendingActions[t] = { type: action.type, cardId: action.card ? action.card.id : null };
  });
}

// 새 턴이 시작될 때 공통으로 호출: 봇 행동 채우기 → 브로드캐스트 → 타임아웃 예약 →
// (사람 없이 봇끼리만 남은 경우를 대비해) 즉시 해소 가능한지 재확인
function startTurn(code) {
  autoSubmitBotActions(code);
  broadcastState(code);
  scheduleTimeoutCheck(code);
  tryResolveTurn(code, false);
}

// 봇은 경매에서도 사람을 기다리지 않도록, 여유가 있으면 고정액을 자동으로 입찰해둔다.
function autoSubmitBotBids(code) {
  const room = rooms[code];
  if (!room || !room.auction) return;
  room.players.forEach(t => {
    if (!room.bots.has(t)) return;
    if (room.auction.bids[t] !== undefined) return;
    const coins = room.meta[t] ? room.meta[t].coins : 0;
    room.auction.bids[t] = coins >= BOT_AUTO_BID ? BOT_AUTO_BID : 0;
  });
}

/* ================= 체인게임 턴 진행 ================= */
function scheduleTimeoutCheck(code) {
  const room = rooms[code];
  if (!room || room.status !== 'playing' || !room.state) return;
  const turnAtSchedule = room.state.turn;
  const grace = animGraceMs(room.state);
  setTimeout(() => {
    const r = rooms[code];
    if (!r || !r.state || r.state.phase !== 'playing') return;
    if (r.state.turn !== turnAtSchedule) return;
    tryResolveTurn(code, true);
  }, TURN_TIMEOUT_MS + grace + 500);
}

function tryResolveTurn(code, forceTimeout) {
  const room = rooms[code];
  if (!room || !room.state || room.state.phase !== 'playing') return;
  const state = room.state;
  const aliveTags = state.seatOrder.filter(t => state.players[t].alive);
  const needed = aliveTags.filter(t => state.players[t].hand.length > 0);
  const submitted = needed.filter(t => room.pendingActions[t] !== undefined);
  const timedOut = forceTimeout || (Date.now() - state.turnStartedAt) > TURN_TIMEOUT_MS + animGraceMs(state);
  if (submitted.length < needed.length && !timedOut) return;

  resolveTurn(state, room.pendingActions);
  room.pendingActions = {};

  if (state.phase === 'over') {
    finishRound(code);
  } else {
    startTurn(code);
  }
}

/* ================= 라운드 종료 → 코인 지급 → 경매 or 게임 종료 ================= */
function finishRound(code) {
  const room = rooms[code];
  const finishedState = room.state;
  const standings = computeStandings(finishedState);
  const rankMsg = awardCoins(room.meta, standings);
  awardLandIncome(room.meta);

  io.to(code).emit('round-result', { msg: rankMsg, meta: room.meta, state: finishedState });

  // 라운드를 끝낸 마지막 턴의 결과(부채 전가/파산 등)를 클라이언트가 재생할 시간을 준 뒤
  // 다음 경매(또는 게임 종료)로 넘어간다.
  const delay = Math.min(8000, 1000 + animGraceMs(finishedState));
  setTimeout(() => {
    const r = rooms[code];
    if (!r || r.status !== 'playing') return;

    const goal = goalCoinsFor(r.players.length);
    const winnerTag = checkGoalReached(r.meta, goal);
    if (winnerTag) {
      r.status = 'over';
      io.to(code).emit('game-over', { winnerTag, meta: r.meta, goal });
      broadcastLobby(code);
      return;
    }

    startNextAuction(code);
  }, delay);
}

function startNextAuction(code) {
  const room = rooms[code];
  room.auction = {
    yieldValue: pickRandomLandYield(),
    bids: {},
    bidStartedAt: Date.now()
  };
  room.pendingActions = {};
  autoSubmitBotBids(code);
  broadcastAuction(code);
  scheduleBidTimeoutCheck(code);
  tryResolveBids(code, false);
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
  io.to(code).emit('land-auction-result', {
    msg: result.msg, meta: room.meta,
    bids: auction.bids, winner: result.winner, yieldValue: auction.yieldValue
  });

  // 경매 결과를 잠시 보여준 뒤 다음 체인게임 라운드 시작
  setTimeout(() => {
    const r = rooms[code];
    if (!r || r.status !== 'playing') return;
    r.state = createGameState(r.players.slice());
    r.pendingActions = {};
    startTurn(code);
  }, AUCTION_RESULT_DISPLAY_MS);
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
      hostTag: tag, players: [tag], bots: new Set(), status: 'waiting',
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

  // 호스트가 로비에서 봇 상단을 추가 (사람 3명이 모이지 않아도 봇으로 채워 시작 가능)
  socket.on('add-bot', (_, cb) => {
    const code = socket.data.code, tag = socket.data.tag;
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: '방을 찾을 수 없습니다.' });
    if (room.hostTag !== tag) return cb && cb({ ok: false, error: '호스트만 봇을 추가할 수 있습니다.' });
    if (room.status !== 'waiting') return cb && cb({ ok: false, error: '이미 시작된 방입니다.' });
    if (room.players.length >= 6) return cb && cb({ ok: false, error: '이 방은 가득 찼습니다 (최대 6개 상단).' });
    let n = 1;
    let botTag = `봇 ${n}`;
    while (room.players.includes(botTag)) { n++; botTag = `봇 ${n}`; }
    room.players.push(botTag);
    room.bots.add(botTag);
    cb && cb({ ok: true, tag: botTag });
    broadcastLobby(code);
  });

  // 호스트가 로비에서 추가했던 봇을 제거
  socket.on('remove-bot', ({ tag: botTag }, cb) => {
    const code = socket.data.code, tag = socket.data.tag;
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: '방을 찾을 수 없습니다.' });
    if (room.hostTag !== tag) return cb && cb({ ok: false, error: '호스트만 봇을 제거할 수 있습니다.' });
    if (room.status !== 'waiting') return cb && cb({ ok: false, error: '이미 시작된 방입니다.' });
    if (!room.bots.has(botTag)) return cb && cb({ ok: false, error: '해당 봇을 찾을 수 없습니다.' });
    room.players = room.players.filter(p => p !== botTag);
    room.bots.delete(botTag);
    cb && cb({ ok: true });
    broadcastLobby(code);
  });

  socket.on('start-game', (_, cb) => {
    const code = socket.data.code, tag = socket.data.tag;
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: '방을 찾을 수 없습니다.' });
    if (room.hostTag !== tag) return cb && cb({ ok: false, error: '호스트만 시작할 수 있습니다.' });
    if (room.players.length < 3 || room.players.length > 6) return cb && cb({ ok: false, error: '3~6개 상단이 필요합니다 (봇으로 채워도 됩니다).' });
    const meta = {};
    room.players.forEach(t => { meta[t] = freshMeta(); });
    room.meta = meta;
    room.state = createGameState(room.players.slice());
    room.status = 'playing';
    room.pendingActions = {};
    room.auction = null;
    cb && cb({ ok: true });
    broadcastLobby(code);
    startTurn(code);
  });

  // 상관 경매 입찰
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

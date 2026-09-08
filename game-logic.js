// 메르칸티스 - 핵심 게임 로직 (서버 전용, 순수 함수 위주)
const ELIM_SCORE = 24;
const COIN_TABLE = [3, 3, 2, 0, 0, 0];
const START_COINS = 3;
const GOAL_COINS = 20;
const LAND_YIELD_MIN = 1;
const LAND_YIELD_MAX = 3;

function buildDeck() {
  const d = [];
  let uid = 0;
  const attackCounts = { 1: 18, 2: 15, 3: 12, 4: 9, 5: 6 };
  for (const v in attackCounts) {
    for (let i = 0; i < attackCounts[v]; i++) d.push({ id: uid++, type: 'attack', value: Number(v) });
  }
  for (let i = 0; i < 18; i++) d.push({ id: uid++, type: 'defense' });
  for (let i = 0; i < 18; i++) d.push({ id: uid++, type: 'shield' });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function nextAliveTag(state, tag) {
  const order = state.seatOrder;
  let i = order.indexOf(tag);
  for (let s = 0; s < order.length; s++) {
    i = (i + 1) % order.length;
    if (state.players[order[i]].alive) return order[i];
  }
  return tag;
}
function prevAliveTag(state, tag) {
  const order = state.seatOrder;
  let i = order.indexOf(tag);
  for (let s = 0; s < order.length; s++) {
    i = (i - 1 + order.length) % order.length;
    if (state.players[order[i]].alive) return order[i];
  }
  return tag;
}

function freshMeta() {
  return { coins: START_COINS, lands: [] };
}

// 체인게임 한 라운드의 초기 상태를 만든다 (패시브/유물 없음)
function createGameState(seatOrder) {
  const n = seatOrder.length;
  const startHand = n <= 4 ? 7 : 5;
  const deck = buildDeck();
  const players = {};
  seatOrder.forEach(tag => {
    const hand = [];
    for (let k = 0; k < startHand; k++) { const c = deck.pop(); if (c) hand.push(c); }
    players[tag] = { score: 0, hand, shield: 0, alive: true };
  });
  return {
    seatOrder, players, deck, turn: 1, turnStartedAt: Date.now(),
    log: [`${n}개 상단의 전쟁 개시. 매 턴 전원이 병력 카드를 동시에 공개합니다.`],
    phase: 'playing', winnerTags: [],
    eliminationOrder: []
  };
}

function defaultAction(p) {
  const atk = p.hand.filter(c => c.type === 'attack').sort((a, b) => a.value - b.value)[0];
  if (atk) return { type: 'attack', card: atk };
  const def = p.hand.find(c => c.type === 'defense');
  if (def) return { type: 'defend', card: def };
  const sh = p.hand.find(c => c.type === 'shield');
  if (sh) return { type: 'shield', card: sh };
  return { type: 'none', card: null };
}

function doEliminate(state, targetTag, attackerTag, addLog) {
  const tp = state.players[targetTag];
  tp.alive = false;
  state.eliminationOrder.push(targetTag);
  const take = Math.ceil(tp.hand.length / 2);
  const taken = tp.hand.splice(0, take);
  if (attackerTag && attackerTag !== targetTag) state.players[attackerTag].hand.push(...taken);
  addLog(`💀 ${targetTag} 파산!${attackerTag && attackerTag !== targetTag ? ` ${attackerTag}이(가) 영지 ${taken.length}곳 병합` : ''}`);
}

// actions: { tag: {type, cardId} } - cardId를 실제 카드 객체로 해석해서 처리
function resolveTurn(state, rawActions) {
  const aliveTags = state.seatOrder.filter(t => state.players[t].alive);
  const actions = {};
  aliveTags.forEach(t => {
    const p = state.players[t];
    if (p.hand.length === 0) { actions[t] = { type: 'none', card: null }; return; }
    const raw = rawActions[t];
    const card = raw ? p.hand.find(c => c.id === raw.cardId) : null;
    actions[t] = card ? { type: raw.type, card } : defaultAction(p);
  });

  const order = state.seatOrder.filter(t => state.players[t].alive && actions[t]);
  const addLog = (m) => state.log.push(m);
  addLog(`── 턴 ${state.turn} 결과 ──`);

  order.forEach(t => { state.players[t].shield = 0; });

  // 1) 근위대 / 밀약
  for (const t of order) {
    const act = actions[t];
    if (act.type === 'shield') {
      const tt = prevAliveTag(state, t);
      state.players[tt].shield = 1;
      addLog(`🟢 ${t}: 근위대 배치 → ${tt}`);
    } else if (act.type === 'trade') {
      const p = state.players[t];
      const xt = prevAliveTag(state, prevAliveTag(state, t));
      state.players[xt].hand.push({ ...act.card, viaTrade: true });
      p.score = Math.max(0, p.score - 1);
      addLog(`🤝 ${t}: ${xt}에 밀약 — 침공 병력(${act.card.value}) 지원, 혼란도 1 진정 (현재 혼란도 ${p.score})`);
    }
  }

  // 2) 침공
  const eliminations = [];
  for (const t of order) {
    const act = actions[t];
    if (act.type !== 'attack') continue;
    const tt = nextAliveTag(state, t);
    const target = state.players[tt];
    let dmg = act.card.value, note = '';
    if (target.shield > 0) {
      target.shield -= 1; dmg = 0; note = ' → 근위대가 완전 방어!';
    } else {
      const tAct = actions[tt];
      if (tAct && tAct.type === 'defend') { dmg = Math.floor(dmg / 2); note = ` → 방벽으로 절반 감소 (${dmg})`; }
    }
    target.score += dmg;
    addLog(`🔴 ${t}: 침공(${act.card.value}) → ${tt}${note} (현재 혼란도 ${target.score})`);
    if (target.score >= ELIM_SCORE) eliminations.push({ attacker: t, target: tt });
  }

  // 3) 사용 카드 제거
  order.forEach(t => {
    const act = actions[t];
    if (act && act.card) state.players[t].hand = state.players[t].hand.filter(c => c.id !== act.card.id);
  });

  // 4) 로그
  order.forEach(t => {
    const act = actions[t];
    if (act.type === 'defend') addLog(`🛡 ${t}: 방벽 구축`);
    if (act.type === 'none') addLog(`⚠ ${t}: 국고 탕진 (낼 카드 없음)`);
  });

  // 5) 파산
  for (const { attacker, target } of eliminations) {
    if (!state.players[target].alive) continue;
    doEliminate(state, target, attacker, addLog);
  }

  // 6) 보충
  state.seatOrder.forEach(t => {
    if (!state.players[t].alive) return;
    const c = state.deck.pop();
    if (c) state.players[t].hand.push(c);
  });
  if (state.deck.length === 0) addLog('유물함이 모두 소진되었습니다.');

  // 7) 라운드 종료 판정
  const stillAlive = state.seatOrder.filter(t => state.players[t].alive);
  let over = false, winners = [];
  if (stillAlive.length <= 1) { over = true; winners = stillAlive; }
  else if (state.deck.length === 0 && stillAlive.every(t => state.players[t].hand.length === 0)) {
    const minScore = Math.min(...stillAlive.map(t => state.players[t].score));
    winners = stillAlive.filter(t => state.players[t].score === minScore);
    over = true;
  }
  if (over) {
    state.phase = 'over';
    state.winnerTags = winners;
    addLog(`🏆 ${winners.join(', ')} 이번 라운드 1위!`);
  } else {
    state.turn += 1;
    state.turnStartedAt = Date.now();
  }
  return state;
}

function computeStandings(state) {
  const survivors = state.seatOrder.filter(t => state.players[t].alive)
    .sort((a, b) => state.players[a].score - state.players[b].score);
  const eliminatedBestFirst = [...state.eliminationOrder].reverse();
  return [...survivors, ...eliminatedBestFirst];
}

// standings 순서대로 등수별 코인을 지급하고 결과 메시지를 반환한다
function awardCoins(meta, standings) {
  standings.forEach((tag, rank) => {
    const coin = COIN_TABLE[rank] ?? 0;
    meta[tag].coins += coin;
  });
  return `이번 라운드 결과: ${standings.map((t, i) => `${i + 1}위 ${t}(+${COIN_TABLE[i] ?? 0}코인)`).join(', ')}`;
}

// 보유한 영토 수익 합만큼 코인을 지급한다
function awardLandIncome(meta) {
  Object.keys(meta).forEach(tag => {
    const income = meta[tag].lands.reduce((a, b) => a + b, 0);
    meta[tag].coins += income;
  });
}

function pickRandomLandYield() {
  return LAND_YIELD_MIN + Math.floor(Math.random() * (LAND_YIELD_MAX - LAND_YIELD_MIN + 1));
}

// bids: { tag: amount } - 올페이 방식 비공개 입찰 처리
function resolveLandAuction(meta, yieldValue, bids) {
  let winner = null, highest = 0;
  Object.keys(meta).forEach(tag => {
    let b = Number(bids[tag]) || 0;
    if (b === 1) b = 0; // 1코인 단독 입찰은 무효
    if (b < 0) b = 0;
    if (b > meta[tag].coins) b = meta[tag].coins;
    if (b > 0) meta[tag].coins -= b;
    if (b > highest) { highest = b; winner = tag; }
  });
  if (!winner) return { msg: '이번 영토는 아무도 낙찰받지 못했습니다.', winner: null, yieldValue };
  meta[winner].lands.push(yieldValue);
  return { msg: `${winner}이(가) 영토(수익 ${yieldValue}코인/라운드)를 ${highest}코인에 낙찰!`, winner, yieldValue };
}

// 목표 코인에 도달한 상단 태그를 반환한다 (없으면 null, 동시 달성 시 코인이 가장 많은 쪽)
function checkGoalReached(meta, goal = GOAL_COINS) {
  const reached = Object.keys(meta).filter(tag => meta[tag].coins >= goal);
  if (reached.length === 0) return null;
  return reached.reduce((best, t) => (meta[t].coins > meta[best].coins ? t : best), reached[0]);
}

module.exports = {
  ELIM_SCORE, COIN_TABLE, START_COINS, GOAL_COINS, LAND_YIELD_MIN, LAND_YIELD_MAX,
  buildDeck, createGameState, resolveTurn, defaultAction, nextAliveTag, prevAliveTag,
  freshMeta, computeStandings, awardCoins, awardLandIncome, pickRandomLandYield,
  resolveLandAuction, checkGoalReached
};

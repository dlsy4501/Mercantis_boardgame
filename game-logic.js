// 체인 오브 스론 - 핵심 게임 로직 (서버 전용, 순수 함수 위주)
const ELIM_SCORE = 24;

const RUNES = [
  { id: 'venom', icon: '🐍', name: '독배의 인장', desc: '왼쪽 상단 침공 성공 시, 3턴 동안 매 턴 고정 피해 1 추가(무시 불가)' },
  { id: 'wall', icon: '🛡', name: '선조의 갑주', desc: '전쟁이 끝날 때까지 받는 모든 침공 피해 1 영구 감소' },
  { id: 'informant', icon: '👁', name: '밀정의 눈', desc: '오른쪽 상단(나를 침공하는 상단)의 병력 정보를 항상 열람' },
  { id: 'revenge', icon: '⚔', name: '피의 맹세', desc: '내 상단이 파산하면, 파산시킨 상단이 즉시 혼란도 5 추가로 받음' },
  { id: 'dealmaker', icon: '🤝', name: '이중 밀약', desc: '밀약 시 혼란도 회복량이 2회까지 2배(2점)로 증가' }
];
const EXIT_TOP2_TARGET = 3;
const EXIT_RUNE_TARGET = 3;
const COIN_TABLE = [3, 3, 2, 0, 0, 0];

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
  return { coins: 3, runes: [], top2Count: 0, passive: null };
}

// meta: { tag: {coins, runes, top2Count, passive} } - 있으면 패시브를 플레이어에 적용
function createGameState(seatOrder, meta) {
  const n = seatOrder.length;
  const startHand = n <= 4 ? 7 : 5;
  const deck = buildDeck();
  const players = {};
  seatOrder.forEach(tag => {
    const hand = [];
    for (let k = 0; k < startHand; k++) { const c = deck.pop(); if (c) hand.push(c); }
    const passive = meta && meta[tag] ? meta[tag].passive : null;
    players[tag] = {
      score: 0, hand, shield: 0, alive: true,
      hasWall: passive === 'wall',
      hasVenom: passive === 'venom',
      hasRevenge: passive === 'revenge',
      isInformant: passive === 'informant',
      dealFreeUses: passive === 'dealmaker' ? 2 : 0
    };
  });
  return {
    seatOrder, players, deck, turn: 1, turnStartedAt: Date.now(),
    log: [`${n}개 상단의 전쟁 개시. 매 턴 전원이 병력 카드를 동시에 공개합니다.`],
    phase: 'playing', winnerTags: [],
    eliminationOrder: [], poison: {}, poisonSource: {}
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

  if (tp.hasRevenge && attackerTag && attackerTag !== targetTag && state.players[attackerTag].alive) {
    const ap = state.players[attackerTag];
    ap.score += 5;
    addLog(`⚔ ${targetTag}의 피의 맹세 발동! ${attackerTag} 혼란도 +5 (현재 혼란도 ${ap.score})`);
    if (ap.score >= ELIM_SCORE) {
      ap.alive = false;
      state.eliminationOrder.push(attackerTag);
      addLog(`💀 ${attackerTag}도 피의 맹세 반동으로 연쇄 파산!`);
    }
  }
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
      let heal = 1, note = '';
      if (p.dealFreeUses > 0) { p.dealFreeUses -= 1; heal = 2; note = ' (이중 밀약으로 회복 2)'; }
      p.score = Math.max(0, p.score - heal);
      addLog(`🤝 ${t}: ${xt}에 밀약 — 침공 병력(${act.card.value}) 지원, 혼란도 ${heal} 진정${note} (현재 혼란도 ${p.score})`);
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
      if (target.hasWall && dmg > 0) { dmg = Math.max(0, dmg - 1); note += ` → 선조의 갑주로 1 추가 감소 (${dmg})`; }
    }
    target.score += dmg;
    addLog(`🔴 ${t}: 침공(${act.card.value}) → ${tt}${note} (현재 혼란도 ${target.score})`);
    if (state.players[t].hasVenom && dmg > 0) {
      state.poison[tt] = 3;
      state.poisonSource[tt] = t;
      addLog(`🐍 ${tt}에게 독배의 인장 효과 부착 (3턴)`);
    }
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

  // 6) 독배의 인장 지속 피해
  state.seatOrder.forEach(t => {
    if (!state.players[t].alive || !state.poison[t]) return;
    const p = state.players[t];
    p.score += 1;
    state.poison[t] -= 1;
    addLog(`🐍 ${t}: 독배의 인장 피해 1 (현재 혼란도 ${p.score})`);
    if (state.poison[t] <= 0) delete state.poison[t];
    if (p.score >= ELIM_SCORE && p.alive) {
      const srcTag = state.poisonSource[t];
      const src = (srcTag && state.players[srcTag] && state.players[srcTag].alive) ? srcTag : t;
      doEliminate(state, t, src, addLog);
    }
  });

  // 7) 보충
  state.seatOrder.forEach(t => {
    if (!state.players[t].alive) return;
    const c = state.deck.pop();
    if (c) state.players[t].hand.push(c);
  });
  if (state.deck.length === 0) addLog('유물함이 모두 소진되었습니다.');

  // 8) 종료 판정
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
    addLog(`🏆 ${winners.join(', ')} 교역계 제패!`);
  } else {
    state.turn += 1;
    state.turnStartedAt = Date.now();
  }
  return state;
}

// ===== 전초전(사전 미니게임) 전용 로직 =====

function computeStandings(state) {
  const survivors = state.seatOrder.filter(t => state.players[t].alive)
    .sort((a, b) => state.players[a].score - state.players[b].score);
  const eliminatedBestFirst = [...state.eliminationOrder].reverse();
  return [...survivors, ...eliminatedBestFirst];
}

function awardCoins(meta, standings) {
  standings.forEach((tag, rank) => {
    const coin = COIN_TABLE[rank] ?? 0;
    meta[tag].coins += coin;
    if (rank < 2) meta[tag].top2Count += 1;
  });
  return `이번 전초전 결과: ${standings.map((t, i) => `${i + 1}위 ${t}(+${COIN_TABLE[i] ?? 0}금화)`).join(', ')}`;
}

function pickRandomRune() {
  return RUNES[Math.floor(Math.random() * RUNES.length)];
}

function resolveAuction(meta, rune, bids) {
  let winner = null, highest = 0;
  Object.keys(meta).forEach(tag => {
    const b = bids[tag] || 0;
    if (b > 0) meta[tag].coins -= b;
    if (b > highest) { highest = b; winner = tag; }
  });
  if (!winner) return { msg: '이번 유물은 아무도 낙찰받지 못했습니다.', winner: null };
  meta[winner].runes.push(rune.id);
  let msg = `${winner}이(가) ${rune.icon} ${rune.name}을(를) ${highest}금화에 낙찰!`;
  const cnt = meta[winner].runes.filter(r => r === rune.id).length;
  let synergized = false;
  if (cnt >= 2 && !meta[winner].passive) {
    meta[winner].passive = rune.id;
    msg += ` 시너지 완성 — ${rune.name} 각성!`;
    synergized = true;
  }
  return { msg, winner, synergized };
}

function checkPregameExit(meta) {
  return Object.keys(meta).find(tag => meta[tag].top2Count >= EXIT_TOP2_TARGET || meta[tag].runes.length >= EXIT_RUNE_TARGET);
}

module.exports = {
  ELIM_SCORE, RUNES, EXIT_TOP2_TARGET, EXIT_RUNE_TARGET, COIN_TABLE,
  buildDeck, createGameState, resolveTurn, defaultAction, nextAliveTag, prevAliveTag,
  freshMeta, computeStandings, awardCoins, pickRandomRune, resolveAuction, checkPregameExit
};

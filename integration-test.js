const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const NAMES = ['발더 상단', '레이븐우드 상단', '블랙쏜 상단', '아이언게이트 상단'];

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
  });
}

function emitAsync(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function defaultActionFor(hand) {
  const atk = hand.filter(c => c.type === 'attack').sort((a, b) => a.value - b.value)[0];
  if (atk) return { type: 'attack', cardId: atk.id };
  const def = hand.find(c => c.type === 'defense');
  if (def) return { type: 'defend', cardId: def.id };
  const sh = hand.find(c => c.type === 'shield');
  if (sh) return { type: 'shield', cardId: sh.id };
  return null;
}

(async () => {
  console.log('=== 4개 클라이언트 연결 ===');
  const sockets = await Promise.all(NAMES.map(() => connect()));
  const states = {}; // tag -> 최신 state
  const lobbies = {};

  sockets.forEach((s, i) => {
    s.on('state-update', (state) => { states[NAMES[i]] = state; });
    s.on('lobby-update', (lobby) => { lobbies[NAMES[i]] = lobby; });
  });

  console.log('=== 방 생성 (호스트: 발더 상단) ===');
  const createRes = await emitAsync(sockets[0], 'create-room', { tag: NAMES[0] });
  console.log('create-room 결과:', createRes);
  const code = createRes.code;

  console.log('=== 나머지 3명 참가 ===');
  for (let i = 1; i < NAMES.length; i++) {
    const res = await emitAsync(sockets[i], 'join-room', { tag: NAMES[i], code });
    console.log(`  ${NAMES[i]} join 결과:`, res);
  }
  await new Promise(r => setTimeout(r, 300));
  console.log('로비 참가자 (호스트 시점):', lobbies[NAMES[0]]);

  console.log('=== 게임 시작 ===');
  const startRes = await emitAsync(sockets[0], 'start-game', {});
  console.log('start-game 결과:', startRes);
  await new Promise(r => setTimeout(r, 300));

  console.log('=== 각자 매 턴 기본 행동으로 자동 진행 ===');
  let lastTurn = 0;
  let rounds = 0;
  const maxRounds = 300;

  while (rounds < maxRounds) {
    // 모든 소켓의 최신 상태 중 하나를 기준으로 진행 상황 판단
    const anyState = states[NAMES[0]];
    if (!anyState) { await new Promise(r => setTimeout(r, 100)); continue; }
    if (anyState.phase === 'over') {
      console.log('=== 게임 종료 감지 ===');
      break;
    }
    // 각 플레이어가 자기 상태 기준으로 아직 제출 안 한 턴이면 제출
    for (let i = 0; i < NAMES.length; i++) {
      const tag = NAMES[i];
      const st = states[tag];
      if (!st || st.phase !== 'playing') continue;
      const p = st.players[tag];
      if (!p.alive) continue;
      if (p.hand.length === 0) continue; // 국고 탕진 - 제출 불필요
      const act = defaultActionFor(p.hand);
      if (act) {
        sockets[i].emit('submit-action', act);
      }
    }
    await new Promise(r => setTimeout(r, 150));
    rounds++;
  }

  const finalState = states[NAMES[0]];
  console.log('\n=== 최종 결과 ===');
  console.log('phase:', finalState.phase, '| turn:', finalState.turn, '| winners:', finalState.winnerTags);
  NAMES.forEach(t => {
    const p = finalState.players[t];
    console.log(`  ${t}: ${p.alive ? '생존' : '파산'} (혼란도 ${p.score}, 손패 ${p.hand.length}장)`);
  });
  console.log('\n최근 로그 5줄:');
  finalState.log.slice(-5).forEach(l => console.log('  ' + l.replace(/<[^>]+>/g, '')));

  // 모든 클라이언트가 동일한 최종 상태를 받았는지 확인 (동기화 검증)
  console.log('\n=== 클라이언트 간 상태 동기화 확인 ===');
  let allSynced = true;
  for (const tag of NAMES) {
    const s = states[tag];
    const same = s.turn === finalState.turn && s.phase === finalState.phase &&
                 JSON.stringify(s.winnerTags) === JSON.stringify(finalState.winnerTags);
    console.log(`  ${tag} 클라이언트 상태 일치?`, same);
    if (!same) allSynced = false;
  }
  console.log(allSynced ? '\n✅ 전원 동기화 정상' : '\n❌ 동기화 불일치 발견!');

  sockets.forEach(s => s.close());
  process.exit(allSynced && finalState.phase === 'over' ? 0 : 1);
})();

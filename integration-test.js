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
  console.log('=== 4개 클라이언트 연결 & 방 구성 ===');
  const sockets = await Promise.all(NAMES.map(() => connect()));
  const states = {};   // tag -> 최신 체인게임 라운드 상태
  const metas = {};    // tag -> 최신 코인/영토 메타
  const phases = {};   // tag -> 클라이언트가 인식하는 단계 ('game' | 'auction' | 'over')
  const auctions = {}; // tag -> 최신 경매 정보
  let gameOverInfo = null;

  sockets.forEach((s, i) => {
    const tag = NAMES[i];
    phases[tag] = 'lobby';
    s.on('state-update', ({ state, meta }) => { states[tag] = state; metas[tag] = meta; phases[tag] = 'game'; });
    s.on('land-auction', (data) => { auctions[tag] = data; metas[tag] = data.meta; phases[tag] = 'auction'; });
    s.on('land-auction-result', (data) => { metas[tag] = data.meta; });
    s.on('round-result', (data) => { metas[tag] = data.meta; });
    s.on('game-over', (data) => { metas[tag] = data.meta; phases[tag] = 'over'; if (tag === NAMES[0]) gameOverInfo = data; });
  });

  const createRes = await emitAsync(sockets[0], 'create-room', { tag: NAMES[0] });
  console.log('create-room 결과:', createRes);
  const code = createRes.code;

  console.log('=== 나머지 3명 참가 ===');
  for (let i = 1; i < NAMES.length; i++) {
    const res = await emitAsync(sockets[i], 'join-room', { tag: NAMES[i], code });
    console.log(`  ${NAMES[i]} join 결과:`, res);
  }
  await new Promise(r => setTimeout(r, 300));

  console.log('=== 게임 시작 (체인게임 + 영토 경제 단일 루프) ===');
  const startRes = await emitAsync(sockets[0], 'start-game', {});
  console.log('start-game 결과:', startRes);
  await new Promise(r => setTimeout(r, 300));

  let iterations = 0;
  const maxIterations = 5000;

  while (iterations < maxIterations) {
    iterations++;
    if (phases[NAMES[0]] === 'over') break;

    for (let i = 0; i < NAMES.length; i++) {
      const tag = NAMES[i];
      if (phases[tag] === 'game') {
        const st = states[tag];
        if (!st || st.phase !== 'playing') continue;
        const p = st.players[tag];
        if (!p.alive || p.hand.length === 0) continue;
        const act = defaultActionFor(p.hand);
        if (act) sockets[i].emit('submit-action', act);
      } else if (phases[tag] === 'auction') {
        const meta = metas[tag];
        const myCoins = meta && meta[tag] ? meta[tag].coins : 0;
        const bid = myCoins >= 2 ? 2 : 0;
        sockets[i].emit('submit-bid', { amount: bid });
      }
    }
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`\n=== 게임 종료 감지 (반복 ${iterations}회) ===`);
  if (!gameOverInfo) {
    console.log('❌ game-over 이벤트를 받지 못함 (maxIterations 초과)');
    sockets.forEach(s => s.close());
    process.exit(1);
  }

  console.log('승리 상단:', gameOverInfo.winnerTag);
  console.log('최종 메타:', JSON.stringify(gameOverInfo.meta, null, 2));

  const winnerCoins = gameOverInfo.meta[gameOverInfo.winnerTag].coins;
  const goalReached = winnerCoins >= 20;
  console.log(`목표 코인(20) 달성 확인: ${winnerCoins}코인 →`, goalReached ? '✅' : '❌');

  // 모든 클라이언트가 동일한 승자/메타로 game-over를 받았는지 확인 (동기화 검증)
  console.log('\n=== 클라이언트 간 상태 동기화 확인 ===');
  let allSynced = true;
  for (const tag of NAMES) {
    const same = phases[tag] === 'over' &&
      metas[tag] && metas[tag][gameOverInfo.winnerTag] &&
      metas[tag][gameOverInfo.winnerTag].coins === winnerCoins;
    console.log(`  ${tag} 클라이언트 상태 일치?`, same);
    if (!same) allSynced = false;
  }
  console.log(allSynced ? '\n✅ 전원 동기화 정상' : '\n❌ 동기화 불일치 발견!');

  sockets.forEach(s => s.close());
  process.exit(allSynced && goalReached ? 0 : 1);
})();

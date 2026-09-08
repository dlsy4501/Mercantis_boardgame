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
  console.log('=== 클라이언트 연결 & 방 구성 ===');
  const sockets = await Promise.all(NAMES.map(() => connect()));
  const miniStates = {};       // tag -> 전초전 미니게임 상태
  const mainStates = {};       // tag -> 본게임 상태
  const metas = {};            // tag -> 전초전 meta
  const phases = {};           // tag -> 클라이언트가 인식하는 단계
  const auctionInfo = {};      // tag -> 현재 경매 룬 정보
  const summaries = {};        // tag -> pregame-summary 수신 여부

  sockets.forEach((s, i) => {
    const tag = NAMES[i];
    phases[tag] = 'landing';
    s.on('pregame-auction', (data) => { auctionInfo[tag] = data; metas[tag] = data.meta; phases[tag] = 'auction'; });
    s.on('pregame-auction-result', (data) => { metas[tag] = data.meta; });
    s.on('pregame-round-result', (data) => { metas[tag] = data.meta; });
    s.on('pregame-state-update', (data) => { miniStates[tag] = data.state; metas[tag] = data.meta; phases[tag] = 'mini'; });
    s.on('pregame-summary', (data) => { metas[tag] = data.meta; summaries[tag] = true; phases[tag] = 'summary'; });
    s.on('state-update', (state) => { mainStates[tag] = state; phases[tag] = state.phase === 'over' ? 'over' : 'game'; });
  });

  const createRes = await emitAsync(sockets[0], 'create-room', { tag: NAMES[0] });
  const code = createRes.code;
  console.log('방 코드:', code);
  for (let i = 1; i < NAMES.length; i++) {
    await emitAsync(sockets[i], 'join-room', { tag: NAMES[i], code });
  }
  await new Promise(r => setTimeout(r, 300));

  console.log('=== 전초전(경매) 시작 ===');
  const pgRes = await emitAsync(sockets[0], 'start-pregame', {});
  console.log('start-pregame 결과:', pgRes);

  let iterations = 0;
  const maxIterations = 2000;
  let auctionRoundsSeen = 0;
  let miniRoundsResolved = 0;

  while (iterations < maxIterations) {
    iterations++;
    const anyPhase = phases[NAMES[0]];

    if (anyPhase === 'summary' || anyPhase === 'game' || anyPhase === 'over') break;

    if (anyPhase === 'auction') {
      // 아직 입찰 안 한 플레이어들이 입찰 (코인 있으면 2, 없으면 0)
      for (let i = 0; i < NAMES.length; i++) {
        const tag = NAMES[i];
        if (phases[tag] !== 'auction') continue;
        const meta = metas[tag];
        const myCoins = meta && meta[tag] ? meta[tag].coins : 0;
        const bid = myCoins >= 2 ? 2 : 0;
        sockets[i].emit('submit-bid', { amount: bid });
      }
      auctionRoundsSeen++;
    } else if (anyPhase === 'mini') {
      for (let i = 0; i < NAMES.length; i++) {
        const tag = NAMES[i];
        const st = miniStates[tag];
        if (!st || st.phase !== 'playing') continue;
        const p = st.players[tag];
        if (!p.alive || p.hand.length === 0) continue;
        const act = defaultActionFor(p.hand);
        if (act) sockets[i].emit('submit-action', act);
      }
    }
    await new Promise(r => setTimeout(r, 250));
  }

  console.log(`\n=== 전초전 종료 (반복 ${iterations}회) ===`);
  console.log('전원 summary 수신?', NAMES.every(t => summaries[t]));
  console.log('최종 메타(발더 상단 시점):', JSON.stringify(metas[NAMES[0]], null, 2));

  console.log('\n=== 이제 본게임(state-update) 진행 대기 ===');
  let mainIter = 0;
  while (mainIter < 500) {
    mainIter++;
    const st = mainStates[NAMES[0]];
    if (st && st.phase === 'over') break;
    if (st && st.phase === 'playing') {
      for (let i = 0; i < NAMES.length; i++) {
        const tag = NAMES[i];
        const s2 = mainStates[tag];
        if (!s2 || s2.phase !== 'playing') continue;
        const p = s2.players[tag];
        if (!p.alive || p.hand.length === 0) continue;
        const act = defaultActionFor(p.hand);
        if (act) sockets[i].emit('submit-action', act);
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }

  const finalMain = mainStates[NAMES[0]];
  console.log('\n=== 본게임 최종 결과 ===');
  if (!finalMain) {
    console.log('❌ 본게임 상태를 받지 못함');
    sockets.forEach(s => s.close());
    process.exit(1);
  }
  console.log('phase:', finalMain.phase, '| turn:', finalMain.turn, '| winners:', finalMain.winnerTags);
  NAMES.forEach(t => {
    const p = finalMain.players[t];
    console.log(`  ${t}: ${p.alive ? '생존' : '파산'} (혼란도 ${p.score}) | 철벽:${p.hasWall} 독니:${p.hasVenom} 정보원:${p.isInformant} 복수:${p.hasRevenge} 계약면제:${p.dealFreeUses}`);
  });

  // 모든 클라이언트가 동일한 최종 상태를 받았는지 확인
  let allSynced = true;
  for (const tag of NAMES) {
    const s = mainStates[tag];
    const same = s && s.turn === finalMain.turn && s.phase === finalMain.phase &&
                 JSON.stringify(s.winnerTags) === JSON.stringify(finalMain.winnerTags);
    if (!same) allSynced = false;
    console.log(`  ${tag} 클라이언트 상태 일치?`, same);
  }
  console.log(allSynced ? '\n✅ 전원 동기화 정상' : '\n❌ 동기화 불일치!');

  sockets.forEach(s => s.close());
  process.exit(allSynced && finalMain.phase === 'over' ? 0 : 1);
})();

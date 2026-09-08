# 메르칸티스(Mercantis) 서버 — 프로젝트 안내

이 문서는 Claude Code가 이 프로젝트 폴더를 열었을 때 참고할 안내서입니다. 게임 규칙의 최종 근거는 항상 `게임설명서.md`(v4, 영토 경제 통합판)이며, 아래는 그 규칙이 코드에 어떻게 반영되어 있는지를 설명합니다.

---

## 0. 프로젝트 구조

```
server.js                     Express + Socket.io 서버 본체 (방/로비/체인게임 라운드/영토 경매 진행 관리)
game-logic.js                 게임 규칙 순수 함수 모음 (덱, 체인게임 턴 처리, 등수 코인, 영토 경제)
public/index.html             브라우저 클라이언트 (단일 HTML, Socket.io로 서버와 통신)
integration-test.js           4인 자동 플레이 통합 테스트 — 게임 시작부터 목표 코인 20 달성까지 전체 루프 검증
README.md                     실행/배포 안내
게임설명서.md                  게임 규칙 원본 문서 (v4) — 모든 규칙 판단의 기준
```

이전 버전(유물/룬·패시브 5종, "전초전 → 본게임" 2단계 구조)은 `게임설명서.md` v4에서 완전히 제거되었고, 이 저장소의 코드도 그에 맞춰 단일 루프 구조로 이미 리팩터링되어 있습니다. `RUNES`, `EXIT_TOP2_TARGET`, `pregame-*` 이벤트, `hasWall`/`hasVenom`/`hasRevenge`/`isInformant`/`dealFreeUses` 같은 이름이 코드에 남아 있다면 그것은 회귀(regression)이니 제거해야 합니다.

---

## 1. 전체 루프 (server.js가 구현)

```
게임 시작 (start-game)
   ↓
체인게임 한 라운드 진행 (state-update 반복 브로드캐스트)
   ↓
라운드 종료 → 등수별 코인 지급 + 영토 소득 지급 (round-result)
   ↓
목표 코인(20) 도달자 있음? ──예──▶ game-over, 종료
   │ 아니오
   ↓
영토 경매 1회 (land-auction → land-auction-result)
   ↓
(맨 위 "체인게임 한 라운드 진행"으로 반복)
```

- `room.state` : 현재 진행 중인 체인게임 라운드 상태 (매 라운드 `createGameState`로 새로 생성)
- `room.meta`  : 게임 시작부터 끝까지 유지되는 상단별 `{ coins, lands }` (코인·보유 영토)
- `room.auction` : 영토 경매 진행 중일 때만 존재하는 `{ yieldValue, bids, bidStartedAt }`
- `room.bots` : 봇으로 채운 상단 태그 집합(`Set`). 로비 상태(`waiting`)일 때만 호스트가 `add-bot`/`remove-bot`으로 조정 가능. `room.players`에는 사람과 봇 태그가 함께 들어가므로, 시작 조건(3~6개 상단)은 사람 수와 무관하게 총원 기준으로 그대로 적용됨.
- 봇 자동 처리: `startTurn(code)`가 매 턴 시작 시 `autoSubmitBotActions`로 살아있는 봇의 카드 액션을(`defaultAction` 재사용 — 가장 약한 침공, 없으면 방벽/근위대) 즉시 `room.pendingActions`에 채워 넣고, `startNextAuction(code)`가 `autoSubmitBotBids`로 봇의 입찰(여유 있으면 고정 `BOT_AUTO_BID`코인, 아니면 0=포기)을 즉시 채워 넣는다. 그 덕에 `tryResolveTurn`/`tryResolveBids`는 사람 플레이어의 제출만 실제로 기다리면 된다 — 봇을 위한 별도 대기/타임아웃 로직은 없음.

## 2. 체인게임 규칙 (`game-logic.js`)

- 좌석/방향: 왼쪽=내가 침공하는 대상, 오른쪽=나를 침공하는 상단, 전전 상단=밀약 대상. `nextAliveTag`/`prevAliveTag`로 계산.
- 시작 손패: 3~4개 상단 7장, 5~6개 상단 5장.
- 덱 96장: 침공/밀약(1~5, 18/15/12/9/6) 60장, 방벽(`type: 'defense'`) 18장, 근위대(`type: 'shield'`) 18장.
- **근위대는 자기방어(셀프실드) 카드다.** 오른쪽 상단에게 부여하던 이전 설계에서 변경됨 — `resolveTurn`에서 `shield` 액션은 `state.players[t].shield = 1`로 **자기 자신**에게 적용되고, 침공 판정에서 `target.shield > 0`(공격받는 쪽의 실드)을 그대로 검사하므로 별도 대상 계산이 필요 없다. 이번 턴에만 유효, 다음 턴으로 이월 안 됨.
- 매 턴 카드가 있으면 반드시 제출(패스 불가), 전원 동시 처리. 처리 순서: 근위대(자기방어)/밀약 → 침공(근위대 완전 방어 → 방벽 절반 감소) → 사용 카드 제거 → 파산 확정 → 카드 보충.
- `resolveTurn`은 사람이 읽는 `state.log` 문자열과 별도로, 클라이언트 애니메이션용 구조화 이벤트를 `state.events`(해당 턴에서만 유효, 매 턴 초기화)에 담아 반환한다: `{type:'guard',tag}`(자기방어) / `{type:'trade',from,to,value}` / `{type:'attack',from,to,cardValue,damage,blockedBy}`(`blockedBy`: `'guard'`|`'defend'`|`null`) / `{type:'defend',tag}` / `{type:'none',tag}` / `{type:'eliminate',target,attacker,taken}` / `{type:'draw',tag}`. 순서는 로그와 동일(근위대/밀약 → 침공 → 방벽/탕진 → 파산 → 보충). 새 이벤트 종류를 추가할 때는 로그 텍스트와 이벤트 둘 다 갱신할 것.
- 밀약: 혼란도 항상 고정 1 회복 (배율 없음).
- 파산: 혼란도 24 이상, 파산시킨 쪽이 남은 손패 절반(올림) 병합.
- 라운드 종료: 1개 상단만 생존, 또는 덱+전원 손패 모두 소진(이때는 혼란도 최소자가 1위). `computeStandings`가 최종 등수를 계산.
- 패시브/유물/독 관련 로직은 전혀 없음 — 추가하지 말 것.

## 3. 영토 경제 (`game-logic.js` + `server.js`)

- 시작 코인 3 (`START_COINS`), 목표 코인 20 (`GOAL_COINS`).
- 등수 코인: `COIN_TABLE = [3, 3, 2, 0, 0, 0]` (1·2등 3코인, 3등 2코인, 4~6등 0코인) — `awardCoins`.
- 영토 소득: 보유 영토 수익(낙찰 시 1~3 무작위 고정)의 합을 매 라운드 지급 — `awardLandIncome`.
- 영토 경매: `pickRandomLandYield()`로 수익 공개 → 전원 비공개 동시 입찰(1코인 무효, 0=포기, 올페이) → `resolveLandAuction`이 최고 입찰자에게 영토 지급, 모든 입찰액은 성공 여부와 무관하게 차감.
- 승리 판정: `checkGoalReached(meta)`가 등수 코인+영토 소득 지급 직후, 다음 경매가 열리기 전에 코인 20 이상 상단을 찾음 (동시 달성 시 코인이 더 많은 쪽).

## 4. 소켓 이벤트 (server.js ↔ public/index.html)

| 이벤트 | 방향 | 용도 |
|---|---|---|
| `create-room` / `join-room` | client→server | 방 생성/참가 |
| `lobby-update` | server→client | 로비 인원/상태 갱신 (`bots` 배열 포함) |
| `add-bot` / `remove-bot` | client→server | 호스트가 로비에서 봇 상단 추가/제거 (사람 3명이 없어도 봇으로 채워 시작 가능) |
| `start-game` | client→server | 호스트가 게임 시작 (전초전 없이 바로 단일 루프 진입) |
| `state-update` | server→client | 체인게임 라운드 상태(`state`) + 코인/영토 메타(`meta`) 갱신 |
| `submit-action` / `submission-update` | 양방향 | 카드 제출 및 제출 현황 알림 |
| `round-result` | server→client | 라운드 종료 시 등수별 코인 + 영토 소득 지급 결과 메시지 |
| `land-auction` / `submit-bid` / `bid-submission-update` | 양방향 | 영토 경매 진행 |
| `land-auction-result` | server→client | 낙찰 결과: `bids`(상단별 입찰액 전체 공개), `winner`, `yieldValue` 포함. 클라이언트는 이걸로 전용 결과 화면(`auction-result`)을 띄운다 |
| `game-over` | server→client | 목표 코인 20 달성 상단(`winnerTag`)과 최종 `meta` |

- 경매가 끝나면 즉시 다음 라운드로 넘어가지 않고, `AUCTION_RESULT_DISPLAY_MS`(기본 4000ms) 동안 결과 화면을 보여준 뒤 서버가 다음 체인게임 라운드를 시작한다 (`tryResolveBids` 내부 `setTimeout`).

턴 제한 25초(`TURN_TIMEOUT_MS`), 입찰 제한 20초(`BID_TIMEOUT_MS`) — 시간 초과 시 서버가 기본 행동(가장 약한 침공 카드, 없으면 방벽/근위대 · 입찰 0)으로 자동 처리.

## 5. 수정 시 유의점

- 규칙 관련 상수(`GOAL_COINS`, `COIN_TABLE`, `START_COINS`, `LAND_YIELD_MIN`/`MAX`, `ELIM_SCORE`)는 모두 `game-logic.js` 상단에 있음. 수치 조정은 여기서.
- `game-logic.js`는 순수 함수 위주로 유지 — 소켓/타이머 등 서버 상태는 `server.js`에만.
- 클라이언트(`public/index.html`)의 `📜 게임 규칙 보기` 모달은 `게임설명서.md`와 항상 일치시킬 것 — 규칙을 바꾸면 이 모달 텍스트도 같이 수정.
- 로직을 수정한 뒤에는 `node server.js &` 로 서버를 띄우고 `node integration-test.js`로 전체 루프(방 생성→게임 시작→라운드+경매 반복→목표 코인 달성)가 끝까지 동기화되는지 재검증할 것.

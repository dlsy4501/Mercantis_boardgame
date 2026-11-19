const L=require('./game-logic.js'); const assert=require('assert');
function mk(n=3){const tags=['A','B','C'].slice(0,n);const players={};
 tags.forEach(t=>players[t]={alive:true,score:0,shield:0,hand:[]});
 return {seatOrder:tags,players,deck:[{id:900,type:'attack',value:1}],log:[],turn:1,eliminationOrder:[],phase:'playing'};}
const give=(s,t,id,type,value)=>s.players[t].hand.push({id,type,value});
let s=mk(); give(s,'A',1,'attack',3);give(s,'B',2,'defense',0);give(s,'C',3,'attack',1);
L.resolveTurn(s,{A:{type:'attack',cardId:1,leverage:true},B:{type:'defend',cardId:2},C:{type:'attack',cardId:3}});
assert.strictEqual(s.players.B.score,2,'보험: 5→2');
s=mk(); give(s,'A',1,'attack',3);give(s,'B',2,'attack',1);give(s,'C',3,'attack',1);
L.resolveTurn(s,{A:{type:'attack',cardId:1,leverage:true},B:{type:'attack',cardId:2,leverage:true},C:{type:'attack',cardId:3}});
assert.strictEqual(s.players.B.score,7); assert.strictEqual(s.players.C.score,3);
// 면책은 자기방어: B가 면책이면 A의 레버리지 공격 무효, B 자신은 레버리지 아님
s=mk(); give(s,'A',1,'attack',3);give(s,'B',2,'shield',0);give(s,'C',3,'attack',1);
L.resolveTurn(s,{A:{type:'attack',cardId:1,leverage:true},B:{type:'shield',cardId:2},C:{type:'attack',cardId:3}});
assert.strictEqual(s.players.B.score,0,'면책 무효'); assert.strictEqual(s.players.A.score,3,'면책에 막혀도 A 노출 +2 유지: 1+2');
console.log('A after C hit:',s.players.A.score);
// 밀약에 붙은 레버리지 무시
s=mk(); give(s,'A',1,'attack',3);give(s,'B',2,'attack',1);give(s,'C',3,'attack',1);
L.resolveTurn(s,{A:{type:'trade',cardId:1,leverage:true},B:{type:'attack',cardId:2},C:{type:'attack',cardId:3}});
assert.strictEqual(s.players.A.score,1);
console.log('OK');

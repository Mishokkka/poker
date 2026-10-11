import assert from "node:assert/strict";
import { PokerTableEngine, createTableState } from "../scripts/engine/table-engine.js";
import { shuffleDeck, createDeck } from "../scripts/engine/cards.js";
function engine(stacks) {
  const e = new PokerTableEngine(createTableState({ id: "regression", maxSeats: stacks.length, minBuyIn: 2, maxBuyIn: 1000 }));
  stacks.forEach((stack, index) => e.addSeat(index, { userId: `u${index}`, actorId: `a${index}`, actorName: `A${index}`, stack }));
  e.startHand(); return e;
}
const sum = e => e.state.seats.reduce((n, s) => n + s.stack, 0);
const through = (e, street) => { let n = 0; while (e.isActiveHand && e.state.status !== street) {
  assert.ok(++n < 100); const i = e.state.currentSeat; e.act(i, e.legalActions(i).canCheck ? "check" : "call");
} };
{
  const e = engine([100,100,10,10]);
  e.act(3,"allIn"); e.act(0,"raise",20); e.act(1,"call"); e.act(2,"call"); through(e,"river"); e.act(1,"fold");
  assert.equal(e.state.status,"complete"); assert.equal(sum(e),220);
  assert.throws(() => e.act(0,"fold"), /NotYourTurn/);
  e.forceReset(); assert.equal(sum(e),220); assert.equal(e.potTotal,0);
  assert.equal(e.state.handHistory[0].potTotal,60);
}
{
  const e = engine([100,100]); e.act(e.state.currentSeat,"fold"); e.forceReset(); e.forceReset();
  assert.equal(sum(e),200); assert.equal(e.state.lastResult.potTotal,3);
  assert.equal(e.state.handHistory[0].chipValueCopper,1);
}
{
  const e = engine([15,20,100,100]); e.act(3,"raise",10); e.act(0,"allIn"); e.act(1,"allIn"); e.act(2,"fold");
  assert.equal(e.legalActions(3).canRaise,true); assert.equal(e.legalActions(3).fullRaiseTarget,28); e.act(3,"raise",28);
}
{
  const e = engine([15,100,100,100]); e.act(3,"raise",10); e.act(0,"allIn"); e.act(1,"call"); e.act(2,"call");
  assert.equal(e.legalActions(3).canRaise,false); assert.equal(e.legalActions(3).canAllIn,false);
}
{
  const e = engine([100,100,1]); assert.equal(e.legalActions(0).callAmount,2); assert.equal(e.legalActions(0).fullRaiseTarget,4);
  const dry = engine([100,1]); assert.equal(dry.state.status,"complete"); assert.equal(sum(dry),101);
}
{
  const e = engine([100,3,100]); through(e,"flop"); e.act(1,"allIn");
  assert.equal(e.legalActions(2).fullRaiseTarget,3); assert.throws(() => e.act(2,"raise",2), /BelowMinimumRaise/); e.act(2,"raise",3);
  assert.equal(e.state.lastFullRaise,2);
}
// A rejected random sample must not bias the first slot. All cards remain unique.
let calls = 0;
const deck = shuffleDeck(createDeck(), { getRandomValues(a) { a[0] = calls++ === 0 ? 0xffffffff : 0; } });
assert.equal(calls,52); assert.equal(new Set(deck).size,52);
let seed = 812;
const random = () => ((seed = (Math.imul(seed,1664525)+1013904223)>>>0) / 2**32);
for (let hand=0; hand<1000; hand++) {
  const stacks=Array.from({length:2+Math.floor(random()*9)},()=>1+Math.floor(random()*200));
  const e=engine(stacks); const total=stacks.reduce((a,b)=>a+b,0); let guard=0;
  while(e.isActiveHand) {
    assert.ok(++guard<400); assert.equal(sum(e)+e.potTotal,total);
    const i=e.state.currentSeat, l=e.legalActions(i), r=random();
    if(r<.15) e.act(i,"fold");
    else if(r<.35 && (l.canRaise||l.canBet)) e.act(i,l.canBet?"bet":"raise",l.minTarget+Math.floor(random()*(l.maxTarget-l.minTarget+1)));
    else e.act(i,l.canCheck?"check":"call");
  }
  assert.equal(sum(e),total);
}
console.log("Review engine regressions and 1000 conservation hands passed.");

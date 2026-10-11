import assert from "node:assert/strict";
import { PokerTableEngine, createTableState } from "../scripts/engine/table-engine.js";
import { TablePresentation } from "../scripts/apps/table-presentation.js";
import { dealDuration, presentationDelay } from "../scripts/presentation-timing.js";

function fixture(count = 2, options = {}) {
  const engine = new PokerTableEngine(createTableState({ id: "t", maxSeats: count, smallBlind: 1, bigBlind: 2, minBuyIn: 2, maxBuyIn: 200, ...options }));
  for (let i = 0; i < count; i++) engine.addSeat(i, { actorId: `a${i}`, actorName: `Player ${i}`, userId: "u", stack: 100 });
  const presentation = new TablePresentation();
  let now = 100000;
  const update = (elapsed = 0, options = {}) => { now += elapsed; return presentation.update(engine.publicState(), { now, ownTurn: true, ...options }); };
  update();
  return { engine, presentation, update, get now() { return now; } };
}

for (const count of [2, 6, 10]) {
  const f = fixture(count);
  const before = f.engine.publicState();
  f.engine.startHand();
  const update = f.update();
  const end = dealDuration(count * 2);
  assert.equal(presentationDelay(before, f.engine.publicState()), end);
  assert.equal(update.sounds.find(s => s.id === "turn").at, f.now + end);
  assert.equal(update.sounds.filter(s => s.id === "holeDeal").length, count * 2);
  assert(update.sounds.some(s => s.id === "chips"), "Blinds must be audible even though handStart is the last log entry");
  const first = (f.engine.state.dealerIndex + 1) % count;
  f.update(300);
  assert.equal(f.presentation.effect(`hole:${first}:0`, f.now).delay, -300, "An in-flight card resumes at its elapsed progress");
  const repeated = f.update(300);
  assert.equal(f.presentation.effect(`hole:${first}:0`, f.now), null, "A landed card must never replay");
  assert.deepEqual(repeated.sounds, [], "An unrelated render must not duplicate audio");
  f.update(end);
  assert.equal(f.presentation.effect("deck", f.now), null);
}

{
  const f = fixture(); f.engine.startHand(); f.update(); f.update(2000);
  f.engine.act(f.engine.state.currentSeat, "call"); f.update();
  const before = f.engine.publicState();
  f.engine.act(f.engine.state.currentSeat, "check");
  const flop = f.update();
  assert.equal(presentationDelay(before, f.engine.publicState()), 720);
  assert(flop.sounds.some(s => s.id === "check"), "The street log must not hide the closing action");
  assert.deepEqual(flop.sounds.filter(s => s.id === "communityDeal").map(s => s.at - f.now), [0, 100, 200]);
  assert.equal(flop.sounds.find(s => s.id === "turn").at, f.now + 720);
  f.update(100);
  assert.equal(f.presentation.effect("board:0", f.now).delay, -100, "Flop animations survive replacement of the template");
  // An early next action advances the turn but must not notify while the board is in flight.
  f.engine.act(f.engine.state.currentSeat, "check");
  const next = f.update();
  assert(next.cancelTurn);
  assert.equal(next.sounds.find(s => s.id === "turn").at, f.now + 620);
}

for (const mode of ["pause", "reset", "recovery", "delivery"]) {
  const f = fixture(6); f.engine.startHand(); f.update();
  if (mode === "pause") f.engine.setPaused(true);
  if (mode === "reset") f.engine.forceReset();
  if (mode === "recovery") f.engine.state.recoveryRequired = true;
  if (mode === "delivery") f.engine.state.deliveryPending = true;
  const update = f.update(100);
  assert.equal(f.presentation.effects.size, 0, `${mode} must finish all visual effects`);
  assert(update.cancelSounds && update.cancelTurn);
  assert.deepEqual(update.sounds, []);
  if (mode === "pause") {
    f.engine.setPaused(false); f.update(100);
    assert.equal(f.presentation.effects.size, 0, "Resume must not redeal cards");
  }
  if (mode === "delivery") {
    f.engine.state.deliveryPending = false;
    assert.equal(f.update().sounds.filter(s => s.id === "holeDeal").length, 12, "A successful delivery retry starts one deal");
  }
}

{
  const f = fixture(); f.engine.startHand(); f.update();
  f.engine.act(f.engine.state.currentSeat, "allIn"); f.update(100);
  f.engine.act(f.engine.state.currentSeat, "call");
  const runout = f.update(100);
  assert.equal(f.engine.state.status, "complete");
  assert(runout.resultPending);
  assert.equal(runout.sounds.find(s => s.id === "win").at, f.now + 920);
  assert(![...f.presentation.effects.keys()].some(key => key.startsWith("hole:")), "Early showdown must not redeal exposed hole cards");
  assert(f.update(919).resultPending);
  assert.equal(f.update(1).resultPending, false);
  assert.equal(f.presentation.effect("deck", f.now), null);
}

{
  const f = fixture(); f.engine.startHand(); f.update(); f.engine.act(f.engine.state.currentSeat, "fold");
  const finish = f.update(100);
  assert(finish.sounds.some(s => s.id === "fold"), "The result log must not hide a winning fold");
  assert.equal(finish.resultPending, false);
}

{
  const f = fixture(); f.engine.startHand(); f.update(); f.update(2000);
  f.engine.act(f.engine.state.currentSeat, "call"); f.update();
  f.engine.act(f.engine.state.currentSeat, "check"); f.update();
  const flopEnds = f.now + 720;
  while (f.engine.state.status !== "complete") {
    f.engine.act(f.engine.state.currentSeat, "check");
    const update = f.update(10);
    if (f.engine.state.status === "complete") {
      assert(update.resultPending);
      assert.equal(update.sounds.find(s => s.id === "win").at, flopEnds, "Fast later streets must not truncate a still-flying flop");
      assert(update.sounds.some(s => s.id === "communityDeal"), "Remaining board sounds survive completion");
    }
  }
}

{
  const f = fixture(); f.engine.startHand(); f.update(0, { reducedMotion: true });
  assert.equal(f.presentation.effects.size, 0);
  f.engine.act(f.engine.state.currentSeat, "allIn"); f.update(0, { reducedMotion: true });
  f.engine.act(f.engine.state.currentSeat, "call");
  const result = f.update(0, { reducedMotion: true });
  assert.equal(result.resultPending, false, "Reduced motion must not introduce an invisible result delay");
  assert.equal(result.sounds.find(s => s.id === "win").at, f.now);
}

{
  const f = fixture(); f.engine.startHand();
  const opening = new TablePresentation();
  const result = opening.update(f.engine.publicState(), { ownTurn: true });
  assert.deepEqual(result.sounds, []);
  assert.equal(opening.effects.size, 0, "Opening a table mid-hand must not replay historical effects");
}
console.log("Presentation timelines, complete log audio, cancellation, runout and reduced motion passed.");

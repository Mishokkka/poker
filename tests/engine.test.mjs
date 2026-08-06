import assert from "node:assert/strict";
import { evaluateSeven, compareEvaluations } from "../scripts/engine/evaluator.js";
import { buildSidePots } from "../scripts/engine/pots.js";
import { createTableState, migrateTableState, normalizeTableConfiguration, PokerTableEngine } from "../scripts/engine/table-engine.js";
import { cardDisplay } from "../scripts/engine/cards.js";
import { SCHEMA_VERSION } from "../scripts/constants.js";

if (!globalThis.crypto) globalThis.crypto = (await import("node:crypto")).webcrypto;

const royal = evaluateSeven(["As", "Ks", "Qs", "Js", "Ts", "2d", "3c"]);
const quads = evaluateSeven(["Ah", "Ad", "Ac", "As", "Kd", "2c", "3h"]);
assert.equal(royal.categoryName, "straightFlush");
assert.equal(quads.categoryName, "fourKind");
assert.equal(compareEvaluations(royal, quads), 1);
assert.equal(cardDisplay("Ts").rank, "10");
assert.deepEqual(cardDisplay("Tx"), { rank: "10", suit: "x", symbol: "?", red: false });

const nullableConfig = normalizeTableConfiguration({ name: "Nullable", autoNextHand: null }, { ...createTableState({ name: "Base" }), autoNextHand: true });
assert.equal(nullableConfig.autoNextHand, true, "Null checkbox values must preserve the configured fallback.");
assert.throws(() => normalizeTableConfiguration({ name: "Fractional", maxSeats: "4.5" }), /SeatCountRange/);
assert.throws(() => normalizeTableConfiguration({ name: "Malformed", bigBlind: "10chips" }), /BlindOrder/);
assert.throws(() => normalizeTableConfiguration({ name: "Blank", maxSeats: "   " }), /SeatCountRange/, "Blank numeric configuration values must not become zero.");
const nullIntegerConfig = normalizeTableConfiguration({ name: "Null integers", maxSeats: null, autoNextHandSeconds: null });
assert.equal(nullIntegerConfig.maxSeats, 9, "Null integer configuration values must preserve defaults.");
assert.equal(nullIntegerConfig.autoNextHandSeconds, 6);

const legacy = migrateTableState({
  id: "legacy",
  name: "Legacy",
  maxSeats: 2,
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  minBuyIn: 20,
  maxBuyIn: 100,
  actionSeconds: 45,
  chipValueCopper: 1,
  seats: [null, null]
}, 1);
assert.equal(legacy.schemaVersion, SCHEMA_VERSION);
assert.equal(legacy.autoNextHand, false);
assert.deepEqual(legacy.handHistory, []);
assert.throws(() => migrateTableState({ ...legacy, schemaVersion: SCHEMA_VERSION + 1 }), /UnsupportedSchema/);
const fractionalStoredState = createTableState({ id: "fractional-state", name: "Fractional Stored", maxSeats: 2 });
fractionalStoredState.seats[0] = { userId: "u", actorId: "a", actorName: "A", stack: 10.5 };
assert.throws(() => new PokerTableEngine(fractionalStoredState), /InvalidTableState/);

for (const invalidStack of [null, "", "   ", true, false, []]) {
  const corrupt = createTableState({ id: `corrupt-${String(invalidStack)}`, name: "Corrupt Stored", maxSeats: 2 });
  corrupt.seats[0] = { userId: "u", actorId: "a", actorName: "A", stack: invalidStack };
  assert.throws(() => new PokerTableEngine(corrupt), /InvalidTableState/, `Stored stack ${JSON.stringify(invalidStack)} must not be coerced.`);
}
const invalidDeadlines = createTableState({ id: "invalid-deadlines", name: "Invalid Deadlines", maxSeats: 2 });
invalidDeadlines.turnDeadline = false;
invalidDeadlines.turnTimeRemaining = [];
invalidDeadlines.nextHandDeadline = "   ";
const normalizedDeadlines = new PokerTableEngine(invalidDeadlines).publicState();
assert.equal(normalizedDeadlines.turnDeadline, null);
assert.equal(normalizedDeadlines.turnTimeRemaining, null);
assert.equal(normalizedDeadlines.nextHandDeadline, null);


const pots = buildSidePots([
  { index: 0, handCommitted: 100, folded: false },
  { index: 1, handCommitted: 50, folded: false },
  { index: 2, handCommitted: 20, folded: true }
]);
assert.deepEqual(pots.map((pot) => pot.amount), [60, 60, 50]);
assert.deepEqual(pots[0].eligible, [0, 1]);

const state = createTableState({ id: "test", name: "Test", maxSeats: 3, smallBlind: 1, bigBlind: 2 });
const engine = new PokerTableEngine(state);
engine.addSeat(0, { userId: "u0", actorId: "a0", actorName: "A", stack: 100 });
engine.addSeat(1, { userId: "u1", actorId: "a1", actorName: "B", stack: 100 });
engine.addSeat(2, { userId: "u2", actorId: "a2", actorName: "C", stack: 100 });
engine.startHand();
assert.equal(engine.publicState().status, "preflop");
assert.equal(engine.privateHands().length, 3);

let guard = 0;
while (["preflop", "flop", "turn", "river"].includes(engine.publicState().status) && guard < 30) {
  const current = engine.publicState().currentSeat;
  const legal = engine.legalActions(current);
  if (legal.canCheck) engine.act(current, "check");
  else engine.act(current, "call");
  guard += 1;
}
assert.equal(engine.publicState().status, "complete");
assert.equal(engine.publicState().seats.reduce((sum, seat) => sum + seat.stack, 0), 300);

console.log("All engine tests passed.");

// Antes belong to the hand pot, not to the current street bet.
const anteState = createTableState({ id: "ante", name: "Ante", maxSeats: 3, smallBlind: 1, bigBlind: 2, ante: 1 });
const anteEngine = new PokerTableEngine(anteState);
for (let index = 0; index < 3; index += 1) {
  anteEngine.addSeat(index, { userId: `u${index}`, actorId: `aa${index}`, actorName: `P${index}`, stack: 20 });
}
anteEngine.startHand();
const antePublic = anteEngine.publicState();
assert.equal(antePublic.potTotal, 6);
assert.equal(antePublic.seats[antePublic.smallBlindIndex].streetBet, 1);
assert.equal(antePublic.seats[antePublic.bigBlindIndex].streetBet, 2);

// In heads-up play the dealer posts the small blind and acts first pre-flop.
const headsUpState = createTableState({ id: "hu", name: "HU", maxSeats: 2, smallBlind: 1, bigBlind: 2 });
const headsUp = new PokerTableEngine(headsUpState);
headsUp.addSeat(0, { userId: "u0", actorId: "h0", actorName: "A", stack: 30 });
headsUp.addSeat(1, { userId: "u1", actorId: "h1", actorName: "B", stack: 30 });
headsUp.startHand();
const hu = headsUp.publicState();
assert.equal(hu.smallBlindIndex, hu.dealerIndex);
assert.equal(hu.currentSeat, hu.dealerIndex);

// A non-all-in raise below the legal minimum is rejected.
assert.throws(() => headsUp.act(hu.currentSeat, "raise", 3), /BelowMinimumRaise/);
assert.throws(() => headsUp.act(hu.currentSeat, "raise", 4.5), /InvalidBet/);
assert.throws(() => headsUp.act(hu.currentSeat, "raise", false), /InvalidBet/);
assert.throws(() => headsUp.act(hu.currentSeat, "raise", "   "), /InvalidBet/);

console.log("Extended rule tests passed.");

// Table administration is validated by the engine, not only by the UI.
const adminState = createTableState({ id: "admin", name: "Admin", maxSeats: 4, smallBlind: 1, bigBlind: 2, minBuyIn: 20, maxBuyIn: 100 });
const adminEngine = new PokerTableEngine(adminState);
adminEngine.updateConfiguration({ name: "Renamed", maxSeats: 6, smallBlind: 2, bigBlind: 4, ante: 1, minBuyIn: 40, maxBuyIn: 200, actionSeconds: 60, chipValueCopper: 2 });
assert.equal(adminEngine.publicState().name, "Renamed");
assert.equal(adminEngine.publicState().maxSeats, 6);
adminEngine.addSeat(0, { userId: "u0", actorId: "cfg0", actorName: "Config", stack: 50 });
assert.throws(() => adminEngine.updateConfiguration({ ...adminEngine.publicState(), maxSeats: 5 }), /SeatCountLocked/);
assert.throws(() => adminEngine.updateConfiguration({ ...adminEngine.publicState(), chipValueCopper: 3 }), /ChipValueLocked/);
adminEngine.addChips(0, 25);
assert.equal(adminEngine.publicState().seats[0].stack, 75);
assert.throws(() => adminEngine.addChips(0, 200), /TopUpLimit/);
assert.throws(() => adminEngine.addChips(0, 1.5), /InvalidTopUp/);
assert.throws(() => adminEngine.addChips(0, false), /InvalidTopUp/);
assert.throws(() => adminEngine.addChips(0, "   "), /InvalidTopUp/);

// Pause blocks actions without changing the current actor or street.
const pauseState = createTableState({ id: "pause", name: "Pause", maxSeats: 2, smallBlind: 1, bigBlind: 2, minBuyIn: 20, maxBuyIn: 100 });
const pauseEngine = new PokerTableEngine(pauseState);
pauseEngine.addSeat(0, { userId: "u0", actorId: "p0", actorName: "P0", stack: 40 });
pauseEngine.addSeat(1, { userId: "u1", actorId: "p1", actorName: "P1", stack: 40 });
pauseEngine.startHand();
const pauseSeat = pauseEngine.publicState().currentSeat;
pauseEngine.setPaused(true);
assert.equal(pauseEngine.publicState().paused, true);
assert.equal(pauseEngine.legalActions(pauseSeat), null);
assert.throws(() => pauseEngine.act(pauseSeat, "fold"), /TablePaused/);
pauseEngine.setPaused(false);
assert.ok(pauseEngine.legalActions(pauseSeat));

// Deferred seat choices survive the hand and can be processed by the host.
pauseEngine.toggleSitOutAfterHand(pauseSeat);
assert.equal(pauseEngine.publicState().seats[pauseSeat].sitOutAfterHand, true);
pauseEngine.toggleLeaveAfterHand(pauseSeat);
assert.equal(pauseEngine.publicState().seats[pauseSeat].leaveAfterHand, true);
assert.equal(pauseEngine.publicState().seats[pauseSeat].sitOutAfterHand, false);

// Every completed hand produces an exportable public history entry.
let historyGuard = 0;
while (["preflop", "flop", "turn", "river"].includes(pauseEngine.publicState().status) && historyGuard < 30) {
  const current = pauseEngine.publicState().currentSeat;
  const legal = pauseEngine.legalActions(current);
  if (legal.canCheck) pauseEngine.act(current, "check");
  else pauseEngine.act(current, "call");
  historyGuard += 1;
}
const historyPublic = pauseEngine.publicState();
assert.equal(historyPublic.handHistory.length, 1);
assert.equal(historyPublic.handHistory[0].handNumber, 1);
assert.equal(historyPublic.handHistory[0].participants.length, 2);
assert.equal(historyPublic.handHistory[0].community.length, 5);
assert.equal(historyPublic.handHistory[0].potTotal, historyPublic.handHistory[0].awards.reduce((sum, award) => sum + award.amount, 0));
for (const seat of historyPublic.seats.filter(Boolean)) {
  assert.deepEqual(seat.revealedCards, pauseEngine.privateCards(seat.index), "Every non-folded showdown participant must reveal automatically.");
  assert.deepEqual(
    historyPublic.handHistory[0].participants.find((participant) => participant.seatIndex === seat.index).cards,
    pauseEngine.privateCards(seat.index),
    "Showdown history must contain the revealed cards."
  );
}
assert.throws(() => pauseEngine.setCardsRevealed(0, false), /CardsVisibilityUnavailable/, "Mandatory showdown cards cannot be hidden.");

const uncontestedState = createTableState({ id: "uncontested", name: "Uncontested", maxSeats: 2, smallBlind: 1, bigBlind: 2 });
const uncontestedEngine = new PokerTableEngine(uncontestedState);
uncontestedEngine.addSeat(0, { userId: "uu0", actorId: "ua0", actorName: "U0", stack: 40 });
uncontestedEngine.addSeat(1, { userId: "uu1", actorId: "ua1", actorName: "U1", stack: 40 });
uncontestedEngine.startHand();
const foldingSeat = uncontestedEngine.publicState().currentSeat;
uncontestedEngine.act(foldingSeat, "fold");
const uncontestedPublic = uncontestedEngine.publicState();
const uncontestedWinner = uncontestedPublic.lastResult.awards[0].seatIndex;
assert.equal(uncontestedPublic.lastResult.type, "uncontested");
assert.ok(uncontestedPublic.seats.every((seat) => seat.revealedCards.length === 0), "An uncontested winner stays hidden by default.");
const winnerCards = uncontestedEngine.privateCards(uncontestedWinner);
uncontestedEngine.setCardsRevealed(uncontestedWinner, true);
assert.deepEqual(uncontestedEngine.publicState().seats[uncontestedWinner].revealedCards, winnerCards);
uncontestedEngine.setCardsRevealed(uncontestedWinner, false);
assert.deepEqual(uncontestedEngine.publicState().seats[uncontestedWinner].revealedCards, []);
assert.throws(() => uncontestedEngine.setCardsRevealed(foldingSeat, true), /CardsVisibilityUnavailable/, "A folded player cannot reveal after an uncontested finish.");

const partialShowdownState = createTableState({ id: "partial-showdown", name: "Partial Showdown", maxSeats: 3, smallBlind: 1, bigBlind: 2 });
const partialShowdownEngine = new PokerTableEngine(partialShowdownState);
for (let index = 0; index < 3; index += 1) {
  partialShowdownEngine.addSeat(index, { userId: `psu${index}`, actorId: `psa${index}`, actorName: `PS${index}`, stack: 40 });
}
partialShowdownEngine.startHand();
const foldedAtShowdown = partialShowdownEngine.publicState().currentSeat;
partialShowdownEngine.act(foldedAtShowdown, "fold");
let partialGuard = 0;
while (["preflop", "flop", "turn", "river"].includes(partialShowdownEngine.publicState().status) && partialGuard < 30) {
  const current = partialShowdownEngine.publicState().currentSeat;
  const legal = partialShowdownEngine.legalActions(current);
  if (legal.canCheck) partialShowdownEngine.act(current, "check");
  else partialShowdownEngine.act(current, "call");
  partialGuard += 1;
}
const partialShowdownPublic = partialShowdownEngine.publicState();
assert.equal(partialShowdownPublic.lastResult.type, "showdown");
assert.deepEqual(partialShowdownPublic.seats[foldedAtShowdown].revealedCards, [], "A player who folded before showdown stays hidden.");
for (const seat of partialShowdownPublic.seats.filter((candidate) => candidate && candidate.index !== foldedAtShowdown)) {
  assert.deepEqual(seat.revealedCards, partialShowdownEngine.privateCards(seat.index), "Every remaining contender reveals at showdown.");
}

console.log("Administration, hand-history, and card-visibility tests passed.");

// Canceling an active hand removes all public card state and refunds commitments.
const resetState = createTableState({ id: "reset", name: "Reset", maxSeats: 2, smallBlind: 1, bigBlind: 2, minBuyIn: 20, maxBuyIn: 100 });
const resetEngine = new PokerTableEngine(resetState);
resetEngine.addSeat(0, { userId: "u0", actorId: "r0", actorName: "R0", stack: 40 });
resetEngine.addSeat(1, { userId: "u1", actorId: "r1", actorName: "R1", stack: 40 });
resetEngine.startHand();
resetEngine.forceReset();
const resetPublic = resetEngine.publicState();
assert.equal(resetPublic.status, "waiting");
assert.deepEqual(resetPublic.community, []);
assert.ok(resetPublic.seats.every((seat) => seat.cardsCount === 0 && seat.revealedCards.length === 0 && !seat.inHand));
assert.equal(resetPublic.seats.reduce((sum, seat) => sum + seat.stack, 0), 80);

console.log("Hand cancel cleanup test passed.");

// Seats can be moved between hands without changing the stack or actor identity.
const moveState = createTableState({ id: "move", name: "Move", maxSeats: 4, smallBlind: 1, bigBlind: 2 });
const moveEngine = new PokerTableEngine(moveState);
moveEngine.addSeat(0, { userId: "move-user", actorId: "move-actor", actorName: "Mover", stack: 73 });
moveEngine.moveSeat(0, 3);
const moved = moveEngine.publicState();
assert.equal(moved.seats[0], null);
assert.equal(moved.seats[3].actorId, "move-actor");
assert.equal(moved.seats[3].stack, 73);
assert.throws(() => moveEngine.moveSeat(0, 1), /EmptySeat/);

// Pausing stores the unused portion of the current timer so resuming does not grant a fresh turn.
const timerState = createTableState({ id: "timer", name: "Timer", maxSeats: 2, smallBlind: 1, bigBlind: 2, actionSeconds: 45 });
const timerEngine = new PokerTableEngine(timerState);
timerEngine.addSeat(0, { userId: "tu0", actorId: "ta0", actorName: "T0", stack: 40 });
timerEngine.addSeat(1, { userId: "tu1", actorId: "ta1", actorName: "T1", stack: 40 });
timerEngine.startHand();
timerEngine.state.turnDeadline = Date.now() + 21000;
timerEngine.setPaused(true);
assert.ok(timerEngine.publicState().turnTimeRemaining <= 21000 && timerEngine.publicState().turnTimeRemaining > 19000);
timerEngine.setPaused(false);
assert.ok(timerEngine.publicState().turnTimeRemaining > 19000);

console.log("Seat movement and timer preservation tests passed.");

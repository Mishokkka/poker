import assert from "node:assert/strict";
import { ACTIONS, BOT_LEVELS, BOT_PERSONALITIES } from "../scripts/constants.js";
import { botThinkDelay, chooseBotAction, normalizeBotLevel, normalizeBotPersonality } from "../scripts/bots/bot-player.js";
import { createTableState, PokerTableEngine } from "../scripts/engine/table-engine.js";

function seeded(seed = 123456789) {
  let state = seed >>> 0;
  return () => {
    state = ((1664525 * state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function mockEngine({ holeCards, community = [], currentBet = 4, callAmount = 4, stack = 96, potTotal = 12 } = {}) {
  const seat = { index: 0, inHand: true, folded: false, allIn: false, stack, streetBet: 0 };
  const opponent = { index: 1, inHand: true, folded: false, allIn: false, stack: 100, streetBet: currentBet };
  const state = { seats: [seat, opponent], maxSeats: 2, dealerIndex: 1, bigBlind: 2, currentBet, potTotal, community };
  const legal = {
    callAmount,
    canCheck: callAmount === 0,
    canCall: callAmount > 0,
    canBet: currentBet === 0,
    canRaise: true,
    canAllIn: true,
    minTarget: Math.max(2, currentBet + 4),
    maxTarget: stack,
    potTotal
  };
  return {
    state,
    privateCards: () => [...holeCards],
    legalActions: () => ({ ...legal })
  };
}

assert.equal(normalizeBotLevel("novice"), BOT_LEVELS.NOVICE);
assert.equal(normalizeBotLevel("unknown"), null);
assert.equal(normalizeBotPersonality("risky"), BOT_PERSONALITIES.RISKY);
assert.equal(normalizeBotPersonality("unknown"), null);
const calmDelay = botThinkDelay(BOT_LEVELS.EXPERIENCED, BOT_PERSONALITIES.CALM, () => 0.5);
const recklessDelay = botThinkDelay(BOT_LEVELS.EXPERIENCED, BOT_PERSONALITIES.RECKLESS, () => 0.5);
assert.ok(calmDelay > recklessDelay, "Calm bots should generally take longer than reckless bots.");

const weak = chooseBotAction(
  mockEngine({ holeCards: ["7s", "2d"], currentBet: 30, callAmount: 30, stack: 70, potTotal: 20 }),
  0,
  BOT_LEVELS.NOVICE,
  BOT_PERSONALITIES.CALM,
  () => 0.95
);
assert.equal(weak.action, ACTIONS.FOLD);

const premium = chooseBotAction(
  mockEngine({ holeCards: ["As", "Ah"], currentBet: 4, callAmount: 4, stack: 96, potTotal: 12 }),
  0,
  BOT_LEVELS.EXPERT,
  BOT_PERSONALITIES.RISKY,
  seeded(42)
);
assert.ok([ACTIONS.CALL, ACTIONS.RAISE, ACTIONS.ALL_IN].includes(premium.action));

const checked = chooseBotAction(
  mockEngine({ holeCards: ["Ks", "Qh"], community: ["2c", "7d", "9s"], currentBet: 0, callAmount: 0, potTotal: 8 }),
  0,
  BOT_LEVELS.EXPERIENCED,
  BOT_PERSONALITIES.RECKLESS,
  seeded(77)
);
assert.ok([ACTIONS.CHECK, ACTIONS.BET].includes(checked.action));

const table = new PokerTableEngine(createTableState({ id: "bot-table", name: "Bot Table", maxSeats: 3 }));
table.addSeat(0, {
  userId: "gm",
  actorId: "npc-1",
  actorName: "Cardsharp",
  actorImg: "npc.webp",
  stack: 100,
  isBot: true,
  botLevel: BOT_LEVELS.EXPERIENCED,
  botPersonality: BOT_PERSONALITIES.RISKY
});
const publicSeat = table.publicState().seats[0];
assert.equal("isBot" in publicSeat, false, "Public table snapshots must not reveal automated seats.");
assert.equal("botLevel" in publicSeat, false);
assert.equal("botPersonality" in publicSeat, false);
const storedSeat = table.storageState().seats[0];
assert.equal(storedSeat.isBot, true);
assert.equal(storedSeat.botLevel, BOT_LEVELS.EXPERIENCED);
assert.equal(storedSeat.botPersonality, BOT_PERSONALITIES.RISKY);

console.log("Poker bot tests passed.");

const simulation = new PokerTableEngine(createTableState({
  id: "bot-simulation",
  name: "Bot Simulation",
  maxSeats: 3,
  smallBlind: 1,
  bigBlind: 2,
  minBuyIn: 20,
  maxBuyIn: 500
}));
const levels = [BOT_LEVELS.NOVICE, BOT_LEVELS.EXPERIENCED, BOT_LEVELS.EXPERT];
const personalities = [BOT_PERSONALITIES.CALM, BOT_PERSONALITIES.RISKY, BOT_PERSONALITIES.RECKLESS];
for (let index = 0; index < 3; index += 1) {
  simulation.addSeat(index, {
    userId: "gm",
    actorId: `npc-${index}`,
    actorName: `Bot ${index}`,
    actorImg: "npc.webp",
    stack: 120,
    isBot: true,
    botLevel: levels[index],
    botPersonality: personalities[index]
  });
}
simulation.startHand();
const simulationRng = seeded(991);
let steps = 0;
while (simulation.isActiveHand && steps < 100) {
  const index = simulation.state.currentSeat;
  assert.notEqual(index, null);
  const seat = simulation.state.seats[index];
  const decision = chooseBotAction(simulation, index, seat.botLevel, seat.botPersonality, simulationRng);
  simulation.act(index, decision.action, decision.amount);
  steps += 1;
}
assert.ok(steps < 100);
assert.equal(simulation.state.status, "complete");

console.log("Full bot hand simulation passed.");

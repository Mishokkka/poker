import assert from "node:assert/strict";

if (!globalThis.crypto) globalThis.crypto = (await import("node:crypto")).webcrypto;
globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value) => Buffer.from(value, "base64").toString("binary");

function setPath(object, path, value) {
  const parts = path.split(".");
  let target = object;
  for (const part of parts.slice(0, -1)) target = target[part] ??= {};
  target[parts.at(-1)] = value;
}

function actor(id, name, gold = 10) {
  return {
    id,
    name,
    img: "icons/svg/mystery-man.svg",
    system: { currency: { gold: { value: gold }, silver: { value: 0 }, copper: { value: 0 } } },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) setPath(this, path, value);
    }
  };
}

function totalCopper(document) {
  return (document.system.currency.gold.value * 100)
    + (document.system.currency.silver.value * 10)
    + document.system.currency.copper.value;
}

const gm = { id: "gm", active: true, isGM: true };
const poorActor = actor("a3", "Poor", 0);
const actors = new Map([
  ["a1", actor("a1", "One")],
  ["a2", actor("a2", "Two")],
  ["a3", poorActor]
]);
const settings = new Map([
  ["fbl-poker-table.tables", {}],
  ["fbl-poker-table.ledger", []],
  ["fbl-poker-table.goldCopperRate", 100],
  ["fbl-poker-table.silverCopperRate", 10]
]);

globalThis.game = {
  user: gm,
  users: { contents: [gm], get: (id) => id === gm.id ? gm : null },
  actors: { get: (id) => actors.get(id) },
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`),
    set: async (moduleId, key, value) => { settings.set(`${moduleId}.${key}`, value); return value; }
  },
  socket: { on() {}, off() {}, emit() {} },
  i18n: { localize: (key) => key, format: (key) => key },
  modules: { get: () => ({ title: "Poker" }) }
};
const hookEvents = [];
globalThis.Hooks = { callAll(name) { hookEvents.push(name); } };
globalThis.ui = { notifications: { error() {}, warn() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };

const { PokerSocket } = await import("../scripts/network/socket.js");
const { REQUEST } = await import("../scripts/constants.js");
const socket = new PokerSocket();

try {
  await socket.initialize();

  await socket.request(REQUEST.CREATE_TABLE, {
    name: "Timer",
    maxSeats: 4,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    minBuyIn: 20,
    maxBuyIn: 200,
    actionSeconds: 45,
    chipValueCopper: 1
  });
  const tableId = [...socket.tables.keys()][0];
  const initialA1Balance = totalCopper(actors.get("a1"));

  await assert.rejects(
    socket.request(REQUEST.JOIN, { tableId, seatIndex: 0, actorId: "a1", buyIn: Number.NaN }),
    /BuyInRange/,
    "Non-finite buy-ins must be rejected before touching Actor currency."
  );
  assert.equal(totalCopper(actors.get("a1")), initialA1Balance);

  await assert.rejects(
    socket.request(REQUEST.JOIN, { tableId, seatIndex: 0, actorId: "a1", buyIn: 40.5 }),
    /BuyInRange/,
    "Fractional buy-ins must be rejected rather than silently rounded."
  );
  assert.equal(totalCopper(actors.get("a1")), initialA1Balance);

  await socket.request(REQUEST.JOIN, { tableId, seatIndex: 0, actorId: "a1", buyIn: 40 });
  await socket.request(REQUEST.JOIN, { tableId, seatIndex: 1, actorId: "a2", buyIn: 40 });

  await socket.request(REQUEST.JOIN, {
    tableId,
    seatIndex: 2,
    actorId: "a3",
    buyIn: 40,
    botLevel: "novice",
    botPersonality: "calm"
  });
  assert.equal(socket.getTable(tableId).seats[2].stack, 40, "A GM may grant a full stack to an automated NPC despite an empty wallet.");
  assert.equal(totalCopper(poorActor), 0);

  await socket.request(REQUEST.MOVE_SEAT, { tableId, fromSeatIndex: 1, toSeatIndex: 3 });
  assert.equal(socket.getTable(tableId).seats[1], null);
  assert.equal(socket.getTable(tableId).seats[3].actorId, "a2");

  hookEvents.length = 0;
  await socket.request(REQUEST.START_HAND, { tableId });
  const firstPrivateUpdate = hookEvents.indexOf("fblPokerPrivateUpdated");
  const firstStateUpdate = hookEvents.indexOf("fblPokerStateUpdated");
  assert.ok(firstPrivateUpdate >= 0 && firstStateUpdate > firstPrivateUpdate, "Private hands must arrive before the public snapshot to avoid replaying the deal animation.");
  const before = socket.getTable(tableId).turnDeadline;
  assert.ok(before - Date.now() > 45000 && before - Date.now() <= 46220, "Three-player dealing gets 1220 ms before the full action allowance");
  const activeSeat = socket.getTable(tableId).currentSeat;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await socket.request(REQUEST.TOGGLE_LEAVE_AFTER_HAND, { tableId, seatIndex: activeSeat });
  const after = socket.getTable(tableId).turnDeadline;
  assert.ok(Math.abs(after - before) < 1000, `Queued seat controls must preserve the deadline. before=${before}, after=${after}`);

  const scheduled = new Map();
  const schedule = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = schedule(callback, delay, ...args);
    scheduled.set(timer, delay);
    return timer;
  };
  try { await socket.request(REQUEST.ACTION, { tableId, seatIndex: activeSeat, action: "call" }); }
  finally { globalThis.setTimeout = schedule; }
  assert.ok(Math.abs(socket.getTable(tableId).turnDeadline - before) < 100, "An early action must carry the unfinished deal allowance to the next player");
  const botDelay = scheduled.get(socket.hostService.botTimers.get(tableId));
  assert.ok(botDelay >= before - 45000 - Date.now() + 1900, "The novice calm bot's thinking delay begins after the remaining deal allowance");

  await socket.request(REQUEST.PAUSE_TABLE, { tableId });
  const remaining = socket.getTable(tableId).turnTimeRemaining;
  assert.ok(remaining > 0 && remaining <= 46220, "Pausing preserves both action time and any remaining deal allowance");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await socket.request(REQUEST.RESUME_TABLE, { tableId });
  const resumed = socket.getTable(tableId).turnDeadline;
  assert.ok(resumed - Date.now() <= remaining + 1000 && resumed - Date.now() > remaining - 1000);

  await socket.request(REQUEST.FORCE_RESET, { tableId });
  actors.delete("a3");
  await assert.rejects(
    socket.request(REQUEST.DELETE_TABLE, { tableId }),
    /TableDeletePayoutFailed/,
    "A failed payout must retain the table and unpaid seat for a recoverable retry."
  );

  const retained = socket.getTable(tableId);
  assert.ok(retained, "The table must remain after a failed payout.");
  assert.equal(retained.seats[0], null, "Successfully paid seats must be removed immediately.");
  assert.equal(retained.seats[3], null, "Successfully paid moved seats must be removed immediately.");
  assert.equal(retained.seats[2].actorId, "a3", "The unpaid seat must remain recoverable.");
  assert.equal(totalCopper(actors.get("a1")), initialA1Balance);
  assert.equal(totalCopper(actors.get("a2")), 1000);

  const failedPayout = settings.get("fbl-poker-table.ledger").find((entry) => entry.actorId === "a3" && entry.status === "failed");
  assert.ok(failedPayout, "A failed deletion payout must be recorded in the transaction ledger.");
  assert.equal(failedPayout.reason, "tableDeletePayoutFailed");

  actors.set("a3", poorActor);
  await socket.request(REQUEST.DELETE_TABLE, { tableId });
  assert.equal(socket.getTable(tableId), null, "Retrying after restoring the Actor must finish table deletion.");
  assert.equal(totalCopper(poorActor), 40);
  assert.equal(totalCopper(actors.get("a1")), initialA1Balance, "Successful payouts must not be duplicated on retry.");
  assert.equal(totalCopper(actors.get("a2")), 1000, "Successful payouts must not be duplicated on retry.");
} finally {
  await socket.shutdown();
}

console.log("Host seat, payout recovery, and timer preservation test passed.");

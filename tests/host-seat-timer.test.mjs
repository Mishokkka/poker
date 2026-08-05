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

const gm = { id: "gm", active: true, isGM: true };
const actors = new Map([
  ["a1", actor("a1", "One")],
  ["a2", actor("a2", "Two")],
  ["a3", actor("a3", "Poor", 0)]
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
  socket: { on() {}, emit() {} },
  i18n: { localize: (key) => key, format: (key) => key },
  modules: { get: () => ({ title: "Poker" }) }
};
const hookEvents = [];
globalThis.Hooks = { callAll(name) { hookEvents.push(name); } };
globalThis.ui = { notifications: { error() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };

globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };

const { PokerSocket } = await import("../scripts/network/socket.js");
const { REQUEST } = await import("../scripts/constants.js");
const socket = new PokerSocket();
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
await socket.request(REQUEST.JOIN, { tableId, seatIndex: 0, actorId: "a1", buyIn: 40 });
await socket.request(REQUEST.JOIN, { tableId, seatIndex: 1, actorId: "a2", buyIn: 40 });
await socket.request(REQUEST.JOIN, { tableId, seatIndex: 2, actorId: "a3", buyIn: 40 });
assert.equal(socket.getTable(tableId).seats[2].stack, 40, "A GM must be able to seat an Actor with a full stack despite an empty wallet.");
assert.equal(actors.get("a3").system.currency.gold.value, 0);
assert.equal(actors.get("a3").system.currency.silver.value, 0);
assert.equal(actors.get("a3").system.currency.copper.value, 0);
await socket.request(REQUEST.MOVE_SEAT, { tableId, fromSeatIndex: 1, toSeatIndex: 3 });
assert.equal(socket.getTable(tableId).seats[1], null);
assert.equal(socket.getTable(tableId).seats[3].actorId, "a2");

hookEvents.length = 0;
await socket.request(REQUEST.START_HAND, { tableId });
const firstPrivateUpdate = hookEvents.indexOf("fblPokerPrivateUpdated");
const firstStateUpdate = hookEvents.indexOf("fblPokerStateUpdated");
assert.ok(firstPrivateUpdate >= 0 && firstStateUpdate > firstPrivateUpdate, "Private hands must arrive before the public snapshot to avoid replaying the deal animation.");
const before = socket.getTable(tableId).turnDeadline;
const activeSeat = socket.getTable(tableId).currentSeat;
await new Promise((resolve) => setTimeout(resolve, 20));
await socket.request(REQUEST.TOGGLE_LEAVE_AFTER_HAND, { tableId, seatIndex: activeSeat });
const after = socket.getTable(tableId).turnDeadline;
assert.ok(Math.abs(after - before) < 250, `Queued seat controls must preserve the deadline. before=${before}, after=${after}`);

await socket.request(REQUEST.PAUSE_TABLE, { tableId });
const remaining = socket.getTable(tableId).turnTimeRemaining;
assert.ok(remaining > 0 && remaining < 45000);
await new Promise((resolve) => setTimeout(resolve, 20));
await socket.request(REQUEST.RESUME_TABLE, { tableId });
const resumed = socket.getTable(tableId).turnDeadline;
assert.ok(resumed - Date.now() <= remaining + 150 && resumed - Date.now() > remaining - 300);

await socket.request(REQUEST.FORCE_RESET, { tableId });
socket.hostService?.shutdown();
console.log("Host seat movement and timer preservation test passed.");

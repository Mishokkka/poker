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

function actor(id, name) {
  return {
    id,
    name,
    img: "icons/svg/mystery-man.svg",
    system: { currency: { gold: { value: 10 }, silver: { value: 0 }, copper: { value: 0 } } },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) setPath(this, path, value);
    }
  };
}

const gm = { id: "gm", active: true, isGM: true };
const actors = new Map([["a1", actor("a1", "One")], ["a2", actor("a2", "Two")]]);
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
globalThis.Hooks = { callAll() {} };
globalThis.ui = { notifications: { error() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };

const { PokerSocket } = await import("../scripts/network/socket.js");
const { ACTIONS, REQUEST, TABLE_STATUS } = await import("../scripts/constants.js");
const socket = new PokerSocket();
await socket.initialize();

await socket.request(REQUEST.CREATE_TABLE, {
  name: "Automatic",
  maxSeats: 2,
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  minBuyIn: 20,
  maxBuyIn: 200,
  actionSeconds: 45,
  chipValueCopper: 1,
  autoNextHand: true,
  autoNextHandSeconds: 1
});
const tableId = [...socket.tables.keys()][0];
await socket.request(REQUEST.JOIN, { tableId, seatIndex: 0, actorId: "a1", buyIn: 40 });
await socket.request(REQUEST.JOIN, { tableId, seatIndex: 1, actorId: "a2", buyIn: 40 });
await socket.request(REQUEST.START_HAND, { tableId });
const firstHand = socket.getTable(tableId).handNumber;
const actingSeat = socket.getTable(tableId).currentSeat;
await socket.request(REQUEST.ACTION, { tableId, seatIndex: actingSeat, action: ACTIONS.FOLD, amount: null });
const completed = socket.getTable(tableId);
assert.equal(completed.status, TABLE_STATUS.COMPLETE);
assert.ok(completed.nextHandDeadline > Date.now());
const timeoutAt = Date.now() + 5000;
while (socket.getTable(tableId).handNumber === firstHand && Date.now() < timeoutAt) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
const restarted = socket.getTable(tableId);
assert.equal(restarted.handNumber, firstHand + 1, "Auto-next must start a new hand after the configured delay.");
assert.equal(restarted.status, TABLE_STATUS.PREFLOP);

await socket.request(REQUEST.FORCE_RESET, { tableId });
assert.equal(socket.getTable(tableId).status, TABLE_STATUS.WAITING, "Force reset must return the table to its waiting state.");
await socket.request(REQUEST.SET_AUTO_NEXT, { tableId, enabled: false });
assert.equal(socket.getTable(tableId).autoNextHand, false);
socket.shutdown();
console.log("Automatic next-hand test passed.");

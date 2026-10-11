import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });

const gm = { id: "gm", active: true, isGM: true };
const settings = new Map([
  ["fbl-poker-table.tables", {}],
  ["fbl-poker-table.tableHistories", {}],
  ["fbl-poker-table.ledger", []],
  ["fbl-poker-table.schemaVersion", 5],
  ["fbl-poker-table.goldCopperRate", 100],
  ["fbl-poker-table.silverCopperRate", 10]
]);
const writes = [];

globalThis.game = {
  user: gm,
  users: { contents: [gm], get: (id) => id === gm.id ? gm : null },
  actors: { get: () => null },
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`),
    set: async (moduleId, key, value) => {
      writes.push({ key, value: structuredClone(value) });
      settings.set(`${moduleId}.${key}`, structuredClone(value));
      return value;
    }
  },
  i18n: { localize: (key) => key, format: (key) => key }
};
globalThis.ui = { notifications: { warn() {} } };
globalThis.Hooks = { callAll() {} };
globalThis.foundry = { utils: { deepClone: structuredClone } };

const published = [];
const socket = {
  publishSnapshot(tables, options = {}) {
    published.push({ tables: structuredClone(tables), options: structuredClone(options) });
  },
  async sendPrivate() {},
  async sendAck() {},
  async sendError() {}
};

const { PokerHostService } = await import("../scripts/network/host-service.js");
const { REQUEST } = await import("../scripts/constants.js");

const service = new PokerHostService(socket);
await service.initialize();
const session = await service.registerSession(gm.id);
assert.ok(session);

function request(type, data, requestId) {
  return service.enqueueLocal({ type, data, userId: gm.id, token: session.token, requestId });
}

const base = {
  maxSeats: 6,
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  minBuyIn: 40,
  maxBuyIn: 200,
  actionSeconds: 45,
  chipValueCopper: 1
};

writes.length = 0;
published.length = 0;
await request(REQUEST.CREATE_TABLE, { ...base, name: "First" }, "create-first");
assert.equal(writes.some(({ key }) => key === "tableHistories"), false, "Creating a history-free table must not rewrite the cold history setting.");
assert.equal(published.at(-1).options.full, false);
assert.equal(published.at(-1).tables.length, 1);

await request(REQUEST.CREATE_TABLE, { ...base, name: "Second" }, "create-second");
const [firstId, secondId] = [...service.tables.keys()];
assert.ok(firstId && secondId);

writes.length = 0;
published.length = 0;
await request(REQUEST.UPDATE_TABLE, { tableId: firstId, name: "First Renamed" }, "rename-first");

assert.equal(writes.filter(({ key }) => key === "tables").length, 1, "A normal table mutation must perform one live-state setting write.");
assert.equal(writes.some(({ key }) => key === "tableHistories"), false, "A mutation that does not change completed-hand history must not rewrite the cold archive.");
const persisted = settings.get("fbl-poker-table.tables");
assert.equal(Object.hasOwn(persisted[firstId], "handHistory"), false);
assert.equal(Object.hasOwn(persisted[secondId], "handHistory"), false);
assert.equal(published.length, 1);
assert.equal(published[0].options.full, false, "Ordinary mutations must use a delta rather than an all-table full snapshot.");
assert.deepEqual(published[0].tables.map((table) => table.id), [firstId], "Only the changed table must be broadcast.");
assert.equal(Object.hasOwn(published[0].tables[0], "handHistory"), false, "Live deltas must not carry the accumulated history array.");

await service.shutdown();
console.log("Hot-path persistence and changed-table delta tests passed.");

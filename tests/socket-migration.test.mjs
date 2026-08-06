import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value) => Buffer.from(value, "base64").toString("binary");

const gm = { id: "gm", active: true, isGM: true };
const settings = new Map([
  ["fbl-poker-table.tables", {}],
  ["fbl-poker-table.ledger", []],
  ["fbl-poker-table.schemaVersion", 4]
]);
const warnings = [];

globalThis.game = {
  user: gm,
  users: { contents: [gm], get: (id) => id === gm.id ? gm : null },
  actors: { get: () => null },
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`),
    set: async (moduleId, key, value) => { settings.set(`${moduleId}.${key}`, value); return value; }
  },
  socket: { on() {}, off() {}, emit() {} },
  i18n: { localize: (key) => key, format: (key, data) => `${key}:${data.count}` },
  modules: { get: () => ({ title: "Poker" }) }
};
globalThis.Hooks = { callAll() {} };
globalThis.ui = { notifications: { error() {}, warn: (message) => warnings.push(message) } };
globalThis.foundry = { utils: { deepClone: structuredClone } };

const { createTableState } = await import("../scripts/engine/table-engine.js");
const { SCHEMA_VERSION } = await import("../scripts/constants.js");
const valid = createTableState({ id: "valid", name: "Valid", maxSeats: 2 });
const future = { ...createTableState({ id: "future", name: "Future", maxSeats: 2 }), schemaVersion: SCHEMA_VERSION + 1, marker: "preserve-me" };
settings.set("fbl-poker-table.tables", { valid, future });

const { PokerSocket } = await import("../scripts/network/socket.js");
const socket = new PokerSocket();
try {
  await socket.initialize();
  assert.equal(socket.tables.size, 1, "A bad stored table must not prevent valid tables from loading.");
  assert.equal(socket.getTable("valid")?.name, "Valid");
  assert.equal(socket.getTable("future"), null);

  const persisted = settings.get("fbl-poker-table.tables");
  assert.equal(persisted.future.marker, "preserve-me", "Rejected table data must remain available for recovery.");
  assert.equal(persisted.future.schemaVersion, SCHEMA_VERSION + 1);
  assert.equal(socket.hostService.rejectedTables.size, 1);
  assert.ok(warnings.some((message) => message.startsWith("FBLPoker.Errors.StoredTablesRejected")));
} finally {
  socket.shutdown();
}

console.log("Per-table migration isolation test passed.");

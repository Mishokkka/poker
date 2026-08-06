import assert from "node:assert/strict";

if (!globalThis.crypto) globalThis.crypto = (await import("node:crypto")).webcrypto;
globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value) => Buffer.from(value, "base64").toString("binary");

const hostUser = { id: "gm", active: true, isGM: true };
const users = {
  contents: [hostUser],
  get: (id) => id === hostUser.id ? hostUser : null,
  find: (predicate) => [hostUser].find(predicate)
};
const settings = new Map([
  ["fbl-poker-table.tables", {}],
  ["fbl-poker-table.ledger", []]
]);
const socketListeners = new Map();
const emitted = [];

globalThis.game = {
  user: hostUser,
  users,
  actors: { get: () => null },
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`),
    set: async (moduleId, key, value) => { settings.set(`${moduleId}.${key}`, value); return value; }
  },
  socket: {
    on: (channel, fn) => socketListeners.set(channel, fn),
    off: (channel) => socketListeners.delete(channel),
    emit: (channel, payload) => emitted.push({ channel, payload })
  },
  i18n: {
    localize: (key) => key,
    format: (key) => key
  },
  modules: { get: () => ({ title: "Poker" }) }
};
globalThis.Hooks = { callAll() {} };
globalThis.ui = { notifications: { error() {}, warn() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };

const { PokerSocket } = await import("../scripts/network/socket.js");
const { REQUEST } = await import("../scripts/constants.js");

const pokerSocket = new PokerSocket();
try {
  await pokerSocket.initialize();
  assert.ok(pokerSocket.sessionToken, "The active GM must establish a local host session without socket loopback");

await pokerSocket.request(REQUEST.CREATE_TABLE, {
  name: "Local Host Test",
  maxSeats: 6,
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  minBuyIn: 40,
  maxBuyIn: 200,
  actionSeconds: 45,
  chipValueCopper: 1
});

assert.equal(pokerSocket.tables.size, 1, "The host must receive its own table snapshot locally");
assert.equal([...pokerSocket.tables.values()][0].name, "Local Host Test");
assert.ok(emitted.some(({ payload }) => payload.type === REQUEST.SNAPSHOT), "Snapshots should still be sent to remote clients");
} finally {
  pokerSocket.shutdown();
}

console.log("Local host socket test passed.");

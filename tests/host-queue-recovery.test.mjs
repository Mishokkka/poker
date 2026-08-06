import assert from "node:assert/strict";

if (!globalThis.crypto) globalThis.crypto = (await import("node:crypto")).webcrypto;

const gm = { id: "gm", active: true, isGM: true };
const settings = new Map([
  ["fbl-poker-table.tables", {}],
  ["fbl-poker-table.ledger", []],
  ["fbl-poker-table.schemaVersion", 4]
]);

globalThis.game = {
  user: gm,
  users: { contents: [gm], get: (id) => id === gm.id ? gm : null },
  actors: { get: () => null },
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`),
    set: async (moduleId, key, value) => { settings.set(`${moduleId}.${key}`, value); return value; }
  },
  i18n: { localize: (key) => key, format: (key) => key }
};
globalThis.ui = { notifications: { warn() {} } };
globalThis.Hooks = { callAll() {} };
globalThis.foundry = { utils: { deepClone: structuredClone } };

let failErrorDelivery = true;
const socket = {
  publishSnapshot() {},
  async sendAck() {},
  async sendError() {
    if (failErrorDelivery) throw new Error("simulated disconnected client");
  }
};

const { PokerHostService } = await import("../scripts/network/host-service.js");
const { REQUEST } = await import("../scripts/constants.js");
const service = new PokerHostService(socket);

try {
  await service.initialize();
  const session = service.registerSession(gm.id, { mode: "ecdh", jwk: { x: "x", y: "y" } });
  assert.ok(session);

  await service.enqueue({
    type: "invalid-request",
    data: {},
    userId: gm.id,
    token: session.token,
    requestId: "bad"
  });

  failErrorDelivery = false;
  await service.enqueue({
    type: REQUEST.CREATE_TABLE,
    data: {
      name: "Queue Recovery",
      maxSeats: 2,
      smallBlind: 1,
      bigBlind: 2,
      ante: 0,
      minBuyIn: 20,
      maxBuyIn: 200,
      actionSeconds: 45,
      chipValueCopper: 1
    },
    userId: gm.id,
    token: session.token,
    requestId: "good"
  });

  assert.equal(service.tables.size, 1, "A failed private error delivery must not poison the host queue.");
} finally {
  service.shutdown();
}

console.log("Host queue recovery test passed.");

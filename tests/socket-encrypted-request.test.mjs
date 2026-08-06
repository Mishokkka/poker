import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value) => Buffer.from(value, "base64").toString("binary");

const gm = { id: "gm", active: true, isGM: true };
const player = { id: "player", active: true, isGM: false };
const settings = new Map([
  ["fbl-poker-table.tables", {}],
  ["fbl-poker-table.ledger", []],
  ["fbl-poker-table.schemaVersion", 4]
]);
let listener = null;
const emitted = [];

globalThis.game = {
  user: gm,
  users: { contents: [gm, player], get: (id) => [gm, player].find((user) => user.id === id) ?? null },
  actors: { get: () => null },
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`),
    set: async (moduleId, key, value) => { settings.set(`${moduleId}.${key}`, value); return value; }
  },
  socket: {
    on: (_channel, fn) => { listener = fn; },
    off() {},
    emit: (channel, payload) => emitted.push({ channel, payload })
  },
  i18n: { localize: (key) => key, format: (key) => key },
  modules: { get: () => ({ title: "Poker" }) }
};
globalThis.Hooks = { callAll() {} };
globalThis.ui = { notifications: { error() {}, warn() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };

const { PokerSocket } = await import("../scripts/network/socket.js");
const { SessionCrypto } = await import("../scripts/network/crypto.js");
const { REQUEST } = await import("../scripts/constants.js");
const playerCrypto = new SessionCrypto();
await playerCrypto.initialize();
const socket = new PokerSocket();

try {
  await socket.initialize();
  await listener({
    type: REQUEST.HELLO,
    userId: player.id,
    hostUserId: gm.id,
    publicKey: playerCrypto.publicKey
  });

  const sessionEnvelope = emitted.findLast(({ payload }) => payload.type === REQUEST.PRIVATE && payload.recipient === player.id)?.payload;
  assert.ok(sessionEnvelope);
  const session = await playerCrypto.decrypt(sessionEnvelope.senderPublicKey, sessionEnvelope.encrypted);
  assert.equal(session.kind, "session");

  const requestId = "remote-create";
  const request = {
    kind: "request",
    type: REQUEST.CREATE_TABLE,
    data: {
      name: "Encrypted Request",
      maxSeats: 2,
      smallBlind: 1,
      bigBlind: 2,
      ante: 0,
      minBuyIn: 20,
      maxBuyIn: 200,
      actionSeconds: 45,
      chipValueCopper: 1
    },
    userId: player.id,
    token: session.token,
    requestId
  };

  const readableEnvelope = {
    type: REQUEST.PRIVATE,
    recipient: gm.id,
    senderPublicKey: playerCrypto.publicKey,
    encrypted: await playerCrypto.encrypt(sessionEnvelope.senderPublicKey, request)
  };
  assert.equal(JSON.stringify(readableEnvelope).includes(session.token), false, "Remote session tokens must remain inside ciphertext.");
  await listener(readableEnvelope);

  assert.equal(socket.tables.size, 0, "A non-GM encrypted request must still be rejected by host authorization.");
  const errorEnvelope = emitted.findLast(({ payload }) => payload.type === REQUEST.PRIVATE && payload.recipient === player.id)?.payload;
  const error = await playerCrypto.decrypt(errorEnvelope.senderPublicKey, errorEnvelope.encrypted);
  assert.equal(error.kind, "error");
  assert.equal(error.requestId, requestId);
  assert.equal(error.message, "FBLPoker.Errors.GMOnly");
} finally {
  socket.shutdown();
}

console.log("Encrypted remote request routing and authorization test passed.");

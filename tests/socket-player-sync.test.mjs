import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value) => Buffer.from(value, "base64").toString("binary");

const gm = { id: "gm", active: true, isGM: true };
const player = { id: "player", active: true, isGM: false };
const users = {
  contents: [gm, player],
  get: (id) => [gm, player].find((user) => user.id === id) ?? null
};
let listener = null;
let removedListener = null;
const emitted = [];

globalThis.game = {
  user: player,
  users,
  settings: { get: () => ({}) },
  socket: {
    on: (_channel, fn) => { listener = fn; },
    off: (_channel, fn) => { removedListener = fn; },
    emit: (channel, payload) => emitted.push({ channel, payload })
  },
  i18n: {
    localize: (key) => key,
    format: (key) => key
  },
  modules: { get: () => ({ title: "Poker" }) }
};
globalThis.Hooks = { callAll() {} };
globalThis.ui = { notifications: { error() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };

const { PokerSocket } = await import("../scripts/network/socket.js");
const { SessionCrypto } = await import("../scripts/network/crypto.js");
const { REQUEST } = await import("../scripts/constants.js");

const hostCrypto = new SessionCrypto();
await hostCrypto.initialize();
const attackerCrypto = new SessionCrypto();
await attackerCrypto.initialize();
const socket = new PokerSocket();

try {
  await socket.initialize();
  assert.ok(listener, "The player must register its socket listener.");
  const hello = emitted.find(({ payload }) => payload.type === REQUEST.HELLO)?.payload;
  assert.equal(hello?.publicKey?.mode, "ecdh");

  const activeTable = {
    id: "table-1",
    name: "Remote Table",
    handNumber: 1,
    seats: [{ index: 0, userId: player.id, cardsCount: 2 }]
  };
  await listener({ type: REQUEST.SNAPSHOT, hostUserId: "former-gm", tables: [{ ...activeTable, name: "Stale Table" }] });
  assert.equal(socket.getTable("table-1"), null, "Snapshots from a previous host must be ignored.");
  await listener({ type: REQUEST.SNAPSHOT, hostUserId: gm.id, tables: [activeTable] });
  assert.equal(socket.getTable("table-1")?.name, "Remote Table", "Public tables must synchronize before session establishment.");

  await listener({
    type: REQUEST.PRIVATE,
    recipient: player.id,
    senderPublicKey: attackerCrypto.publicKey,
    encrypted: await attackerCrypto.encrypt(hello.publicKey, {
      kind: "holeCards",
      tableId: "table-1",
      handNumber: 1,
      seatIndex: 0,
      cards: ["2c", "3d"]
    })
  });
  assert.deepEqual(socket.getPrivateHand("table-1", 1, 0), [], "Private data must be rejected until the active host key is known.");

  const sessionToken = "session-player";
  await listener({
    type: REQUEST.PRIVATE,
    recipient: player.id,
    senderPublicKey: hostCrypto.publicKey,
    encrypted: await hostCrypto.encrypt(hello.publicKey, { kind: "session", token: sessionToken, hostUserId: gm.id })
  });
  assert.equal(socket.sessionToken, sessionToken);

  await listener({
    type: REQUEST.PRIVATE,
    recipient: player.id,
    senderPublicKey: attackerCrypto.publicKey,
    encrypted: await attackerCrypto.encrypt(hello.publicKey, {
      kind: "holeCards",
      tableId: "table-1",
      handNumber: 1,
      seatIndex: 0,
      cards: ["4c", "5d"]
    })
  });
  assert.deepEqual(socket.getPrivateHand("table-1", 1, 0), [], "Private data from a key other than the established host key must be rejected.");

  const requestDeadline = Date.now() + 2000;
  let stateEnvelope = null;
  while (!stateEnvelope && Date.now() < requestDeadline) {
    stateEnvelope = emitted.findLast(({ payload }) => payload.type === REQUEST.PRIVATE && payload.recipient === gm.id)?.payload ?? null;
    if (!stateEnvelope) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(stateEnvelope, "The player must send the initial state request through encrypted private transport.");
  assert.equal(JSON.stringify(stateEnvelope).includes(sessionToken), false, "Session tokens must never appear in readable socket payloads.");
  const stateRequest = await hostCrypto.decrypt(hello.publicKey, stateEnvelope.encrypted);
  assert.equal(stateRequest.kind, "request");
  assert.equal(stateRequest.type, REQUEST.REQUEST_STATE);
  assert.equal(stateRequest.token, sessionToken);

  await listener({
    type: REQUEST.PRIVATE,
    recipient: player.id,
    senderPublicKey: hostCrypto.publicKey,
    encrypted: await hostCrypto.encrypt(hello.publicKey, { kind: "ack", requestId: stateRequest.requestId })
  });

  await listener({
    type: REQUEST.PRIVATE,
    recipient: player.id,
    senderPublicKey: hostCrypto.publicKey,
    encrypted: await hostCrypto.encrypt(hello.publicKey, {
      kind: "holeCards",
      tableId: "table-1",
      handNumber: 1,
      seatIndex: 0,
      cards: ["As", "Ts"]
    })
  });
  assert.deepEqual(socket.getPrivateHand("table-1", 1, 0), ["As", "Ts"]);

  await listener({
    type: REQUEST.SNAPSHOT,
    hostUserId: gm.id,
    tables: [{ ...activeTable, seats: [{ ...activeTable.seats[0], cardsCount: 0 }] }]
  });
  assert.deepEqual(socket.getPrivateHand("table-1", 1, 0), [], "Canceled hands must clear cached private cards.");
} finally {
  await socket.shutdown();
}

assert.equal(removedListener, listener, "Shutdown must remove the registered socket listener.");
console.log("Encrypted remote player synchronization test passed.");

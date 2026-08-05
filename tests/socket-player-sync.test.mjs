import assert from "node:assert/strict";

Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: {
    getRandomValues(array) {
      for (let index = 0; index < array.length; index += 1) array[index] = (index * 17 + 11) & 0xff;
      return array;
    }
  }
});

globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value) => Buffer.from(value, "base64").toString("binary");

const gm = { id: "gm", active: true, isGM: true };
const player = { id: "player", active: true, isGM: false };
const users = {
  contents: [gm, player],
  get: (id) => [gm, player].find((user) => user.id === id) ?? null
};
let listener = null;
const emitted = [];

globalThis.game = {
  user: player,
  users,
  socket: {
    on: (_channel, fn) => { listener = fn; },
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
const { REQUEST } = await import("../scripts/constants.js");

const socket = new PokerSocket();
await socket.initialize();
assert.ok(listener, "The player must register its socket listener even without crypto.subtle");
assert.ok(emitted.some(({ payload }) => payload.type === REQUEST.HELLO && payload.publicKey.mode === "plain"));

const activeTable = {
  id: "table-1",
  name: "Remote Table",
  handNumber: 1,
  seats: [{ index: 0, userId: player.id, cardsCount: 2 }]
};
await listener({ type: REQUEST.SNAPSHOT, tables: [activeTable] });
assert.equal(socket.getTable("table-1")?.name, "Remote Table", "Public tables must synchronize before session establishment");

await listener({
  type: REQUEST.PRIVATE,
  recipient: player.id,
  senderPublicKey: { mode: "plain" },
  encrypted: { plain: { kind: "session", token: "session-player" } }
});
assert.equal(socket.sessionToken, "session-player");

await new Promise((resolve) => setTimeout(resolve, 0));
const stateRequest = emitted.findLast(({ payload }) => payload.type === REQUEST.REQUEST_STATE);
assert.ok(stateRequest, "The player must request a fresh state after accepting the session");
await listener({
  type: REQUEST.PRIVATE,
  recipient: player.id,
  senderPublicKey: { mode: "plain" },
  encrypted: { plain: { kind: "ack", requestId: stateRequest.payload.requestId } }
});

await listener({
  type: REQUEST.PRIVATE,
  recipient: player.id,
  senderPublicKey: { mode: "plain" },
  encrypted: {
    plain: {
      kind: "holeCards",
      tableId: "table-1",
      handNumber: 1,
      seatIndex: 0,
      cards: ["As", "Ts"]
    }
  }
});
assert.deepEqual(socket.getPrivateHand("table-1", 1, 0), ["As", "Ts"]);

await listener({
  type: REQUEST.SNAPSHOT,
  tables: [{ ...activeTable, seats: [{ ...activeTable.seats[0], cardsCount: 0 }] }]
});
assert.deepEqual(socket.getPrivateHand("table-1", 1, 0), [], "Canceled hands must clear cached private cards");

console.log("Remote player synchronization test passed.");

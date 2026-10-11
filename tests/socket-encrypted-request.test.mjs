import assert from "node:assert/strict";

let randomCall = 0;
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: {
    getRandomValues(array) {
      randomCall += 1;
      for (let index = 0; index < array.length; index += 1) array[index] = (index * 29 + 5 + randomCall) & 0xff;
      return array;
    }
  }
});

let deliveredSession = null;
const player = {
  id: "player",
  active: true,
  isGM: false,
  async query(_name, payload) {
    if (payload.kind === "sessionDelivery") {
      deliveredSession = structuredClone(payload);
      return { ok: true };
    }
    if (payload.kind === "delivery") return { ok: true };
    return { ok: false, message: "FBLPoker.Errors.InvalidRequest" };
  }
};
const otherPlayer = {
  id: "other-player",
  active: true,
  isGM: false,
  async query() { return { ok: true }; }
};
const gm = { id: "gm", active: true, isGM: true };
const settings = new Map([
  ["fbl-poker-table.tables", {}],
  ["fbl-poker-table.ledger", []],
  ["fbl-poker-table.schemaVersion", 4]
]);
let listener = null;
const emitted = [];

globalThis.game = {
  user: gm,
  users: {
    contents: [gm, player, otherPlayer],
    get: (id) => [gm, player, otherPlayer].find((user) => user.id === id) ?? null
  },
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
const { REQUEST } = await import("../scripts/constants.js");
const socket = new PokerSocket();

try {
  await socket.initialize();
  assert.ok(listener);
  assert.equal(globalThis.crypto.subtle, undefined, "Host query routing must not require crypto.subtle.");

  const provision = await socket.handleQuery({
    kind: "provisionSessions",
    hostUserId: gm.id,
    userId: otherPlayer.id
  });
  assert.equal(provision.ok, true);
  assert.equal(provision.hostUserId, gm.id);
  assert.ok(deliveredSession?.token, "The host must deliver a session token directly to the target player.");
  assert.equal(deliveredSession.userId, player.id);
  assert.equal(emitted.some(({ payload }) => JSON.stringify(payload).includes(deliveredSession.token)), false, "Query session tokens must stay off the broadcast socket.");

  const previousEpoch = await socket.handleQuery({ kind: "request", protocol: 2, epoch: socket.epoch - 1, hostUserId: gm.id, userId: player.id, token: deliveredSession.token, requestId: "prior-epoch", type: REQUEST.REQUEST_STATE, data: {} });
  assert.equal(previousEpoch.message, "FBLPoker.Errors.InvalidSession", "A same-user host restart must trigger the existing session recovery handshake");

  const directMint = await socket.handleQuery({
    kind: "session",
    hostUserId: gm.id,
    userId: otherPlayer.id
  });
  assert.equal(directMint.ok, false, "A requester must not be able to mint a token for an arbitrary user identity.");

  const impersonation = await socket.handleQuery({
    kind: "request", protocol: 2, epoch: socket.epoch,
    hostUserId: gm.id,
    type: REQUEST.REQUEST_STATE,
    data: {},
    userId: otherPlayer.id,
    token: deliveredSession.token,
    requestId: "spoofed-state"
  });
  assert.equal(impersonation.ok, false, "A token provisioned for one player must not authorize another user id.");
  assert.equal(impersonation.message, "FBLPoker.Errors.InvalidSession");

  const rejected = await socket.handleQuery({
    kind: "request", protocol: 2, epoch: socket.epoch,
    hostUserId: gm.id,
    type: REQUEST.CREATE_TABLE,
    data: {
      name: "Unauthorized Request",
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
    token: deliveredSession.token,
    requestId: "remote-create"
  });

  assert.equal(rejected.ok, false, "A non-GM targeted query must still be rejected by host authorization.");
  assert.equal(rejected.message, "FBLPoker.Errors.GMOnly");
  assert.equal(socket.tables.size, 0);

  const stateRequest = await socket.handleQuery({
    kind: "request", protocol: 2, epoch: socket.epoch,
    hostUserId: gm.id,
    type: REQUEST.REQUEST_STATE,
    data: {},
    userId: player.id,
    token: deliveredSession.token,
    requestId: "remote-state"
  });
  assert.equal(stateRequest.ok, true, "Authorized player requests must complete through Foundry v13 targeted queries.");
} finally {
  await socket.shutdown();
}

console.log("Targeted query request routing and authorization test passed.");

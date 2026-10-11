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

let listener = null;
let removedListener = null;
const emitted = [];
const queries = [];
const sessionToken = "session-player";
let socket = null;
let targetedSnapshot = [];
let sequence = 0;
const deliver = payload => listener({ epoch: 1, sequence: ++sequence, ...payload }, payload.hostUserId);

const player = { id: "player", active: true, isGM: false };
const gm = {
  id: "gm",
  active: true,
  isGM: true,
  async query(name, payload) {
    queries.push({ name, payload });
    if (payload.kind === "provisionSessions") {
      const delivered = await socket.handleQuery({
        kind: "sessionDelivery", epoch: 1,
        hostUserId: gm.id,
        userId: player.id,
        token: sessionToken
      });
      assert.equal(delivered.ok, true);
      return { ok: true, hostUserId: gm.id };
    }
    if (payload.kind === "request") return { ok: true, value: { kind: "snapshot", epoch: 1, sequence: ++sequence, tables: targetedSnapshot } };
    return { ok: false, message: "FBLPoker.Errors.InvalidRequest" };
  }
};
const users = {
  contents: [gm, player],
  get: (id) => [gm, player].find((user) => user.id === id) ?? null
};

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
const { QUERY_NAME, REQUEST } = await import("../scripts/constants.js");

socket = new PokerSocket();

try {
  await socket.initialize();
  assert.ok(listener, "The player must register its public snapshot listener.");
  assert.equal(globalThis.crypto.subtle, undefined, "The regression must exercise a plain-HTTP-style browser without crypto.subtle.");

  const activeTable = {
    id: "table-1",
    name: "Remote Table",
    handNumber: 1,
    seats: [{ index: 0, userId: player.id, cardsCount: 2 }]
  };
  await deliver({ type: REQUEST.SNAPSHOT, hostUserId: "former-gm", tables: [{ ...activeTable, name: "Stale Table" }] });
  assert.equal(socket.getTable("table-1"), null, "Snapshots from a previous host must be ignored.");
  await deliver({ type: REQUEST.SNAPSHOT, hostUserId: gm.id, tables: [activeTable] });
  assert.equal(socket.getTable("table-1")?.name, "Remote Table", "Public tables must synchronize independently of private transport.");

  targetedSnapshot = [{ ...activeTable, name: "Targeted Refresh Table" }];
  await socket.synchronize();
  assert.equal(socket.sessionToken, sessionToken, "A remote player must receive a host-provisioned targeted-query session without Web Crypto.");
  assert.equal(socket.getTable("table-1")?.name, "Targeted Refresh Table", "REQUEST_STATE must apply the targeted query snapshot on the requesting client.");
  assert.equal(queries[0]?.name, QUERY_NAME);
  assert.equal(queries[0]?.payload.kind, "provisionSessions");
  assert.equal("userId" in queries[0].payload, false, "A player must not be able to choose which user receives a session token.");
  assert.equal(queries[1]?.payload.kind, "request");
  assert.equal(queries[1]?.payload.type, REQUEST.REQUEST_STATE);
  assert.equal(queries[1]?.payload.userId, player.id);
  assert.equal(queries[1]?.payload.token, sessionToken);
  assert.equal(emitted.some(({ payload }) => JSON.stringify(payload).includes(sessionToken)), false, "Session tokens must never be placed on the broadcast module socket.");

  const rejected = await socket.handleQuery({
    kind: "delivery",
    hostUserId: gm.id,
    userId: player.id,
    token: "wrong-token",
    data: {
      kind: "holeCards",
      tableId: "table-1",
      handNumber: 1,
      seatIndex: 0,
      cards: ["2c", "3d"]
    }
  });
  assert.equal(rejected.ok, false, "Private deliveries must require the established targeted-query session token.");
  assert.deepEqual(socket.getPrivateHand("table-1", 1, 0), []);

  const accepted = await socket.handleQuery({
    kind: "delivery",
    hostUserId: gm.id,
    userId: player.id,
    token: sessionToken,
    data: {
      kind: "holeCards",
      tableId: "table-1",
      handNumber: 1,
      seatIndex: 0,
      cards: ["As", "Ts"]
    }
  });
  assert.equal(accepted.ok, true);
  assert.deepEqual(socket.getPrivateHand("table-1", 1, 0), ["As", "Ts"]);

  await deliver({
    type: REQUEST.SNAPSHOT,
    hostUserId: gm.id,
    tables: [{ ...activeTable, seats: [{ ...activeTable.seats[0], cardsCount: 0 }] }]
  });
  assert.deepEqual(socket.getPrivateHand("table-1", 1, 0), [], "Canceled hands must clear cached private cards.");
} finally {
  await socket.shutdown();
}

assert.equal(removedListener, listener, "Shutdown must remove the registered socket listener.");
console.log("Targeted-query remote player synchronization test passed.");

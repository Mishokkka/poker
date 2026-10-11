import assert from "node:assert/strict";

const player = { id: "player", active: true, isGM: false };
const gm = { id: "gm", active: true, isGM: true, async query() { return { ok: true, value: true }; } };
const users = {
  contents: [gm, player],
  get: (id) => [gm, player].find((user) => user.id === id) ?? null
};

let listener = null;
const hookCalls = [];

globalThis.game = {
  user: player,
  users,
  settings: {
    get: (_moduleId, key) => key === "schemaVersion" ? 5 : {}
  },
  socket: {
    on: (_channel, fn) => { listener = fn; },
    off() {},
    emit() {}
  },
  i18n: { localize: (key) => key, format: (key) => key },
  modules: { get: () => ({ title: "Poker" }) }
};
globalThis.Hooks = {
  callAll(name, tables, changes) {
    if (name === "fblPokerStateUpdated") hookCalls.push({ tables, changes });
  }
};
globalThis.ui = { notifications: { error() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };

const { PokerSocket } = await import("../scripts/network/socket.js");
const { REQUEST } = await import("../scripts/constants.js");

function table(id, overrides = {}) {
  return {
    id,
    name: `Table ${id}`,
    revision: 1,
    updatedAt: 100,
    historyRevision: 1,
    handNumber: 4,
    status: "preflop",
    maxSeats: 6,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    minBuyIn: 40,
    maxBuyIn: 200,
    seats: [null, null, null, null, null, null],
    handHistory: [{ handNumber: 3, actions: [{ type: "check" }] }],
    ...overrides
  };
}

const pokerSocket = new PokerSocket();
let sequence = 0;
const deliver = payload => listener({ epoch: 1, sequence: ++sequence, ...payload }, gm.id);
try {
  await pokerSocket.initialize();
  assert.ok(listener, "The public snapshot listener must be registered.");

  const a = table("a");
  const b = table("b", { name: "Table B" });
  await deliver({ type: REQUEST.SNAPSHOT, hostUserId: gm.id, full: true, tables: [a, b] });
  const preservedB = pokerSocket.getTable("b");
  hookCalls.length = 0;

  const { handHistory: _history, ...aLive } = a;
  await deliver({
    type: REQUEST.SNAPSHOT,
    hostUserId: gm.id,
    full: false,
    tables: [{ ...aLive, revision: 2, updatedAt: 200, currentSeat: 2 }]
  });

  assert.deepEqual(pokerSocket.getTable("a").handHistory, a.handHistory, "A live delta must preserve cached cold history.");
  assert.equal(pokerSocket.getTable("b"), preservedB, "An unchanged table must retain its existing state object instead of being rebuilt.");
  assert.equal(hookCalls.length, 1);
  assert.deepEqual([...hookCalls[0].changes.changedTableIds], ["a"]);
  assert.deepEqual([...hookCalls[0].changes.historyChangedTableIds], []);
  assert.equal(hookCalls[0].changes.lobbyChanged, false, "A betting-only delta must not invalidate the lobby.");

  hookCalls.length = 0;
  const completedHand = { handNumber: 4, actions: [{ type: "call" }], participants: [] };
  await deliver({
    type: REQUEST.SNAPSHOT,
    hostUserId: gm.id,
    full: false,
    tables: [{ ...aLive, revision: 3, updatedAt: 300, historyRevision: 2, status: "complete" }],
    historyUpdates: [{ tableId: "a", revision: 2, hand: completedHand }]
  });

  assert.equal(pokerSocket.getTable("a").handHistory.length, 2);
  assert.deepEqual(pokerSocket.getTable("a").handHistory[0], completedHand);
  assert.deepEqual([...hookCalls[0].changes.historyChangedTableIds], ["a"]);
  assert.equal(hookCalls[0].changes.lobbyChanged, true, "A status change is visible in the lobby and must invalidate it.");

  hookCalls.length = 0;
  await deliver({
    type: REQUEST.SNAPSHOT,
    hostUserId: gm.id,
    full: false,
    tables: [],
    deletedTableIds: ["b"]
  });
  assert.equal(pokerSocket.getTable("b"), null);
  assert.deepEqual([...hookCalls[0].changes.deletedTableIds], ["b"]);
  assert.equal(hookCalls[0].changes.lobbyChanged, true);
  // Host identity in the JSON is insufficient: v13 supplies the actual sender separately.
  await listener({ type: REQUEST.SNAPSHOT, epoch: 1, sequence: 999, hostUserId: gm.id, full: true, tables: [table("forged")] }, player.id);
  assert.equal(pokerSocket.getTable("forged"), null);
  await deliver({ type: REQUEST.SNAPSHOT, hostUserId: gm.id, epoch: 1, sequence: 10, full: false, tables: [{ ...aLive, revision: 10 }] });
  await deliver({ type: REQUEST.SNAPSHOT, hostUserId: gm.id, epoch: 1, sequence: 8, full: true, tables: [a, table("c")] });
  assert.equal(pokerSocket.getTable("a").revision, 10, "A delayed full snapshot must not undo a newer delta");
  assert.ok(pokerSocket.getTable("c"), "An older full snapshot still supplies unchanged tables");
  await deliver({ type: REQUEST.SNAPSHOT, hostUserId: gm.id, epoch: 1, sequence: 12, full: false, tables: [], deletedTableIds: ["a"] });
  await deliver({ type: REQUEST.SNAPSHOT, hostUserId: gm.id, epoch: 1, sequence: 11, full: true, tables: [a, table("c")] });
  assert.equal(pokerSocket.getTable("a"), null, "A tombstone survives delayed full snapshots");
  await deliver({ type: REQUEST.SNAPSHOT, hostUserId: gm.id, epoch: 2, sequence: 1, hostNow: 500000, full: true, tables: [table("new")] });
  await deliver({ type: REQUEST.SNAPSHOT, hostUserId: gm.id, epoch: 1, sequence: 999, full: true, tables: [a] });
  assert.ok(pokerSocket.getTable("new"));
  assert.equal(pokerSocket.getTable("a"), null, "An old instance of the same GM must not overwrite the new epoch");
  assert.ok(Math.abs(pokerSocket.hostNow() - 500000) < 1000, "Countdown uses the host's clock even when local time differs by years");
  player.isGM = true;
  assert.equal(pokerSocket.hasAutomationInfo("new"), false);
  assert.equal((await pokerSocket.handleQuery({ kind: "sessionDelivery", epoch: 2, hostUserId: gm.id, userId: player.id, token: "gm-private" })).ok, true);
  await pokerSocket.handleQuery({ kind: "delivery", hostUserId: gm.id, userId: player.id, token: "gm-private", data: { kind: "automation", tables: { new: { revision: 1, seats: [0] } } } });
  assert.equal(pokerSocket.isAutomatedSeat("new", 0), true, "A secondary GM receives bot control metadata privately");
  assert.equal(pokerSocket.hasAutomationInfo("new"), true);
} finally {
  await pokerSocket.shutdown();
}

console.log("Delta snapshot, cold-history merge, and granular invalidation tests passed.");

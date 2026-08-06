import assert from "node:assert/strict";

if (!globalThis.crypto) globalThis.crypto = (await import("node:crypto")).webcrypto;
globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value) => Buffer.from(value, "base64").toString("binary");

function setPath(object, path, value) {
  const parts = path.split(".");
  let target = object;
  for (const part of parts.slice(0, -1)) target = target[part] ??= {};
  target[parts.at(-1)] = value;
}

function actor(id) {
  return {
    id,
    name: id,
    img: "icons/svg/mystery-man.svg",
    system: { currency: { gold: { value: 10 }, silver: { value: 0 }, copper: { value: 0 } } },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) setPath(this, path, value);
    }
  };
}

const gm = { id: "gm", active: true, isGM: true };
const actors = new Map([["a1", actor("a1")], ["a2", actor("a2")]]);
const settings = new Map([
  ["fbl-poker-table.tables", {}],
  ["fbl-poker-table.ledger", []],
  ["fbl-poker-table.goldCopperRate", 100],
  ["fbl-poker-table.silverCopperRate", 10]
]);

globalThis.game = {
  user: gm,
  users: { contents: [gm], get: (id) => id === gm.id ? gm : null },
  actors: { get: (id) => actors.get(id) },
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`),
    set: async (moduleId, key, value) => { settings.set(`${moduleId}.${key}`, value); return value; }
  },
  socket: { on() {}, off() {}, emit() {} },
  i18n: { localize: (key) => key, format: (key) => key },
  modules: { get: () => ({ title: "Poker" }) }
};
globalThis.Hooks = { callAll() {} };
globalThis.ui = { notifications: { error() {}, warn() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };

const { PokerSocket } = await import("../scripts/network/socket.js");
const { ACTIONS, REQUEST, TABLE_STATUS } = await import("../scripts/constants.js");
const socket = new PokerSocket();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let fakeTimersInstalled = false;

try {
  await socket.initialize();
  await socket.request(REQUEST.CREATE_TABLE, {
    name: "Stale Timer",
    maxSeats: 2,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    minBuyIn: 20,
    maxBuyIn: 200,
    actionSeconds: 45,
    chipValueCopper: 1,
    autoNextHand: true,
    autoNextHandSeconds: 1
  });
  const tableId = [...socket.tables.keys()][0];
  await socket.request(REQUEST.JOIN, { tableId, seatIndex: 0, actorId: "a1", buyIn: 40 });
  await socket.request(REQUEST.JOIN, { tableId, seatIndex: 1, actorId: "a2", buyIn: 40 });
  await socket.request(REQUEST.START_HAND, { tableId });

  const fakeHandles = [];
  globalThis.setTimeout = (callback, delay) => {
    const handle = { callback, delay, cleared: false, fake: true };
    fakeHandles.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle?.fake) handle.cleared = true;
    else realClearTimeout(handle);
  };
  fakeTimersInstalled = true;

  const firstHand = socket.getTable(tableId).handNumber;
  const actingSeat = socket.getTable(tableId).currentSeat;
  await socket.request(REQUEST.ACTION, { tableId, seatIndex: actingSeat, action: ACTIONS.FOLD, amount: null });
  assert.equal(socket.getTable(tableId).status, TABLE_STATUS.COMPLETE);
  const staleTimer = socket.hostService.autoNextTimers.get(tableId);
  assert.ok(staleTimer?.fake);

  await socket.request(REQUEST.SET_AUTO_NEXT, { tableId, enabled: false });
  await socket.request(REQUEST.SET_AUTO_NEXT, { tableId, enabled: true });
  const currentTimer = socket.hostService.autoNextTimers.get(tableId);
  assert.ok(currentTimer?.fake && currentTimer !== staleTimer);

  staleTimer.callback();
  await Promise.resolve();
  await socket.hostService.queue;
  assert.equal(socket.getTable(tableId).handNumber, firstHand, "A replaced auto-next callback must not advance the hand.");
  assert.equal(socket.hostService.autoNextTimers.get(tableId), currentTimer, "A stale callback must not delete the replacement timer.");

  currentTimer.callback();
  await Promise.resolve();
  await socket.hostService.queue;
  assert.equal(socket.getTable(tableId).handNumber, firstHand + 1, "The current auto-next callback must still advance the hand.");
} finally {
  socket.shutdown();
  if (fakeTimersInstalled) {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

console.log("Stale automatic-next timer regression test passed.");

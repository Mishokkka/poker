import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });

const gm = { id: "gm", active: true, isGM: true };
const player = { id: "player", active: true, isGM: false };
const users = {
  contents: [gm, player],
  get: (id) => [gm, player].find((user) => user.id === id) ?? null
};

const { createTableState, PokerTableEngine } = await import("../scripts/engine/table-engine.js");
const { PokerHostService } = await import("../scripts/network/host-service.js");
const { REQUEST, SCHEMA_VERSION } = await import("../scripts/constants.js");

const legacy = createTableState({
  id: "legacy-table",
  name: "Legacy Table",
  maxSeats: 2,
  smallBlind: 1,
  bigBlind: 2,
  minBuyIn: 20,
  maxBuyIn: 100,
  actionSeconds: 45,
  chipValueCopper: 1
});
legacy.schemaVersion = 4;
delete legacy.historyRevision;
legacy.handHistory = [{
  handNumber: 1,
  type: "uncontested",
  startedAt: 10,
  completedAt: 20,
  dealerIndex: 0,
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  potTotal: 3,
  community: [],
  participants: [],
  awards: [],
  actions: []
}];

const settings = new Map([
  ["fbl-poker-table.tables", { [legacy.id]: structuredClone(legacy) }],
  ["fbl-poker-table.tableHistories", {}],
  ["fbl-poker-table.ledger", []],
  ["fbl-poker-table.schemaVersion", 4],
  ["fbl-poker-table.goldCopperRate", 100],
  ["fbl-poker-table.silverCopperRate", 10]
]);
const settingWrites = [];

globalThis.game = {
  user: gm,
  users,
  actors: { get: () => null },
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`),
    set: async (moduleId, key, value) => {
      settingWrites.push({ key, value: structuredClone(value) });
      settings.set(`${moduleId}.${key}`, structuredClone(value));
      return value;
    }
  },
  i18n: { localize: (key) => key, format: (key) => key }
};
globalThis.ui = { notifications: { warn() {} } };
globalThis.Hooks = { callAll() {} };
globalThis.foundry = { utils: { deepClone: structuredClone } };

const published = [];
const socket = {
  publishSnapshot(tables, options) { published.push({ tables: structuredClone(tables), options: structuredClone(options ?? {}) }); },
  async sendPrivate() {},
  async sendAck() {},
  async sendError() {}
};

const first = new PokerHostService(socket);
await first.initialize();

const storedLive = settings.get("fbl-poker-table.tables")[legacy.id];
const storedArchive = settings.get("fbl-poker-table.tableHistories")[legacy.id];
assert.equal(storedLive.schemaVersion, SCHEMA_VERSION);
assert.equal(Object.hasOwn(storedLive, "handHistory"), false, "Migration must remove archival history from the hot live-state setting.");
assert.equal(storedLive.historyRevision, 1);
assert.equal(storedArchive.revision, 1);
assert.deepEqual(storedArchive.hands, legacy.handHistory, "Legacy history must survive the storage split unchanged.");
assert.equal(settings.get("fbl-poker-table.schemaVersion"), SCHEMA_VERSION);
assert.deepEqual(published.at(-1).tables[0].handHistory, legacy.handHistory, "Full recovery snapshots must still expose the complete history to clients.");

const session = await first.registerSession(player.id);
assert.ok(session);
const publishesBeforeRequestState = published.length;
const stateResponse = await first.enqueueLocal({
  type: REQUEST.REQUEST_STATE,
  data: {},
  userId: player.id,
  token: session.token,
  requestId: "state"
});
assert.equal(stateResponse.kind, "snapshot");
assert.deepEqual(stateResponse.tables[0].handHistory, legacy.handHistory);
assert.equal(published.length, publishesBeforeRequestState, "A single user's state refresh must not broadcast a snapshot to every client.");

await first.shutdown();
settingWrites.length = 0;
published.length = 0;

const second = new PokerHostService(socket);
await second.initialize();
assert.equal(settingWrites.filter(({ key }) => key === "tables" || key === "tableHistories").length, 0, "A clean current-schema host startup must not rewrite unchanged table state.");
assert.equal(published.length, 1, "A host startup still publishes one authoritative recovery snapshot.");
await second.shutdown();

// Public helper regression: deliveries for independent active tables are started together, not serialized by RTT.
const parallelSocket = {
  publishSnapshot() {},
  sendAck: async () => {},
  sendError: async () => {},
  sendPrivate(_userId, data) {
    deliveryCalls.push(data.tableId);
    return new Promise((resolve) => deliveryResolvers.push(resolve));
  }
};
const deliveryCalls = [];
const deliveryResolvers = [];
const parallelService = new PokerHostService(parallelSocket);
for (const id of ["parallel-a", "parallel-b"]) {
  const engine = new PokerTableEngine(createTableState({ id, name: id, maxSeats: 2, smallBlind: 1, bigBlind: 2, minBuyIn: 20, maxBuyIn: 100 }));
  engine.addSeat(0, { userId: player.id, actorId: `${id}-player`, actorName: "Player", stack: 40 });
  engine.addSeat(1, { userId: gm.id, actorId: `${id}-gm`, actorName: "GM", stack: 40 });
  engine.startHand();
  parallelService.tables.set(id, engine);
}
const delivery = parallelService.sendPrivateHandsForUser(player.id);
await Promise.resolve();
assert.deepEqual(deliveryCalls.sort(), ["parallel-a", "parallel-b"], "All independent private deliveries must begin before waiting for any one recipient round trip.");
for (const resolve of deliveryResolvers) resolve();
await delivery;

console.log("History storage migration, targeted refresh, clean startup, and parallel private-delivery tests passed.");

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });

const gm = { id: "gm", active: true, isGM: true };
const settings = new Map([
  ["fbl-poker-table.tables", {}],
  ["fbl-poker-table.ledger", []],
  ["fbl-poker-table.schemaVersion", 4],
  ["fbl-poker-table.goldCopperRate", 100],
  ["fbl-poker-table.silverCopperRate", 10]
]);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

let walletGate = null;
const actor = {
  id: "actor-1",
  name: "Wallet Actor",
  img: "icons/svg/mystery-man.svg",
  system: { currency: { gold: { value: 1 }, silver: { value: 0 }, copper: { value: 0 } } },
  async update(changes) {
    this.system.currency.gold.value = changes["system.currency.gold.value"];
    this.system.currency.silver.value = changes["system.currency.silver.value"];
    this.system.currency.copper.value = changes["system.currency.copper.value"];
    const gate = walletGate;
    if (gate) {
      walletGate = null;
      gate.started.resolve();
      await gate.release.promise;
    }
  }
};

function gateNextWalletUpdate() {
  walletGate = { started: deferred(), release: deferred() };
  return walletGate;
}

function totalCopper() {
  return (actor.system.currency.gold.value * 100)
    + (actor.system.currency.silver.value * 10)
    + actor.system.currency.copper.value;
}

globalThis.game = {
  user: gm,
  users: { contents: [gm], get: (id) => id === gm.id ? gm : null },
  actors: { get: (id) => id === actor.id ? actor : null },
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`),
    set: async (moduleId, key, value) => {
      settings.set(`${moduleId}.${key}`, structuredClone(value));
      return value;
    }
  },
  i18n: { localize: (key) => key, format: (key) => key }
};
globalThis.ui = { notifications: { warn() {} } };
globalThis.Hooks = { callAll() {} };
globalThis.foundry = { utils: { deepClone: structuredClone } };

const socket = {
  publishSnapshot() {},
  async sendPrivate() {},
  async sendAck() {},
  async sendError() {}
};

const { PokerHostService } = await import("../scripts/network/host-service.js");
const { REQUEST } = await import("../scripts/constants.js");

const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
const publicKey = { mode: "ecdh", jwk: await crypto.subtle.exportKey("jwk", keyPair.publicKey) };

async function sessionFor(service) {
  const session = await service.registerSession(gm.id, publicKey);
  assert.ok(session);
  return session;
}

function payload(session, type, data, requestId) {
  return { type, data, userId: gm.id, token: session.token, requestId };
}

const firstService = new PokerHostService(socket);
await firstService.initialize();
const firstSession = await sessionFor(firstService);
await firstService.enqueueLocal(payload(firstSession, REQUEST.CREATE_TABLE, {
  name: "Drain Test",
  maxSeats: 2,
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  minBuyIn: 20,
  maxBuyIn: 100,
  actionSeconds: 45,
  chipValueCopper: 1
}, "create"));
const tableId = [...firstService.tables.keys()][0];

await assert.rejects(
  firstService.enqueueLocal(payload(firstSession, REQUEST.JOIN, {
    tableId,
    seatIndex: null,
    actorId: actor.id,
    buyIn: 20
  }, "invalid-seat")),
  /InvalidSeat/,
  "Null seat indices must be rejected before any wallet mutation."
);
assert.equal(totalCopper(), 100);

const joinGate = gateNextWalletUpdate();
const join = firstService.enqueueLocal(payload(firstSession, REQUEST.JOIN, {
  tableId,
  seatIndex: 0,
  actorId: actor.id,
  buyIn: 20
}, "join"));
await joinGate.started.promise;
assert.equal(totalCopper(), 80, "The wallet debit should already be applied at the shutdown boundary.");
const firstRetirement = firstService.shutdown();
await assert.rejects(
  firstService.enqueueLocal(payload(firstSession, REQUEST.REQUEST_STATE, {}, "late")),
  /NotReady/,
  "A retiring host must reject new work while allowing the current mutation to finish."
);
joinGate.release.resolve();
await join;
await firstRetirement;

let stored = settings.get("fbl-poker-table.tables");
assert.equal(stored[tableId].seats[0].actorId, actor.id, "Shutdown must wait until a paid join is persisted.");
assert.equal(stored[tableId].seats[0].stack, 20);
assert.equal(totalCopper(), 80);

const secondService = new PokerHostService(socket);
await secondService.initialize();
const secondSession = await sessionFor(secondService);
await assert.rejects(
  secondService.enqueueLocal(payload(secondSession, REQUEST.SET_AUTO_NEXT, { tableId, enabled: "false" }, "bad-boolean")),
  /InvalidRequest/,
  "String booleans from socket payloads must not be coerced."
);
assert.equal(secondService.isBotSeat(tableId, null), false, "Null seat indices must not be coerced to seat zero.");

const cashOutGate = gateNextWalletUpdate();
const cashOut = secondService.enqueueLocal(payload(secondSession, REQUEST.CASH_OUT, {
  tableId,
  seatIndex: 0
}, "cash-out"));
await cashOutGate.started.promise;
assert.equal(totalCopper(), 100, "The wallet credit should already be applied at the shutdown boundary.");
const secondRetirement = secondService.shutdown();
cashOutGate.release.resolve();
await cashOut;
await secondRetirement;

stored = settings.get("fbl-poker-table.tables");
assert.equal(stored[tableId].seats[0], null, "Shutdown must wait until a credited cash-out is persisted.");
assert.equal(totalCopper(), 100);

console.log("Host shutdown drain and strict payload validation tests passed.");

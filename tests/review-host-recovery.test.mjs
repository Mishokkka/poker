import assert from "node:assert/strict";
import { PokerHostService } from "../scripts/network/host-service.js";
import { createTableState, PokerTableEngine } from "../scripts/engine/table-engine.js";
import { MODULE_ID, REQUEST, SCHEMA_VERSION } from "../scripts/constants.js";

const gm = { id: "gm", active: true, isGM: true };
const player = { id: "player", active: true, isGM: false };
const originalError = console.error;
const originalWarn = console.warn;
console.error = console.warn = () => {};
function setPath(object, path, value) {
  const parts = path.split(".");
  let cursor = object;
  for (const key of parts.slice(0, -1)) cursor = cursor[key] ??= {};
  cursor[parts.at(-1)] = structuredClone(value);
}
function fixture({ seated = true } = {}) {
  const state = new PokerTableEngine(createTableState({ id: "t", maxSeats: 3, minBuyIn: 20, maxBuyIn: 200 }));
  if (seated) state.addSeat(0, { actorId: "a", actorName: "A", userId: player.id, stack: 40 });
  const settings = new Map([["tables", { t: state.storageState({ includeHistory: false }) }], ["schemaVersion", SCHEMA_VERSION]]);
  let fault = null;
  let walletFault = null;
  let privateFailure = false;
  let publishFailure = false;
  let updates = 0;
  let owned = true;
  const actor = { id: "a", name: "A", flags: {}, system: { currency: { gold: { value: 10 }, silver: { value: 0 }, copper: { value: 0 } } },
    testUserPermission() { return owned; },
    async update(changes) {
      updates++;
      if (walletFault === "before") throw new Error("wallet before");
      for (const [path, value] of Object.entries(changes)) setPath(this, path, value);
      if (walletFault === "after") throw new Error("wallet response lost");
    } };
  const broadcasts = [];
  globalThis.game = { user: gm, users: { contents: [gm, player], get: id => [gm, player].find(u => u.id === id) },
    actors: { get: id => id === "a" ? actor : null },
    settings: { get: (_m, key) => structuredClone(settings.get(key)), async set(_m, key, value) {
      const matches = fault?.key === key && (!fault.status || Object.values(value).some(e => e.status === fault.status));
      if (matches && fault.phase === "before") { fault = null; throw new Error(`save ${key} before`); }
      settings.set(key, structuredClone(value));
      if (matches) { fault = null; throw new Error(`save ${key} response lost`); }
    } }, i18n: { format: k => k, localize: k => k } };
  globalThis.Hooks = { callAll() {} };
  globalThis.ui = { notifications: { warn() {} } };
  const socket = { async publishSnapshot(tables) { broadcasts.push(structuredClone(tables)); if (publishFailure) throw new Error("publish"); },
    async sendPrivate() { if (privateFailure) throw new Error("private"); } };
  let host;
  let token;
  return { actor, settings, broadcasts,
    get host() { return host; }, get updates() { return updates; },
    balance: () => actor.system.currency.gold.value * 100 + actor.system.currency.silver.value * 10 + actor.system.currency.copper.value,
    fault: value => { fault = value; }, walletFault: value => { walletFault = value; }, owned: value => { owned = value; },
    privateFailure: value => { privateFailure = value; }, publishFailure: value => { publishFailure = value; },
    async start() { if (host) await host.shutdown(); host = new PokerHostService(socket); await host.initialize(); token = (await host.registerSession(gm.id)).token; },
    request(type, data = {}, requestId = crypto.randomUUID()) { return host.enqueueLocal({ userId: gm.id, token, requestId, type, data }); },
    async playerRequest(type, data) { const session = await host.registerSession(player.id); return host.enqueueLocal({ userId: player.id, token: session.token, requestId: crypto.randomUUID(), type, data }); }
  };
}

try {
  // GM funding applies to manual seats and bots alike; ordinary players still pay the full buy-in.
  for (const botLevel of [null, "novice"]) {
    for (const wallet of [0, 17, 100]) {
      const f = fixture({ seated: false });
      f.actor.system.currency.gold.value = 0;
      f.actor.system.currency.copper.value = wallet;
      await f.start();
      const data = { tableId: "t", seatIndex: 0, actorId: "a", buyIn: 40, botLevel };
      if (wallet < 40) {
        await assert.rejects(f.playerRequest(REQUEST.JOIN, { ...data, botLevel: null }), /NotEnoughCurrency/);
        assert.equal(f.updates, 0);
      }
      await f.request(REQUEST.JOIN, data, "gm-seat");
      assert.equal(f.host.tables.get("t").state.seats[0].stack, 40);
      assert.equal(f.host.tables.get("t").state.seats[0].isBot, Boolean(botLevel));
      assert.equal(f.balance(), Math.max(0, wallet - 40));
      const receipt = Object.values(f.host.moneyJournal).find(e => e.requestKey === "gm:gm-seat");
      assert.equal(receipt.subsidyCopper, Math.max(0, 40 - wallet));
      assert.equal(receipt.status, "committed");
      await f.request(REQUEST.JOIN, data, "gm-seat");
      assert.equal(f.updates, 1, "Replaying a GM grant must not issue more chips");
      await f.request(REQUEST.CASH_OUT, { tableId: "t", seatIndex: 0 });
      assert.equal(f.balance(), Math.max(40, wallet), "The granted chips retain their ordinary cash-out value");
      await f.host.shutdown();
    }
  }

  // All commit boundaries: a rejected setting write can also mean a lost response after commit.
  for (const type of [REQUEST.JOIN, REQUEST.TOP_UP, REQUEST.CASH_OUT, REQUEST.DELETE_TABLE]) {
    for (const failure of [
      { key: "moneyJournal", status: "pending", phase: "before" },
      { key: "moneyJournal", status: "pending", phase: "after" },
      { wallet: "before" }, { wallet: "after" },
      { key: "tables", phase: "before" }, { key: "tables", phase: "after" },
      { key: "moneyJournal", status: "committed", phase: "before" },
      { key: "moneyJournal", status: "committed", phase: "after" }
    ]) {
      const f = fixture({ seated: type !== REQUEST.JOIN });
      await f.start();
      const data = { tableId: "t", seatIndex: 0, actorId: "a", buyIn: 40, amount: 10 };
      if (failure.wallet) f.walletFault(failure.wallet); else f.fault(failure);
      await assert.rejects(f.request(type, data, "original"), /RecoveryRequired/);
      assert.equal(f.host.tables.get("t").state.recoveryRequired, true);
      await assert.rejects(f.request(REQUEST.TOP_UP, { tableId: "t", seatIndex: 0, amount: 10 }), /RecoveryRequired/);
      const writes = f.updates;
      const applied = Boolean(f.actor.flags[MODULE_ID]?.moneyTx);
      f.walletFault(null);
      await f.start();
      const pending = Object.values(f.host.moneyJournal).find(e => e.status === "pending");
      if (pending) {
        assert.equal(applied, false, "A matching Actor marker must recover automatically");
        await f.request(REQUEST.RESOLVE_MONEY, { operationId: pending.id, applied: false });
      }
      assert.equal(f.updates, writes, "Recovery must never reapply Actor currency");
      const stack = f.host.tables.get("t").state.seats[0]?.stack ?? 0;
      assert.equal(f.balance() + stack, type === REQUEST.JOIN ? 1000 : 1040, `${type} ${JSON.stringify(failure)} conserves wealth`);
      const durable = Object.values(f.host.moneyJournal).find(e => e.requestKey === "gm:original");
      if (durable?.status === "committed" && type !== REQUEST.DELETE_TABLE) {
        await f.request(type, data, "original");
        assert.equal(f.updates, writes, "Successful financial requests remain idempotent after restart");
      }
      if (type === REQUEST.DELETE_TABLE && applied) {
        await f.request(type, { tableId: "t" });
        assert.equal(f.updates, writes, "Retried deletion must not pay a recovered seat twice");
      }
      await f.host.shutdown();
    }
  }

  // A failure while manually reconciling must keep the table locked too.
  const unresolved = fixture();
  await unresolved.start();
  unresolved.walletFault("before");
  await assert.rejects(unresolved.request(REQUEST.TOP_UP, { tableId: "t", seatIndex: 0, amount: 10 }), /RecoveryRequired/);
  const operation = Object.values(unresolved.host.moneyJournal).find(e => e.status === "pending");
  unresolved.walletFault(null);
  unresolved.fault({ key: "tables", phase: "before" });
  await assert.rejects(unresolved.request(REQUEST.RESOLVE_MONEY, { operationId: operation.id, applied: false }), /RecoveryRequired/);
  assert.equal(unresolved.host.tables.get("t").state.recoveryRequired, true);
  await assert.rejects(unresolved.request(REQUEST.START_HAND, { tableId: "t" }), /RecoveryRequired/);
  await unresolved.request(REQUEST.RESOLVE_MONEY, { operationId: operation.id, applied: false });
  assert.equal(unresolved.host.tables.get("t").state.recoveryRequired, undefined);
  await unresolved.host.shutdown();

  const f = fixture();
  await f.start();
  f.publishFailure(true);
  await f.request(REQUEST.TOP_UP, { tableId: "t", seatIndex: 0, amount: 10 }, "top");
  assert.equal(f.balance(), 990);
  assert.equal(f.host.tables.get("t").state.seats[0].stack, 50);
  await f.request(REQUEST.TOP_UP, { tableId: "t", seatIndex: 0, amount: 10 }, "top");
  assert.equal(f.updates, 1);
  await assert.rejects(f.request(REQUEST.TOP_UP, { tableId: "t", seatIndex: 0, amount: 11 }, "top"), /InvalidRequest/);
  f.publishFailure(false);
  f.owned(false);
  await assert.rejects(f.playerRequest(REQUEST.TOP_UP, { tableId: "t", seatIndex: 0, amount: 10 }), /ActorNotOwned/);
  assert.equal(f.updates, 1);
  await assert.rejects(f.request(REQUEST.CASH_OUT, { tableId: "t", seatIndex: -1 }), /InvalidSeat/);

  const engine = f.host.tables.get("t");
  engine.addSeat(1, { actorId: "b", actorName: "B", userId: player.id, stack: 40 });
  f.privateFailure(true);
  await f.request(REQUEST.START_HAND, { tableId: "t" });
  assert.equal(engine.state.deliveryPending, true);
  assert.equal(engine.state.turnDeadline, null);
  assert.equal(f.host.turnTimers.size, 0);
  assert.equal(f.broadcasts.at(-1)[0].deliveryPending, true);
  assert.equal(engine.legalActions(engine.state.currentSeat), null);
  f.privateFailure(false);
  await f.request(REQUEST.REQUEST_STATE);
  assert.equal(engine.state.deliveryPending, false);
  assert.equal(f.host.turnTimers.size, 1);
  const expected = { handNumber: engine.state.handNumber, status: engine.state.status, revision: engine.state.revision };
  await f.request(REQUEST.ACTION, { tableId: "t", seatIndex: engine.state.currentSeat, action: "call", expected }, "action");
  const revision = engine.state.revision;
  await f.request(REQUEST.ACTION, { tableId: "t", seatIndex: 0, action: "call", expected }, "action");
  assert.equal(engine.state.revision, revision);
  await assert.rejects(f.request(REQUEST.FORCE_RESET, { tableId: "t", expected }), /StaleRequest/);
  await f.request(REQUEST.ACTION, { tableId: "t", seatIndex: engine.state.currentSeat, action: "fold" });
  assert.deepEqual(engine.state.handHistory[0].currencyRates, { gold: 100, silver: 10, copper: 1 });
  // First deferred payout replaces engine.state; a later missing-Actor failure must update the retained seat, not the old snapshot object.
  await f.request(REQUEST.START_HAND, { tableId: "t" });
  await f.request(REQUEST.TOGGLE_LEAVE_AFTER_HAND, { tableId: "t", seatIndex: 0 });
  await f.request(REQUEST.TOGGLE_LEAVE_AFTER_HAND, { tableId: "t", seatIndex: 1 });
  await f.request(REQUEST.ACTION, { tableId: "t", seatIndex: engine.state.currentSeat, action: "fold" });
  assert.equal(engine.state.seats[0], null);
  assert.equal(engine.state.seats[1].leaveAfterHand, false);
  assert.equal(engine.state.seats[1].sittingOut, true);
  await f.host.shutdown();
} finally { console.error = originalError; console.warn = originalWarn; }
console.log("32 monetary fault boundaries, reload/replay, ownership, private delivery and stale commands passed.");

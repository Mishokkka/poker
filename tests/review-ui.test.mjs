import assert from "node:assert/strict";
import { PokerTableEngine, createTableState } from "../scripts/engine/table-engine.js";
import { setPokerSocket } from "../scripts/runtime.js";
import { PokerSoundService } from "../scripts/audio/sound-service.js";

class ApplicationV2 {
  constructor(options) { this.options = options; }
  async _prepareContext() { return {}; }
  render() {}
}
let confirm;
globalThis.foundry = { applications: { api: { ApplicationV2, HandlebarsApplicationMixin: Base => Base, DialogV2: { confirm: () => new Promise(resolve => { confirm = resolve; }) } } } };
globalThis.game = { user: { id: "u", isGM: false }, i18n: { localize: key => key }, settings: { get: () => undefined } };
globalThis.Hooks = { on() {}, off() {} };
globalThis.ui = { notifications: { error() {} } };
const { PokerTableApp } = await import("../scripts/apps/table-app.js");
const { PokerHistoryApp } = await import("../scripts/apps/history-app.js");
const { SeatDialogApp } = await import("../scripts/apps/seat-dialog-app.js");
const engine = new PokerTableEngine(createTableState({ id: "t", maxSeats: 3, minBuyIn: 20, maxBuyIn: 200 }));
engine.addSeat(0, { actorId: "a", actorName: "Original", userId: "u", stack: 100 });
engine.addSeat(1, { actorId: "b", actorName: "Other", userId: "v", stack: 100 });
engine.startHand();
let table = engine.publicState();
let requests = [];
let finish;
const socket = { getTable: () => table, tables: new Map([["t", table]]), getPrivateHand: () => [], isAutomatedSeat: () => false,
  expectedState: () => ({ handNumber: table.handNumber, status: table.status, revision: table.revision }),
  request: (type, data) => { requests.push({ type, data }); return new Promise(resolve => { finish = resolve; }); } };
setPokerSocket(socket);
const app = new PokerTableApp({ tableId: "t" });
let context = await app._prepareContext({});
assert.deepEqual(context.legal, engine.legalActions(0), "UI and engine use identical legal-action rules");
app._raiseDraft.value = "37";
table = { ...table, revision: table.revision + 1, seats: table.seats.map(s => s ? { ...s, leaveAfterHand: true } : null) };
context = await app._prepareContext({});
assert.equal(context.raiseValue, "37", "Unrelated seat flags preserve an entered raise");
app._renderedAction = { expected: context.expected, seatIndex: context.actingSeat.index };
app.element = { querySelectorAll: () => [], querySelector: () => ({ value: "37" }) };
const renderedSeat = context.actingSeat.index;
table = { ...table, currentSeat: 1, revision: table.revision + 1 };
const action = PokerTableApp.pokerAction.call(app, null, { dataset: { actionType: "raise" } });
await PokerTableApp.pokerAction.call(app, null, { dataset: { actionType: "raise" } });
assert.equal(requests.length, 1, "Double click must not submit a second request");
assert.equal(requests[0].data.seatIndex, renderedSeat, "A click targets the seat shown in that render");
assert.equal(requests[0].data.expected.revision, context.expected.revision);
finish(); await action;
assert.equal(app._actionPending, false);
const resetExpected = socket.expectedState();
const resetting = PokerTableApp.forceReset.call(app);
table = { ...table, handNumber: table.handNumber + 1 };
confirm(true);
await Promise.resolve();
assert.deepEqual(requests.at(-1).data.expected, resetExpected, "Reset confirmation cannot apply to a later hand");
finish(); await resetting;

table = { ...table, currentSeat: null, status: "complete", lastResult: { potTotal: 60, awards: [{ seatIndex: 0, actorName: "Original", amount: 30 }] },
  seats: [{ ...table.seats[0], actorName: "Replacement", inHand: false }, null, null],
  log: [{ id: "old", type: "call", actorName: "Original", seatIndex: 0, amount: 10 }],
  handHistory: [{ handNumber: 1, completedAt: 1, participants: [{ seatIndex: 0, actorName: "Original", startingStack: 100, endingStack: 80 }], awards: [{ seatIndex: 0, amount: 30 }] }] };
context = await app._prepareContext({});
assert.equal(context.resultAwards[0].actorName, "Original");
assert.equal(context.logs[0].actorName, "Original");
assert.equal(context.displayedPot, 60);
assert.equal(context.raiseValue, undefined);
const history = await new PokerHistoryApp({ tableId: "t" })._prepareContext({});
assert.equal(history.histories[0].participants[0].delta, -20);
assert.equal(history.histories[0].participants[0].positive, false);

let balanceReads = 0;
const invalid = { id: "bad", name: "Bad", system: { currency: { gold: { get value() { balanceReads++; return "invalid"; } }, silver: { value: 0 }, copper: { value: 0 } } }, testUserPermission: () => true };
const valid = { id: "valid", name: "Valid", system: { currency: { gold: { value: 1 }, silver: { value: 0 }, copper: { value: 0 } } }, testUserPermission: () => true };
game.actors = [invalid, valid];
socket.tables = new Map([["t", table]]);
const seatDialog = new SeatDialogApp({ tableId: "t", seatIndex: 1 });
let seatContext = await seatDialog._prepareContext({});
assert.equal(seatContext.moveMode, true);
assert.equal(seatContext.ownSeatNumber, 1);
assert.equal(balanceReads, 0, "Moving seats must not enumerate unrelated wallets");
game.user.isGM = true;
seatContext = await seatDialog._prepareContext({});
assert.deepEqual(seatContext.actors.map(a => a.id), ["valid"], "One malformed wallet must not break all Actor choices");

let played = 0;
const oldPlay = PokerSoundService.play;
PokerSoundService.play = async () => { played++; };
const controller = new AbortController();
PokerSoundService.playSequence("holeDeal", 4, 1, 5, controller.signal);
controller.abort();
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(played, 0, "Closing or replacing a hand cancels queued sounds");
PokerSoundService.play = oldPlay;
console.log("UI legal actions, drafts, stale clicks/reset, historical names/net, wallet isolation and sound cancellation passed.");

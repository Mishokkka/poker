import assert from "node:assert/strict";

class ApplicationV2 {
  constructor() {}
  _getHeaderControls() { return [{ icon: "close", label: "Close", action: "close" }]; }
}

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2,
      HandlebarsApplicationMixin: (Base) => class extends Base {},
      DialogV2: { confirm: async () => true }
    }
  },
  utils: {}
};
globalThis.game = {
  user: { id: "gm", isGM: true },
  i18n: { localize: (key) => ({
    "FBLPoker.Table.Hand": "Hand",
    "FBLPoker.Fields.Ante": "Ante",
    "FBLPoker.Status.preflop": "Preflop",
    "FBLPoker.Status.flop": "Flop"
  }[key] ?? key) }
};

globalThis.Hooks = { on() {}, off() {} };

const table = {
  id: "table-1",
  name: "Tavern Table",
  paused: false,
  status: "preflop",
  handNumber: 2,
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  handHistory: [{ handNumber: 1 }]
};
const { setPokerSocket } = await import("../scripts/runtime.js");
setPokerSocket({ getTable: () => table });
const { PokerTableApp } = await import("../scripts/apps/table-app.js");
const app = new PokerTableApp({ tableId: table.id });

assert.equal(app.title, "Tavern Table · Preflop · Hand #2 · 1/2");
const titleElement = { textContent: "", title: "" };
const applicationElement = { querySelector: () => titleElement };
app.element = { closest: () => applicationElement };
app._syncWindowTitle();
assert.equal(titleElement.textContent, "Tavern Table · Preflop · Hand #2 · 1/2");
table.status = "flop";
app._syncWindowTitle();
assert.equal(titleElement.textContent, "Tavern Table · Flop · Hand #2 · 1/2", "The visible Foundry title must update when the street changes.");
const actions = app._getHeaderControls().map((control) => control.action);
assert.deepEqual(actions, ["close"], "Header control menu should only keep the native close button; poker actions are injected inline into the title bar at render time.");

console.log("Table header integration test passed.");

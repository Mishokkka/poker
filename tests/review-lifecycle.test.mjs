import assert from "node:assert/strict";

const handlers = new Map();
globalThis.Hooks = {
  once(name, fn) { handlers.set(name, [fn]); },
  on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
  off() {},
  callAll(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args); }
};
class ApplicationV2 {
  constructor() { this.rendered = false; }
  render() { this.rendered = true; return this; }
  bringToFront() {}
  async _onClose() {}
  async close() { await this._onClose({}); this.rendered = false; Hooks.callAll(`close${this.constructor.name}`, this); }
}
globalThis.foundry = { applications: { api: { ApplicationV2, HandlebarsApplicationMixin: Base => Base } } };
const gm = { id: "gm", active: true, isGM: true };
const settings = new Map();
globalThis.game = { user: gm, users: { contents: [gm], get: () => gm }, actors: { get() {} },
  settings: { register(_m, key, data) { settings.set(key, structuredClone(data.default)); }, get: (_m, key) => settings.get(key), async set(_m, key, value) { settings.set(key, structuredClone(value)); } },
  socket: { on() {}, off() {}, emit() {} }, keybindings: { register() {} }, system: { id: "forbidden-lands" },
  i18n: { localize: key => key, format: key => key } };
globalThis.CONFIG = { queries: {} };
globalThis.CONST = {};
globalThis.ui = { notifications: { warn() {}, error() {} } };
await import("../scripts/main.js");
const { getPokerSocket } = await import("../scripts/runtime.js");
const { PokerLobbyApp } = await import("../scripts/apps/lobby-app.js");
await handlers.get("init")[0]();
await handlers.get("ready")[0]();
await game.fblPoker.request(game.fblPoker.REQUEST.CREATE_TABLE, { name: "Lifecycle" });
const tableId = [...game.fblPoker.tables.keys()][0];
const first = game.fblPoker.openTable(tableId);
assert.equal(game.fblPoker.openTable(tableId), first);
PokerLobbyApp.openTable(null, { dataset: { tableId } });
assert.equal(game.fblPoker.openTable(tableId), first, "Lobby and macro must share the same open instance");
await first.close();
const second = game.fblPoker.openTable(tableId);
assert.notEqual(second, first, "Closing removes the instance from the registry");
await second.close();
const service = getPokerSocket().hostService;
gm.active = false;
Hooks.callAll("userConnected", gm, false);
await new Promise(resolve => setTimeout(resolve, 300));
assert.equal(service.stopped, true, "Connectivity alone, without updateUser, retires the former host");
await getPokerSocket().shutdown();
console.log("Connection lifecycle and shared table-window registry passed.");

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value) => Buffer.from(value, "base64").toString("binary");

const gm = { id: "gm", active: true, isGM: true };
let listener = null;
let removed = null;

globalThis.game = {
  user: gm,
  users: { contents: [gm], get: (id) => id === gm.id ? gm : null },
  settings: { get: (_moduleId, key) => key === "tables" ? {} : 4 },
  socket: {
    on: (_channel, fn) => { listener = fn; },
    off: (_channel, fn) => { removed = fn; },
    emit() {}
  },
  i18n: { localize: (key) => key, format: (key) => key },
  modules: { get: () => ({ title: "Poker" }) }
};
globalThis.Hooks = { callAll() {} };
globalThis.ui = { notifications: { error() {}, warn() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };

let releaseInitialization;
const initializationGate = new Promise((resolve) => { releaseInitialization = resolve; });
let service = null;

class DeferredHostService {
  constructor() {
    this.shutdownCalls = 0;
    this.sessions = new Map();
  }

  async initialize() {
    await initializationGate;
  }

  shutdown() {
    this.shutdownCalls += 1;
  }
}

const { PokerSocket } = await import("../scripts/network/socket.js");
const socket = new PokerSocket({
  hostServiceFactory: () => {
    service = new DeferredHostService();
    return service;
  }
});

const initialization = socket.initialize();
while (!service) await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(listener);

socket.shutdown();
releaseInitialization();
await initialization;

assert.equal(socket.hostService, null, "A service that finishes initializing after shutdown must not become active.");
assert.ok(service.shutdownCalls >= 1, "The pending service must be shut down.");
assert.equal(removed, listener, "Shutdown must remove the socket listener even during host initialization.");

console.log("Socket host lifecycle cancellation test passed.");

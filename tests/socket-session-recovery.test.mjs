import assert from "node:assert/strict";

Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: {
    getRandomValues(array) {
      for (let index = 0; index < array.length; index += 1) array[index] = (index * 13 + 7) & 0xff;
      return array;
    }
  }
});

const player = { id: "player", active: true, isGM: false };
let socket = null;
let provisionCount = 0;
let staleRejectCount = 0;
let acceptedCount = 0;
const staleToken = "session-stale";
const freshToken = "session-fresh";

const gm = {
  id: "gm",
  active: true,
  isGM: true,
  async query(_name, payload) {
    if (payload.kind === "provisionSessions") {
      provisionCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const delivered = await socket.handleQuery({
        kind: "sessionDelivery", epoch: 1,
        hostUserId: gm.id,
        userId: player.id,
        token: freshToken
      });
      assert.equal(delivered.ok, true);
      return { ok: true, hostUserId: gm.id };
    }

    if (payload.kind === "request") {
      if (payload.token === staleToken) {
        staleRejectCount += 1;
        await Promise.resolve();
        return { ok: false, message: "FBLPoker.Errors.InvalidSession" };
      }
      assert.equal(payload.token, freshToken);
      acceptedCount += 1;
      return { ok: true, value: true };
    }

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
  socket: { on() {}, off() {}, emit() {} },
  i18n: { localize: (key) => key, format: (key) => key },
  modules: { get: () => ({ title: "Poker" }) }
};
globalThis.Hooks = { callAll() {} };
globalThis.ui = { notifications: { error() {} } };
globalThis.foundry = { utils: { deepClone: structuredClone } };

const { PokerSocket } = await import("../scripts/network/socket.js");
const { REQUEST } = await import("../scripts/constants.js");
socket = new PokerSocket();

try {
  await socket.initialize();

  const staleDelivery = await socket.handleQuery({
    kind: "sessionDelivery", epoch: 1,
    hostUserId: gm.id,
    userId: player.id,
    token: staleToken
  });
  assert.equal(staleDelivery.ok, true);
  assert.equal(socket.sessionToken, staleToken);

  await Promise.all([
    socket.request(REQUEST.REQUEST_STATE),
    socket.request(REQUEST.REQUEST_STATE),
    socket.request(REQUEST.REQUEST_STATE),
    socket.request(REQUEST.REQUEST_STATE)
  ]);

  assert.equal(staleRejectCount, 4, "All requests already in flight may observe the stale token once.");
  assert.equal(provisionCount, 1, "Concurrent stale-session recovery must share one provisioning handshake.");
  assert.equal(acceptedCount, 4, "Every rejected request must retry once with the fresh session token.");
  assert.equal(socket.sessionToken, freshToken);
} finally {
  await socket.shutdown();
}

console.log("Stale targeted-query session recovery test passed.");

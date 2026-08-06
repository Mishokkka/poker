import assert from "node:assert/strict";

Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: {
    getRandomValues(array) {
      for (let index = 0; index < array.length; index += 1) array[index] = (index * 31 + 7) & 0xff;
      return array;
    }
  }
});

globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value) => Buffer.from(value, "base64").toString("binary");

const { SessionCrypto } = await import("../scripts/network/crypto.js");
const sender = new SessionCrypto();
const receiver = new SessionCrypto();
await sender.initialize();
await receiver.initialize();

assert.equal(sender.secure, false);
assert.equal(sender.publicKey.mode, "plain");
const payload = await sender.encrypt(receiver.publicKey, { kind: "session", token: "test" });
assert.deepEqual(payload, { plain: { kind: "session", token: "test" } });
assert.deepEqual(await receiver.decrypt(sender.publicKey, payload), { kind: "session", token: "test" });

console.log("HTTP compatibility transport test passed.");

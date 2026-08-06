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
const session = new SessionCrypto();

await assert.rejects(
  session.initialize(),
  /PrivateTransportUnavailable/,
  "Private poker transport must fail closed when Web Crypto is unavailable."
);
assert.equal(session.secure, false);
assert.equal(session.publicKey, null);

console.log("Fail-closed private transport test passed.");

import assert from "node:assert/strict";

const settings = new Map([
  ["fbl-poker-table.goldCopperRate", 100],
  ["fbl-poker-table.silverCopperRate", 10]
]);
globalThis.game = {
  settings: { get: (moduleId, key) => settings.get(`${moduleId}.${key}`) }
};

const actor = {
  system: { currency: { gold: { value: 1 }, silver: { value: 2 }, copper: { value: 3 } } },
  updates: 0,
  async update(changes) {
    this.updates += 1;
    this.system.currency.gold.value = changes["system.currency.gold.value"];
    this.system.currency.silver.value = changes["system.currency.silver.value"];
    this.system.currency.copper.value = changes["system.currency.copper.value"];
  }
};

const { CurrencyAdapter } = await import("../scripts/economy/fbl-currency.js");
const currency = new CurrencyAdapter();
assert.deepEqual(currency.balance(actor), { gold: 1, silver: 2, copper: 3, totalCopper: 123 });

await assert.rejects(currency.change(actor, Number.NaN), /InvalidCurrencyChange/);
await assert.rejects(currency.change(actor, Number.POSITIVE_INFINITY), /InvalidCurrencyChange/);
await assert.rejects(currency.change(actor, 1.5), /InvalidCurrencyChange/);
assert.equal(actor.updates, 0, "Invalid deltas must not update the Actor document.");

const transaction = await currency.change(actor, -13);
assert.equal(transaction.deltaCopper, -13);
assert.deepEqual(transaction.after, { gold: 1, silver: 1, copper: 0, totalCopper: 110 });
assert.equal(actor.updates, 1);

assert.throws(() => currency.denominations(Number.NaN), /InvalidCurrencyChange/);
assert.throws(() => currency.denominations(1.5), /InvalidCurrencyChange/, "Fractional copper totals must not be truncated.");
assert.equal(currency.supports({ system: { currency: {} } }), false);
console.log("Currency validation test passed.");

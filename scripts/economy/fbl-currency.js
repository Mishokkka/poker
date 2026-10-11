import { MODULE_ID } from "../constants.js";
import { getProperty } from "../util.js";

const PATHS = Object.freeze({
  gold: "system.currency.gold.value",
  silver: "system.currency.silver.value",
  copper: "system.currency.copper.value"
});

function numericInput(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return Number.NaN;
}

function nonNegativeCurrencyInteger(value) {
  const number = numericInput(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("FBLPoker.Errors.InvalidCurrencyChange");
  return number;
}

function positiveRate(value, fallback) {
  const number = numericInput(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export class CurrencyAdapter {
  get rates() {
    return {
      gold: positiveRate(game.settings.get(MODULE_ID, "goldCopperRate"), 100),
      silver: positiveRate(game.settings.get(MODULE_ID, "silverCopperRate"), 10),
      copper: 1
    };
  }

  supports(actor) {
    return actor && Object.values(PATHS).every((path) => getProperty(actor, path) !== undefined);
  }

  balance(actor) {
    if (!this.supports(actor)) throw new Error("FBLPoker.Errors.UnsupportedCurrency");
    const rates = this.rates;
    const gold = nonNegativeCurrencyInteger(getProperty(actor, PATHS.gold));
    const silver = nonNegativeCurrencyInteger(getProperty(actor, PATHS.silver));
    const copper = nonNegativeCurrencyInteger(getProperty(actor, PATHS.copper));
    const totalCopper = (gold * rates.gold) + (silver * rates.silver) + copper;
    if (!Number.isSafeInteger(totalCopper)) throw new Error("FBLPoker.Errors.InvalidCurrencyChange");
    return { gold, silver, copper, totalCopper };
  }

  denominations(totalCopper) {
    const total = numericInput(totalCopper);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error("FBLPoker.Errors.InvalidCurrencyChange");
    const rates = this.rates;
    let remaining = total;
    const gold = Math.floor(remaining / rates.gold);
    remaining -= gold * rates.gold;
    const silver = Math.floor(remaining / rates.silver);
    remaining -= silver * rates.silver;
    return { gold, silver, copper: remaining };
  }

  async change(actor, deltaCopper, metadata = {}) {
    const delta = numericInput(deltaCopper);
    if (!Number.isSafeInteger(delta)) throw new Error("FBLPoker.Errors.InvalidCurrencyChange");

    const before = this.balance(actor);
    if (metadata.expectedBefore !== undefined && before.totalCopper !== metadata.expectedBefore) {
      throw new Error("FBLPoker.Errors.CurrencyChanged");
    }
    const afterTotal = before.totalCopper + delta;
    if (!Number.isSafeInteger(afterTotal)) throw new Error("FBLPoker.Errors.InvalidCurrencyChange");
    if (afterTotal < 0) throw new Error("FBLPoker.Errors.NotEnoughCurrency");

    const after = this.denominations(afterTotal);
    await actor.update({
      [PATHS.gold]: after.gold,
      [PATHS.silver]: after.silver,
      [PATHS.copper]: after.copper,
      ...(metadata.transactionId ? { [`flags.${MODULE_ID}.moneyTx`]: { id: metadata.transactionId, before: before.totalCopper, after: afterTotal } } : {})
    }, { fblPoker: metadata });
    return { before, after: { ...after, totalCopper: afterTotal }, deltaCopper: delta };
  }

  actorOwnedBy(actor, user) {
    if (!actor || !user) return false;
    if (user.isGM) return true;
    const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (typeof actor.testUserPermission === "function") return actor.testUserPermission(user, ownerLevel);
    return Number(actor.ownership?.[user.id] ?? actor.permission?.[user.id] ?? 0) >= ownerLevel;
  }
}

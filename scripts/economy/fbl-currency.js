import { MODULE_ID } from "../constants.js";
import { getProperty } from "../util.js";

const PATHS = Object.freeze({
  gold: "system.currency.gold.value",
  silver: "system.currency.silver.value",
  copper: "system.currency.copper.value"
});

function finiteNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.trunc(number));
}

function positiveRate(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
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
    const gold = finiteNonNegativeInteger(getProperty(actor, PATHS.gold));
    const silver = finiteNonNegativeInteger(getProperty(actor, PATHS.silver));
    const copper = finiteNonNegativeInteger(getProperty(actor, PATHS.copper));
    const totalCopper = (gold * rates.gold) + (silver * rates.silver) + copper;
    if (!Number.isSafeInteger(totalCopper)) throw new Error("FBLPoker.Errors.InvalidCurrencyChange");
    return { gold, silver, copper, totalCopper };
  }

  denominations(totalCopper) {
    const total = Math.trunc(Number(totalCopper));
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
    const delta = Number(deltaCopper);
    if (!Number.isSafeInteger(delta)) throw new Error("FBLPoker.Errors.InvalidCurrencyChange");

    const before = this.balance(actor);
    const afterTotal = before.totalCopper + delta;
    if (!Number.isSafeInteger(afterTotal)) throw new Error("FBLPoker.Errors.InvalidCurrencyChange");
    if (afterTotal < 0) throw new Error("FBLPoker.Errors.NotEnoughCurrency");

    const after = this.denominations(afterTotal);
    await actor.update({
      [PATHS.gold]: after.gold,
      [PATHS.silver]: after.silver,
      [PATHS.copper]: after.copper
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

import { MODULE_ID } from "../constants.js";
import { getProperty } from "../util.js";

const PATHS = Object.freeze({
  gold: "system.currency.gold.value",
  silver: "system.currency.silver.value",
  copper: "system.currency.copper.value"
});

export class CurrencyAdapter {
  get rates() {
    return {
      gold: Math.max(1, Number(game.settings.get(MODULE_ID, "goldCopperRate")) || 100),
      silver: Math.max(1, Number(game.settings.get(MODULE_ID, "silverCopperRate")) || 10),
      copper: 1
    };
  }

  supports(actor) {
    return actor && Object.values(PATHS).every((path) => getProperty(actor, path) !== undefined);
  }

  balance(actor) {
    if (!this.supports(actor)) throw new Error("FBLPoker.Errors.UnsupportedCurrency");
    const rates = this.rates;
    return {
      gold: Math.max(0, Number(getProperty(actor, PATHS.gold)) || 0),
      silver: Math.max(0, Number(getProperty(actor, PATHS.silver)) || 0),
      copper: Math.max(0, Number(getProperty(actor, PATHS.copper)) || 0),
      totalCopper:
        (Math.max(0, Number(getProperty(actor, PATHS.gold)) || 0) * rates.gold) +
        (Math.max(0, Number(getProperty(actor, PATHS.silver)) || 0) * rates.silver) +
        Math.max(0, Number(getProperty(actor, PATHS.copper)) || 0)
    };
  }

  denominations(totalCopper) {
    const rates = this.rates;
    let remaining = Math.max(0, Math.trunc(totalCopper));
    const gold = Math.floor(remaining / rates.gold);
    remaining -= gold * rates.gold;
    const silver = Math.floor(remaining / rates.silver);
    remaining -= silver * rates.silver;
    return { gold, silver, copper: remaining };
  }

  async change(actor, deltaCopper, metadata = {}) {
    const before = this.balance(actor);
    const afterTotal = before.totalCopper + Math.trunc(deltaCopper);
    if (afterTotal < 0) throw new Error("FBLPoker.Errors.NotEnoughCurrency");
    const after = this.denominations(afterTotal);
    await actor.update({
      [PATHS.gold]: after.gold,
      [PATHS.silver]: after.silver,
      [PATHS.copper]: after.copper
    }, { fblPoker: metadata });
    return { before, after: { ...after, totalCopper: afterTotal }, deltaCopper: Math.trunc(deltaCopper) };
  }

  actorOwnedBy(actor, user) {
    if (!actor || !user) return false;
    if (user.isGM) return true;
    const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (typeof actor.testUserPermission === "function") return actor.testUserPermission(user, ownerLevel);
    return Number(actor.ownership?.[user.id] ?? actor.permission?.[user.id] ?? 0) >= ownerLevel;
  }
}

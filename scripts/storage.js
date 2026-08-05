import { MODULE_ID } from "./constants.js";

export class PokerStorage {
  async loadTables() {
    const stored = game.settings.get(MODULE_ID, "tables");
    return stored && typeof stored === "object" ? stored : {};
  }

  async saveTables(tables) {
    await game.settings.set(MODULE_ID, "tables", tables);
  }

  async appendLedger(entry) {
    const ledger = [...(game.settings.get(MODULE_ID, "ledger") ?? [])];
    ledger.unshift(entry);
    await game.settings.set(MODULE_ID, "ledger", ledger.slice(0, 500));
  }

  getLedger() {
    return [...(game.settings.get(MODULE_ID, "ledger") ?? [])];
  }
}

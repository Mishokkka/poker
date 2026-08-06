import { REQUEST } from "../constants.js";
import { normalizeTableConfiguration } from "../engine/table-engine.js";
import { getPokerSocket } from "../runtime.js";
import { notifyError } from "../util.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class TableSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["fbl-poker", "fbl-poker-create", "fbl-poker-table-settings"],
    tag: "form",
    position: { width: 520, height: "auto" },
    window: {
      contentClasses: ["fbl-poker-content"],
      title: "FBLPoker.Edit.Title",
      icon: "fa-solid fa-sliders",
      resizable: false
    },
    actions: {
      submitTable: TableSettingsApp.submitTable
    }
  };

  static PARTS = {
    body: { template: "modules/fbl-poker-table/templates/table-settings.hbs" }
  };

  constructor({ tableId, ...options } = {}) {
    super({ id: `fbl-poker-table-settings-${tableId}`, ...options });
    this.tableId = tableId;
  }

  get title() {
    const table = getPokerSocket().getTable(this.tableId);
    return `${game.i18n.localize("FBLPoker.Edit.Title")}: ${table?.name ?? ""}`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const table = getPokerSocket().getTable(this.tableId);
    if (!table) return { missing: true };
    return {
      ...context,
      missing: false,
      table,
      hasSeats: table.seats.some(Boolean)
    };
  }

  static async submitTable(event) {
    event.preventDefault();
    try {
      const form = this.form ?? this.element;
      if (typeof form.reportValidity === "function" && !form.reportValidity()) return;
      const formData = new FormData(form);
      const data = Object.fromEntries(formData.entries());
      for (const key of ["maxSeats", "smallBlind", "bigBlind", "ante", "minBuyIn", "maxBuyIn", "actionSeconds", "chipValueCopper", "autoNextHandSeconds"]) {
        data[key] = Number(data[key]);
      }
      data.autoNextHand = formData.has("autoNextHand");
      data.name = String(data.name ?? "").trim();
      const table = getPokerSocket().getTable(this.tableId);
      const normalized = normalizeTableConfiguration(data, table);
      await getPokerSocket().request(REQUEST.UPDATE_TABLE, { ...normalized, tableId: this.tableId });
      await this.close();
    } catch (error) {
      notifyError(error);
    }
  }
}

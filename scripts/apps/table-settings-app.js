import { REQUEST } from "../constants.js";
import { normalizeTableConfiguration } from "../engine/table-engine.js";
import { getPokerSocket } from "../runtime.js";
import { notifyError, parseStrictInteger } from "../util.js";

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
    this._expected = table ? { handNumber: table.handNumber, status: table.status, revision: table.revision } : undefined;
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
      const numericFields = {
        maxSeats: "FBLPoker.Errors.SeatCountRange",
        smallBlind: "FBLPoker.Errors.BlindOrder",
        bigBlind: "FBLPoker.Errors.BlindOrder",
        ante: "FBLPoker.Errors.InvalidAnte",
        minBuyIn: "FBLPoker.Errors.BuyInOrder",
        maxBuyIn: "FBLPoker.Errors.BuyInOrder",
        actionSeconds: "FBLPoker.Errors.ActionTimeRange",
        chipValueCopper: "FBLPoker.Errors.InvalidChipValue",
        autoNextHandSeconds: "FBLPoker.Errors.AutoNextTimeRange"
      };
      for (const [key, errorKey] of Object.entries(numericFields)) {
        data[key] = parseStrictInteger(data[key], errorKey);
      }
      data.autoNextHand = formData.has("autoNextHand");
      data.name = String(data.name ?? "").trim();
      const table = getPokerSocket().getTable(this.tableId);
      const normalized = normalizeTableConfiguration(data, table);
      await getPokerSocket().request(REQUEST.UPDATE_TABLE, { ...normalized, tableId: this.tableId, expected: this._expected });
      await this.close();
    } catch (error) {
      notifyError(error);
    }
  }
}

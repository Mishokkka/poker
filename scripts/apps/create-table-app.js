import { DEFAULT_TABLE, REQUEST } from "../constants.js";
import { normalizeTableConfiguration } from "../engine/table-engine.js";
import { getPokerSocket } from "../runtime.js";
import { notifyError, parseStrictInteger } from "../util.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class CreateTableApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "fbl-poker-create-table",
    classes: ["fbl-poker", "fbl-poker-create"],
    tag: "form",
    position: { width: 520, height: "auto" },
    window: {
      contentClasses: ["fbl-poker-content"],
      title: "FBLPoker.Create.Title",
      icon: "fa-solid fa-circle-plus",
      resizable: false
    },
    actions: {
      submitTable: CreateTableApp.submitTable
    }
  };

  static PARTS = {
    body: { template: "modules/fbl-poker-table/templates/create-table.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.defaults = DEFAULT_TABLE;
    return context;
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
      const normalized = normalizeTableConfiguration(data, { ...DEFAULT_TABLE, name: data.name });
      await getPokerSocket().request(REQUEST.CREATE_TABLE, normalized);
      await this.close();
    } catch (error) {
      notifyError(error);
    }
  }
}

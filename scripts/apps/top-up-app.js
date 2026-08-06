import { REQUEST } from "../constants.js";
import { CurrencyAdapter } from "../economy/fbl-currency.js";
import { getPokerSocket } from "../runtime.js";
import { notifyError, parseStrictInteger } from "../util.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const currency = new CurrencyAdapter();

export class TopUpApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["fbl-poker", "fbl-poker-top-up"],
    tag: "form",
    position: { width: 410, height: "auto" },
    window: {
      contentClasses: ["fbl-poker-content"],
      title: "FBLPoker.TopUp.Title",
      icon: "fa-solid fa-coins",
      resizable: false
    },
    actions: {
      submitTopUp: TopUpApp.submitTopUp,
      fillTopUp: TopUpApp.fillTopUp
    }
  };

  static PARTS = {
    body: { template: "modules/fbl-poker-table/templates/top-up.hbs" }
  };

  constructor({ tableId, seatIndex, ...options } = {}) {
    super({ id: `fbl-poker-top-up-${tableId}-${seatIndex}`, ...options });
    this.tableId = tableId;
    this.seatIndex = Number(seatIndex);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const table = getPokerSocket().getTable(this.tableId);
    const seat = table?.seats?.[this.seatIndex];
    const actor = seat ? game.actors.get(seat.actorId) : null;
    if (!table || !seat || !actor) return { ...context, missing: true, unsupportedCurrency: false };
    if (!currency.supports(actor)) return { ...context, missing: true, unsupportedCurrency: true };

    const balance = currency.balance(actor);
    const stackRoom = Math.max(0, table.maxBuyIn - seat.stack);
    const affordable = Math.floor(balance.totalCopper / table.chipValueCopper);
    const maximum = Math.max(0, Math.min(stackRoom, affordable));
    const suggested = Math.min(maximum, Math.max(1, Math.min(table.bigBlind * 50, table.maxBuyIn - seat.stack)));

    return {
      ...context,
      missing: false,
      table,
      seat,
      actor,
      balance,
      maximum,
      suggested,
      canSubmit: maximum > 0,
      costMaximum: maximum * table.chipValueCopper
    };
  }

  static fillTopUp(_event, target) {
    const input = this.element.querySelector('[name="amount"]');
    if (input) input.value = target.dataset.amount;
  }

  static async submitTopUp(event) {
    event.preventDefault();
    try {
      const form = this.form ?? this.element;
      if (typeof form.reportValidity === "function" && !form.reportValidity()) return;
      const amount = parseStrictInteger(new FormData(form).get("amount"), "FBLPoker.Errors.InvalidTopUp");
      await getPokerSocket().request(REQUEST.TOP_UP, {
        tableId: this.tableId,
        seatIndex: this.seatIndex,
        amount
      });
      await this.close();
    } catch (error) {
      notifyError(error);
    }
  }
}

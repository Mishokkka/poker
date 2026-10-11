import { BOT_LEVELS, BOT_PERSONALITIES, REQUEST } from "../constants.js";
import { CurrencyAdapter } from "../economy/fbl-currency.js";
import { getPokerSocket } from "../runtime.js";
import { notifyError, parseStrictInteger } from "../util.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const currency = new CurrencyAdapter();

export class SeatDialogApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["fbl-poker", "fbl-poker-seat-dialog"],
    tag: "form",
    position: { width: 420, height: "auto" },
    window: {
      contentClasses: ["fbl-poker-content"],
      title: "FBLPoker.SeatDialog.Title",
      icon: "fa-solid fa-chair",
      resizable: false
    },
    actions: {
      confirmSeat: SeatDialogApp.confirmSeat
    }
  };

  static PARTS = {
    body: { template: "modules/fbl-poker-table/templates/seat-dialog.hbs" }
  };

  constructor({ tableId, seatIndex, ...options } = {}) {
    super({ id: `fbl-poker-seat-dialog-${tableId}-${seatIndex}`, ...options });
    this.tableId = tableId;
    this.seatIndex = Number(seatIndex);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const socket = getPokerSocket();
    const table = socket.getTable(this.tableId);
    this._expected = table ? { handNumber: table.handNumber, status: table.status, revision: table.revision } : undefined;
    if (!table) return { ...context, missing: true };

    const allSeats = [...socket.tables.values()].flatMap((candidate) =>
      (candidate.seats ?? []).filter(Boolean).map((seat) => ({ ...seat, tableId: candidate.id, tableName: candidate.name }))
    );
    const ownSeats = allSeats.filter((seat) => seat.userId === game.user.id);
    const ownSeatHere = ownSeats.find((seat) => seat.tableId === this.tableId) ?? null;
    const occupiedActorIds = new Set(allSeats.map((seat) => seat.actorId));
    const blockedElsewhere = !game.user.isGM && ownSeats.length > 0 && !ownSeatHere;
    const moveMode = !game.user.isGM && Boolean(ownSeatHere);

    const actors = (moveMode || blockedElsewhere ? [] : game.actors.contents ?? game.actors)
      .filter((actor) => currency.actorOwnedBy(actor, game.user) && currency.supports(actor) && !occupiedActorIds.has(actor.id))
      .flatMap((actor) => {
        try {
          const balance = currency.balance(actor);
          return [{ id: actor.id, name: actor.name, img: actor.img, balance: balance.totalCopper }];
        } catch { return []; }
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    Object.assign(context, {
      missing: false,
      table,
      seatIndex: this.seatIndex,
      seatNumber: this.seatIndex + 1,
      actors,
      isGM: game.user.isGM,
      botLevels: [
        { value: BOT_LEVELS.NOVICE, label: game.i18n.localize("FBLPoker.Bots.Levels.novice") },
        { value: BOT_LEVELS.EXPERIENCED, label: game.i18n.localize("FBLPoker.Bots.Levels.experienced") },
        { value: BOT_LEVELS.EXPERT, label: game.i18n.localize("FBLPoker.Bots.Levels.expert") }
      ],
      botPersonalities: [
        { value: BOT_PERSONALITIES.CALM, label: game.i18n.localize("FBLPoker.Bots.Personalities.calm") },
        { value: BOT_PERSONALITIES.RISKY, label: game.i18n.localize("FBLPoker.Bots.Personalities.risky") },
        { value: BOT_PERSONALITIES.RECKLESS, label: game.i18n.localize("FBLPoker.Bots.Personalities.reckless") }
      ],
      moveMode,
      ownSeat: ownSeatHere,
      ownSeatNumber: ownSeatHere ? ownSeatHere.index + 1 : null,
      blockedElsewhere,
      blockingSeat: blockedElsewhere ? ownSeats[0] : null,
      canConfirm: moveMode || (!blockedElsewhere && actors.length > 0),
      defaultBuyIn: Math.min(table.maxBuyIn, Math.max(table.minBuyIn, table.bigBlind * 50))
    });
    return context;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const controller = this.element?.querySelector?.('[name="botLevel"]');
    const personality = this.element?.querySelector?.('[data-bot-personality]');
    if (!controller || !personality) return;
    const sync = () => { personality.hidden = !controller.value; };
    controller.addEventListener("change", sync);
    sync();
  }

  static async confirmSeat(event) {
    event.preventDefault();
    try {
      const form = this.form ?? this.element;
      if (typeof form.reportValidity === "function" && !form.reportValidity()) return;
      const table = getPokerSocket().getTable(this.tableId);
      if (!table) throw new Error("FBLPoker.Errors.TableMissing");
      const ownSeat = table.seats.find((seat) => seat?.userId === game.user.id) ?? null;

      if (!game.user.isGM && ownSeat) {
        await getPokerSocket().request(REQUEST.MOVE_SEAT, {
          tableId: this.tableId,
        expected: this._expected,
          fromSeatIndex: ownSeat.index,
          toSeatIndex: this.seatIndex
        });
      } else {
        const actorId = form.querySelector('[name="actorId"]')?.value;
        const buyIn = parseStrictInteger(form.querySelector('[name="buyIn"]')?.value, "FBLPoker.Errors.BuyInRange");
        const botLevel = game.user.isGM ? (form.querySelector('[name="botLevel"]')?.value || null) : null;
        const botPersonality = botLevel ? (form.querySelector('[name="botPersonality"]')?.value || BOT_PERSONALITIES.CALM) : null;
        if (!actorId) throw new Error("FBLPoker.Errors.SelectActor");
        await getPokerSocket().request(REQUEST.JOIN, {
          tableId: this.tableId,
        expected: this._expected,
          seatIndex: this.seatIndex,
          actorId,
          buyIn,
          botLevel,
          botPersonality
        });
      }
      await this.close();
    } catch (error) {
      notifyError(error);
    }
  }
}

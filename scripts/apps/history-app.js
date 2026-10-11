import { cardDisplay } from "../engine/cards.js";
import { getPokerSocket } from "../runtime.js";
import { downloadTextFile } from "../util.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function cardView(card) {
  return { ...cardDisplay(card), code: card };
}

function localizedAction(type) {
  const logKey = `FBLPoker.Log.${type}`;
  const logText = game.i18n.localize(logKey);
  if (logText !== logKey) return logText;
  const actionKey = `FBLPoker.Actions.${type}`;
  const actionText = game.i18n.localize(actionKey);
  return actionText === actionKey ? type : actionText;
}

export class PokerHistoryApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["fbl-poker", "fbl-poker-history-app"],
    position: { width: 720, height: 700 },
    window: {
      contentClasses: ["fbl-poker-content"],
      title: "FBLPoker.History.Title",
      icon: "fa-solid fa-clock-rotate-left",
      resizable: true
    },
    actions: {
      exportHistory: PokerHistoryApp.exportHistory
    }
  };

  static PARTS = {
    body: { template: "modules/fbl-poker-table/templates/history.hbs", scrollable: [".fbl-poker-history-list"] }
  };

  constructor({ tableId, ...options } = {}) {
    super({ id: `fbl-poker-history-${tableId}`, ...options });
    this.tableId = tableId;
    this._stateHook = (_tables, changes) => {
      if (changes?.historyChangedTableIds && !changes.historyChangedTableIds.has(this.tableId) && !changes.deletedTableIds?.has(this.tableId)) return;
      this.render();
    };
  }

  get title() {
    const table = getPokerSocket().getTable(this.tableId);
    return `${game.i18n.localize("FBLPoker.History.Title")}: ${table?.name ?? ""}`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const table = getPokerSocket().getTable(this.tableId);
    if (!table) return { ...context, missing: true };

    const histories = (table.handHistory ?? []).map((hand) => {
      const names = new Map((hand.participants ?? []).map((participant) => [participant.seatIndex, participant.actorName]));
      return {
        ...hand,
        completedLabel: new Date(hand.completedAt).toLocaleString(),
        communityCards: (hand.community ?? []).map(cardView),
        participants: (hand.participants ?? []).map((participant) => ({
          ...participant,
          cardsView: (participant.cards ?? []).map(cardView),
          delta: participant.endingStack - participant.startingStack,
          positive: participant.endingStack > participant.startingStack,
          won: (hand.awards ?? []).some((award) => award.seatIndex === participant.seatIndex)
        })),
        awards: (hand.awards ?? []).map((award) => ({
          ...award,
          categoryLabel: award.categoryName ? game.i18n.localize(`FBLPoker.Hands.${award.categoryName}`) : ""
        })),
        actions: (hand.actions ?? []).map((action) => ({
          ...action,
          actorName: action.seatIndex === null ? "" : (names.get(action.seatIndex) ?? ""),
          text: localizedAction(action.type) + (action.type === "street" && typeof action.amount === "string" ? `: ${game.i18n.localize(`FBLPoker.Status.${action.amount}`)}` : "")
        }))
      };
    });

    return {
      ...context,
      missing: false,
      table,
      histories,
      hasHistory: histories.length > 0
    };
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    Hooks.on("fblPokerStateUpdated", this._stateHook);
  }

  async _onClose(options) {
    Hooks.off("fblPokerStateUpdated", this._stateHook);
    await super._onClose(options);
  }

  static exportHistory() {
    const table = getPokerSocket().getTable(this.tableId);
    if (!table) return;
    const safeName = String(table.name).replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "poker-table";
    const payload = {
      module: "fbl-poker-table",
      exportedAt: new Date().toISOString(),
      table: {
        id: table.id,
        name: table.name,
        smallBlind: table.smallBlind,
        bigBlind: table.bigBlind,
        ante: table.ante,
        chipValueCopper: table.chipValueCopper
      },
      hands: table.handHistory ?? []
    };
    downloadTextFile(`${safeName}-hands.json`, JSON.stringify(payload, null, 2));
  }
}

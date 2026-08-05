import { REQUEST } from "../constants.js";
import { getPokerSocket } from "../runtime.js";
import { notifyError } from "../util.js";
import { CreateTableApp } from "./create-table-app.js";
import { PokerTableApp } from "./table-app.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PokerLobbyApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "fbl-poker-lobby",
    classes: ["fbl-poker", "fbl-poker-lobby"],
    position: { width: 760, height: 620 },
    window: {
      contentClasses: ["fbl-poker-content"],
      title: "FBLPoker.Lobby.Title",
      icon: "fa-solid fa-spade",
      resizable: true
    },
    actions: {
      createTable: PokerLobbyApp.createTable,
      openTable: PokerLobbyApp.openTable,
      deleteTable: PokerLobbyApp.deleteTable,
      refresh: PokerLobbyApp.refresh
    }
  };

  static PARTS = {
    body: { template: "modules/fbl-poker-table/templates/lobby.hbs", scrollable: [".fbl-poker-table-list"] }
  };

  constructor(options = {}) {
    super(options);
    this._stateHook = () => this.render();
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.isGM = game.user.isGM;
    context.hasHost = Boolean(game.users.find((user) => user.active && user.isGM));
    context.tables = [...getPokerSocket().tables.values()].map((table) => ({
      ...table,
      occupied: table.seats.filter(Boolean).length,
      statusLabel: game.i18n.localize(`FBLPoker.Status.${table.status}`)
    }));
    return context;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    Hooks.on("fblPokerStateUpdated", this._stateHook);
  }

  async _onClose(options) {
    Hooks.off("fblPokerStateUpdated", this._stateHook);
    await super._onClose(options);
  }

  static createTable() {
    new CreateTableApp().render({ force: true });
  }

  static openTable(_event, target) {
    new PokerTableApp({ tableId: target.dataset.tableId }).render({ force: true });
  }

  static async deleteTable(_event, target) {
    try {
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "FBLPoker.Delete.Title" },
        content: `<p>${game.i18n.localize("FBLPoker.Delete.Confirm")}</p>`,
        modal: true
      });
      if (confirmed) await getPokerSocket().request(REQUEST.DELETE_TABLE, { tableId: target.dataset.tableId });
    } catch (error) {
      notifyError(error);
    }
  }

  static async refresh() {
    try {
      await getPokerSocket().request(REQUEST.REQUEST_STATE);
    } catch (error) {
      notifyError(error);
    }
  }
}

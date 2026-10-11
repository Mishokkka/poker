import { MODULE_ID, QUERY_NAME, REQUEST, SCHEMA_VERSION } from "./constants.js";
import { defaultSoundSettings } from "./audio/sound-service.js";
import { PokerLobbyApp } from "./apps/lobby-app.js";
import { PokerTableApp } from "./apps/table-app.js";
import { PokerSocket } from "./network/socket.js";
import { setPokerSocket } from "./runtime.js";
import { notifyError } from "./util.js";

let socket = null;
let lobby = null;
const tableApps = new Map();
let hostRefreshTimer = null;

function openLobby() {
  if (!socket) {
    ui.notifications?.warn(game.i18n.localize("FBLPoker.Errors.NotReady"));
    return null;
  }
  if (lobby?.rendered) {
    lobby.bringToFront();
    return lobby;
  }
  lobby = new PokerLobbyApp();
  lobby.render({ force: true });
  return lobby;
}

function openTable(tableId) {
  const table = socket?.getTable(tableId);
  if (!table) {
    ui.notifications?.warn(game.i18n.localize("FBLPoker.Errors.TableMissing"));
    return null;
  }
  const existing = tableApps.get(tableId);
  if (existing) { existing.render({ force: true }); existing.bringToFront?.(); return existing; }
  const app = new PokerTableApp({ tableId });
  tableApps.set(tableId, app);
  app.render({ force: true });
  return app;
}

Hooks.once("init", () => {
  CONFIG.queries[QUERY_NAME] = async (payload) => {
    if (!socket) return { ok: false, message: "FBLPoker.Errors.NotReady" };
    return socket.handleQuery(payload);
  };

  game.settings.register(MODULE_ID, "tables", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, "tableHistories", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, "networkEpoch", { scope: "world", config: false, type: Number, default: 0 });
  game.settings.register(MODULE_ID, "moneyJournal", { scope: "world", config: false, type: Object, default: {} });

  game.settings.register(MODULE_ID, "ledger", {
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(MODULE_ID, "schemaVersion", {
    scope: "world",
    config: false,
    type: Number,
    default: SCHEMA_VERSION
  });

  game.settings.register(MODULE_ID, "goldCopperRate", {
    name: "FBLPoker.Settings.GoldRate.Name",
    hint: "FBLPoker.Settings.GoldRate.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 100
  });

  game.settings.register(MODULE_ID, "silverCopperRate", {
    name: "FBLPoker.Settings.SilverRate.Name",
    hint: "FBLPoker.Settings.SilverRate.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 10
  });

  game.settings.register(MODULE_ID, "soundSettings", {
    scope: "world",
    config: false,
    type: Object,
    default: defaultSoundSettings()
  });

  game.keybindings.register(MODULE_ID, "openLobby", {
    name: "FBLPoker.Keybindings.OpenLobby",
    hint: "FBLPoker.Keybindings.OpenLobbyHint",
    editable: [{ key: "KeyP", modifiers: ["CONTROL", "SHIFT"] }],
    onDown: () => {
      openLobby();
      return true;
    },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE?.NORMAL
  });
});

Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControls = controls?.tokens;
  if (!tokenControls?.tools) return;
  tokenControls.tools[MODULE_ID] = {
    name: MODULE_ID,
    title: "FBLPoker.Controls.OpenLobby",
    icon: "fa-solid fa-spade",
    order: Object.keys(tokenControls.tools).length,
    button: true,
    visible: true,
    onChange: () => openLobby()
  };
});

Hooks.once("ready", async () => {
  const candidate = new PokerSocket();
  try {
    await candidate.initialize();
  } catch (error) {
    await candidate.shutdown();
    notifyError(error);
    return;
  }

  socket = candidate;
  setPokerSocket(socket);
  game.fblPoker = Object.freeze({
    openLobby,
    openTable,
    request: (type, data) => socket.request(type, data),
    get tables() { return socket.tables; },
    REQUEST
  });

  void socket.synchronize().catch((error) => {
    console.warn("FBL Poker | Initial synchronization failed", error);
  });

  if (game.system.id !== "forbidden-lands") {
    ui.notifications?.warn(game.i18n.localize("FBLPoker.Errors.WrongSystem"));
  }
});

function scheduleHostRefresh() {
  clearTimeout(hostRefreshTimer);
  hostRefreshTimer = setTimeout(() => {
    hostRefreshTimer = null;
    if (!socket) return;
    void socket.refreshHostRole()
      .then(() => socket.provisionActiveSessions())
      .then(() => socket.synchronize())
      .catch((error) => {
        console.error("FBL Poker | Delayed host-role refresh failed", error);
        ui.notifications?.error(game.i18n.localize("FBLPoker.Errors.InitializationFailed"));
      });
  }, 250);
}
Hooks.on("userConnected", scheduleHostRefresh);
Hooks.on("updateUser", (_user, changes) => {
  if (["active", "role"].some((key) => Object.hasOwn(changes ?? {}, key))) scheduleHostRefresh();
});
Hooks.on("closePokerTableApp", (app) => { if (tableApps.get(app.tableId) === app) tableApps.delete(app.tableId); });

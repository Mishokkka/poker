import { MODULE_ID, REQUEST, SCHEMA_VERSION } from "./constants.js";
import { defaultSoundSettings } from "./audio/sound-service.js";
import { PokerLobbyApp } from "./apps/lobby-app.js";
import { PokerTableApp } from "./apps/table-app.js";
import { PokerSocket } from "./network/socket.js";
import { setPokerSocket } from "./runtime.js";
import { notifyError } from "./util.js";

let socket = null;
let lobby = null;

function openLobby() {
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
  const app = new PokerTableApp({ tableId });
  app.render({ force: true });
  return app;
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "tables", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

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
    candidate.shutdown();
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

  if (game.system.id !== "forbidden-lands") {
    ui.notifications?.warn(game.i18n.localize("FBLPoker.Errors.WrongSystem"));
  }
});

Hooks.on("updateUser", () => {
  setTimeout(() => {
    if (!socket) return;
    void socket.refreshHostRole().catch((error) => {
      console.error("FBL Poker | Delayed host-role refresh failed", error);
      ui.notifications?.error(game.i18n.localize("FBLPoker.Errors.InitializationFailed"));
    });
  }, 250);
});

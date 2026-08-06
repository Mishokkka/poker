import { MODULE_ID, REQUEST, SCHEMA_VERSION, SOCKET_NAME } from "../constants.js";
import { PokerHostService } from "./host-service.js";
import { migrateTableState, PokerTableEngine } from "../engine/table-engine.js";
import { SessionCrypto } from "./crypto.js";
import { activeHost, isHostClient, localize, randomId } from "../util.js";

export class PokerSocket {
  constructor() {
    this.crypto = new SessionCrypto();
    this.hostService = null;
    this.tables = new Map();
    this.privateHands = new Map();
    this.sessionToken = null;
    this.sessionResolve = null;
    this.sessionPromise = null;
    this.pending = new Map();
    this.hostInitPromise = null;
    this.hostId = null;
    this.helloTimer = null;
    this.boundHandler = (payload) => this.#onMessage(payload);
    this.#resetSessionPromise();
  }

  async initialize() {
    game.socket.on(SOCKET_NAME, this.boundHandler);
    try {
      this.#bootstrapFromStoredTables();
      await this.crypto.initialize();
      await this.refreshHostRole();
    } catch (error) {
      this.shutdown();
      throw error;
    }
  }

  shutdown() {
    clearInterval(this.helloTimer);
    this.helloTimer = null;
    this.hostService?.shutdown();
    this.hostService = null;
    this.hostInitPromise = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(localize("FBLPoker.Errors.NotReady")));
    }
    this.pending.clear();
    game?.socket?.off?.(SOCKET_NAME, this.boundHandler);
  }

  async refreshHostRole() {
    const nextHostId = activeHost()?.id ?? null;
    const hostChanged = nextHostId !== this.hostId;

    if (hostChanged) {
      this.hostId = nextHostId;
      this.sessionToken = null;
      clearInterval(this.helloTimer);
      this.helloTimer = null;
      this.#resetSessionPromise();
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(localize("FBLPoker.Errors.HostChanged")));
      }
      this.pending.clear();
    }

    if (!isHostClient()) {
      this.hostService?.shutdown();
      this.hostService = null;
      this.hostInitPromise = null;
    } else if (!this.hostService) {
      if (!this.hostInitPromise) {
        this.hostInitPromise = (async () => {
          const service = new PokerHostService(this);
          try {
            await service.initialize();
            this.hostService = service;
          } catch (error) {
            service.shutdown();
            throw error;
          }
        })().finally(() => { this.hostInitPromise = null; });
      }
      await this.hostInitPromise;
    }

    if (!nextHostId) return;

    if (isHostClient() && this.hostService) {
      this.#establishLocalHostSession();
      return;
    }

    if (hostChanged || !this.sessionToken) this.#startHelloLoop(nextHostId);
  }


  #bootstrapFromStoredTables() {
    try {
      if (!game?.settings?.get) return;
      const stored = game.settings.get(MODULE_ID, "tables");
      if (!stored || typeof stored !== "object") return;
      const worldSchemaVersion = Number(game.settings.get(MODULE_ID, "schemaVersion")) || SCHEMA_VERSION;
      const tables = Object.values(stored)
        .filter((table) => table && typeof table === "object")
        .map((table) => new PokerTableEngine(migrateTableState(table, worldSchemaVersion)).publicState());
      if (!tables.length) return;
      this.#applySnapshot({ tables });
    } catch (error) {
      console.warn("FBL Poker | Failed to bootstrap tables from world settings", error);
    }
  }

  hello() {
    const hostUserId = activeHost()?.id ?? null;
    if (!hostUserId) return;
    this.broadcast({
      type: REQUEST.HELLO,
      userId: game.user.id,
      hostUserId,
      publicKey: this.crypto.publicKey
    });
  }

  #startHelloLoop(hostUserId) {
    clearInterval(this.helloTimer);
    this.hello();
    this.helloTimer = setInterval(() => {
      if (this.sessionToken || activeHost()?.id !== hostUserId) {
        clearInterval(this.helloTimer);
        this.helloTimer = null;
        return;
      }
      this.hello();
    }, 1500);
  }

  broadcast(payload) {
    game.socket.emit(SOCKET_NAME, payload);
  }

  publishSnapshot(tables) {
    const payload = { type: REQUEST.SNAPSHOT, tables };
    this.#applySnapshot(payload);
    this.broadcast(payload);
  }

  async request(type, data = {}) {
    if (!activeHost()) throw new Error(localize("FBLPoker.Errors.NoActiveGM"));

    if (isHostClient()) {
      await this.refreshHostRole();
      if (!this.hostService) throw new Error(localize("FBLPoker.Errors.NotReady"));
      if (!this.sessionToken) this.#establishLocalHostSession();
      return this.hostService.enqueueLocal({
        type,
        data,
        userId: game.user.id,
        token: this.sessionToken,
        requestId: randomId("request-")
      });
    }

    if (!this.sessionToken) {
      this.hello();
      let sessionTimeout = null;
      try {
        await Promise.race([
          this.sessionPromise,
          new Promise((_, reject) => {
            sessionTimeout = setTimeout(() => reject(new Error(localize("FBLPoker.Errors.SessionTimeout"))), 8000);
          })
        ]);
      } finally {
        clearTimeout(sessionTimeout);
      }
    }

    const requestId = randomId("request-");
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(localize("FBLPoker.Errors.RequestTimeout")));
      }, 10000);
      this.pending.set(requestId, { resolve, reject, timeout });
    });

    this.broadcast({ type, data, userId: game.user.id, token: this.sessionToken, requestId });
    return result;
  }

  getTable(tableId) {
    return this.tables.get(tableId) ?? null;
  }

  getPrivateHand(tableId, handNumber, seatIndex) {
    return this.privateHands.get(`${tableId}:${handNumber}:${seatIndex}`) ?? [];
  }

  isAutomatedSeat(tableId, seatIndex) {
    return Boolean(this.hostService?.isBotSeat(tableId, seatIndex));
  }

  async sendPrivate(userId, data) {
    if (userId === game.user.id) {
      await this.#handlePrivateData(data);
      return;
    }

    const session = this.hostService?.sessions.get(userId);
    if (!session) return;
    const encrypted = await this.crypto.encrypt(session.publicKey, data);
    this.broadcast({
      type: REQUEST.PRIVATE,
      recipient: userId,
      senderPublicKey: this.crypto.publicKey,
      encrypted
    });
  }

  async sendAck(userId, requestId) {
    if (!requestId) return;
    await this.sendPrivate(userId, { kind: "ack", requestId });
  }

  async sendError(userId, error, requestId = null) {
    console.error("FBL Poker | Host request failed", error);
    await this.sendPrivate(userId, {
      kind: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  #establishLocalHostSession() {
    if (!this.hostService) return;
    let session = this.hostService.sessions.get(game.user.id);
    if (!session) session = this.hostService.registerSession(game.user.id, this.crypto.publicKey);
    if (!session) return;
    this.#acceptSession(session.token);
  }

  #acceptSession(token) {
    this.sessionToken = token;
    clearInterval(this.helloTimer);
    this.helloTimer = null;
    this.sessionResolve?.(token);
  }

  #resetSessionPromise() {
    this.sessionPromise = new Promise((resolve) => { this.sessionResolve = resolve; });
  }

  #applySnapshot(payload) {
    this.tables = new Map((payload.tables ?? []).map((table) => [table.id, table]));
    const validPrivateHands = new Set();
    for (const table of this.tables.values()) {
      for (const seat of table.seats ?? []) {
        if (!seat || !seat.cardsCount) continue;
        validPrivateHands.add(`${table.id}:${table.handNumber}:${seat.index}`);
      }
    }
    for (const key of this.privateHands.keys()) {
      if (!validPrivateHands.has(key)) this.privateHands.delete(key);
    }
    Hooks.callAll("fblPokerStateUpdated", this.tables);
  }

  async #handlePrivateData(data) {
    if (!data || typeof data !== "object") return;

    if (data.kind === "session") {
      this.#acceptSession(data.token);
      this.request(REQUEST.REQUEST_STATE).catch((error) => console.error("FBL Poker | Initial state request failed", error));
      return;
    }

    if (data.kind === "holeCards") {
      this.privateHands.set(`${data.tableId}:${data.handNumber}:${data.seatIndex}`, [...data.cards]);
      Hooks.callAll("fblPokerPrivateUpdated", data);
      return;
    }

    if (data.kind === "ack") {
      const pending = this.pending.get(data.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(data.requestId);
        pending.resolve(true);
      }
      return;
    }

    if (data.kind === "error") {
      const message = String(data.message ?? "FBLPoker.Errors.Unknown");
      const localized = message.startsWith("FBLPoker.") ? localize(message) : message;
      const pending = this.pending.get(data.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(data.requestId);
        pending.reject(new Error(localized));
      } else {
        ui.notifications?.error(localized);
      }
    }
  }

  async #onMessage(payload) {
    try {
      if (!payload || typeof payload !== "object") return;

      if (payload.type === REQUEST.HELLO) {
        if (!isHostClient() || !this.hostService || payload.userId === game.user.id) return;
        if (payload.hostUserId && payload.hostUserId !== game.user.id) return;
        const session = this.hostService.registerSession(payload.userId, payload.publicKey);
        if (!session) return;
        await this.hostService.broadcastAll();
        await this.sendPrivate(payload.userId, {
          kind: "session",
          token: session.token,
          hostUserId: game.user.id,
          secureTransport: this.crypto.secure && payload.publicKey?.mode !== "plain"
        });
        await this.hostService.sendPrivateHandsForUser(payload.userId);
        return;
      }

      if (payload.type === REQUEST.SESSION || payload.type === REQUEST.PRIVATE) {
        if (payload.recipient !== game.user.id) return;
        const data = await this.crypto.decrypt(payload.senderPublicKey, payload.encrypted);
        await this.#handlePrivateData(data);
        return;
      }

      if (payload.type === REQUEST.SNAPSHOT) {
        this.#applySnapshot(payload);
        return;
      }

      if (isHostClient() && this.hostService) await this.hostService.enqueue(payload);
    } catch (error) {
      console.error("FBL Poker | Socket message failed", error);
    }
  }
}

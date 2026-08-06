import { MODULE_ID, REQUEST, SCHEMA_VERSION, SOCKET_NAME } from "../constants.js";
import { PokerHostService } from "./host-service.js";
import { migrateTableState, PokerTableEngine } from "../engine/table-engine.js";
import { SessionCrypto } from "./crypto.js";
import { activeHost, isHostClient, localize, randomId } from "../util.js";

function sameEcdhKey(left, right) {
  return left?.mode === "ecdh"
    && right?.mode === "ecdh"
    && typeof left.jwk?.x === "string"
    && typeof left.jwk?.y === "string"
    && left.jwk.x === right.jwk?.x
    && left.jwk.y === right.jwk?.y;
}

export class PokerSocket {
  constructor({ hostServiceFactory = (socket) => new PokerHostService(socket) } = {}) {
    this.crypto = new SessionCrypto();
    this.hostServiceFactory = hostServiceFactory;
    this.hostService = null;
    this.tables = new Map();
    this.privateHands = new Map();
    this.sessionToken = null;
    this.sessionResolve = null;
    this.sessionPromise = null;
    this.pending = new Map();
    this.hostInitPromise = null;
    this.initializingHostService = null;
    this.hostRetirementPromise = null;
    this.hostGeneration = 0;
    this.closed = false;
    this.hostId = null;
    this.hostPublicKey = null;
    this.helloTimer = null;
    this.boundHandler = (payload) => this.#onMessage(payload);
    this.#resetSessionPromise();
  }

  async initialize() {
    this.closed = false;
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
    this.closed = true;
    this.hostGeneration += 1;
    clearInterval(this.helloTimer);
    this.helloTimer = null;
    const retirement = this.#retireHostServices();
    this.sessionToken = null;
    this.hostPublicKey = null;
    this.#resetSessionPromise();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(localize("FBLPoker.Errors.NotReady")));
    }
    this.pending.clear();
    globalThis.game?.socket?.off?.(SOCKET_NAME, this.boundHandler);
    return retirement;
  }

  #retireHostServices() {
    if (this.hostRetirementPromise) return this.hostRetirementPromise;

    const activeService = this.hostService;
    const initializingService = this.initializingHostService;
    const services = [...new Set([activeService, initializingService].filter(Boolean))];
    this.initializingHostService = null;
    this.hostInitPromise = null;

    const retirement = Promise.allSettled(services.map((service) => Promise.resolve().then(() => service.shutdown()))).then(() => {
      if (this.hostService === activeService) this.hostService = null;
    });
    let trackedRetirement = null;
    trackedRetirement = retirement.finally(() => {
      if (this.hostRetirementPromise === trackedRetirement) this.hostRetirementPromise = null;
    });
    this.hostRetirementPromise = trackedRetirement;
    return trackedRetirement;
  }

  async refreshHostRole() {
    const nextHostId = activeHost()?.id ?? null;
    const hostChanged = nextHostId !== this.hostId;

    if (hostChanged) {
      this.hostId = nextHostId;
      this.sessionToken = null;
      this.hostPublicKey = null;
      clearInterval(this.helloTimer);
      this.helloTimer = null;
      this.#resetSessionPromise();
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(localize("FBLPoker.Errors.HostChanged")));
      }
      this.pending.clear();
    }

    if (this.closed) return;

    if (!isHostClient()) {
      this.hostGeneration += 1;
      await this.#retireHostServices();
    } else {
      if (this.hostRetirementPromise) await this.hostRetirementPromise;
      if (!this.hostService) {
        if (!this.hostInitPromise) {
          const generation = ++this.hostGeneration;
          const service = this.hostServiceFactory(this);
          this.initializingHostService = service;
          const initialization = (async () => {
            try {
              await service.initialize();
              if (this.closed || generation !== this.hostGeneration || !isHostClient()) {
                await service.shutdown();
                return;
              }
              this.hostService = service;
            } catch (error) {
              await service.shutdown();
              if (this.closed || generation !== this.hostGeneration || !isHostClient()) return;
              throw error;
            }
          })();
          this.hostInitPromise = initialization;
          const cleanup = () => {
            if (this.hostInitPromise === initialization) this.hostInitPromise = null;
            if (this.initializingHostService === service) this.initializingHostService = null;
          };
          initialization.then(cleanup, cleanup);
        }
        await this.hostInitPromise;
      }
    }

    if (this.closed || !nextHostId || activeHost()?.id !== nextHostId) return;

    if (isHostClient() && this.hostService) {
      await this.#establishLocalHostSession();
      return;
    }

    if (hostChanged || !this.sessionToken) this.#startHelloLoop(nextHostId);
  }


  #bootstrapFromStoredTables() {
    if (!game?.settings?.get) return;
    const stored = game.settings.get(MODULE_ID, "tables");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
    const worldSchemaVersion = Number(game.settings.get(MODULE_ID, "schemaVersion")) || SCHEMA_VERSION;
    const tables = [];
    for (const [id, table] of Object.entries(stored)) {
      if (!table || typeof table !== "object" || Array.isArray(table)) {
        console.error(`FBL Poker | Rejected stored table ${id}: invalid table state`);
        continue;
      }
      try {
        tables.push(new PokerTableEngine(migrateTableState(table, worldSchemaVersion)).publicState());
      } catch (error) {
        console.error(`FBL Poker | Rejected stored table ${id} during client bootstrap`, error);
      }
    }
    if (tables.length) this.#applySnapshot({ tables });
  }

  hello() {
    if (!this.crypto.secure) return;
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
    const payload = { type: REQUEST.SNAPSHOT, hostUserId: game.user.id, tables };
    this.#applySnapshot(payload);
    this.broadcast(payload);
  }

  async request(type, data = {}) {
    if (!this.crypto.secure) throw new Error(localize("FBLPoker.Errors.PrivateTransportUnavailable"));
    if (!activeHost()) throw new Error(localize("FBLPoker.Errors.NoActiveGM"));

    if (isHostClient()) {
      await this.refreshHostRole();
      if (!this.hostService) throw new Error(localize("FBLPoker.Errors.NotReady"));
      if (!this.sessionToken) await this.#establishLocalHostSession();
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

    if (!this.hostPublicKey || this.hostPublicKey.mode !== "ecdh") {
      this.#clearPendingRequest(requestId);
      throw new Error(localize("FBLPoker.Errors.PrivateTransportUnavailable"));
    }

    try {
      const encrypted = await this.crypto.encrypt(this.hostPublicKey, {
        kind: "request",
        type,
        data,
        userId: game.user.id,
        token: this.sessionToken,
        requestId
      });
      this.broadcast({
        type: REQUEST.PRIVATE,
        recipient: this.hostId,
        senderPublicKey: this.crypto.publicKey,
        encrypted
      });
      return result;
    } catch (error) {
      this.#clearPendingRequest(requestId);
      throw error;
    }
  }

  #clearPendingRequest(requestId) {
    const pendingRequest = this.pending.get(requestId);
    if (pendingRequest) clearTimeout(pendingRequest.timeout);
    this.pending.delete(requestId);
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
    if (!this.crypto.secure || session.publicKey?.mode !== "ecdh") {
      throw new Error("FBLPoker.Errors.PrivateTransportUnavailable");
    }
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

  async #establishLocalHostSession() {
    if (!this.hostService) return;
    let session = this.hostService.sessions.get(game.user.id);
    if (!session) session = await this.hostService.registerSession(game.user.id, this.crypto.publicKey);
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

  async #handlePrivateData(data, senderPublicKey = null) {
    if (!data || typeof data !== "object") return;

    if (data.kind === "session") {
      if (senderPublicKey?.mode !== "ecdh") throw new Error(localize("FBLPoker.Errors.PrivateTransportUnavailable"));
      if (data.hostUserId !== activeHost()?.id || data.hostUserId !== this.hostId) return;
      this.hostPublicKey = senderPublicKey;
      this.#acceptSession(data.token);
      this.request(REQUEST.REQUEST_STATE).catch((error) => console.error("FBL Poker | Initial state request failed", error));
      return;
    }

    if (data.kind === "request") {
      if (!isHostClient() || !this.hostService) return;
      const sessionKey = this.hostService.sessions.get(data.userId)?.publicKey;
      if (!sameEcdhKey(sessionKey, senderPublicKey)) {
        throw new Error(localize("FBLPoker.Errors.InvalidSession"));
      }
      await this.hostService.enqueue({
        type: data.type,
        data: data.data ?? {},
        userId: data.userId,
        token: data.token,
        requestId: data.requestId
      });
      return;
    }

    if (!isHostClient() && !sameEcdhKey(this.hostPublicKey, senderPublicKey)) {
      throw new Error(localize("FBLPoker.Errors.InvalidSession"));
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
      if (this.closed || !payload || typeof payload !== "object") return;

      if (payload.type === REQUEST.HELLO) {
        if (!isHostClient() || !this.hostService || !this.crypto.secure || payload.userId === game.user.id) return;
        if (payload.publicKey?.mode !== "ecdh" || !payload.publicKey.jwk) return;
        if (payload.hostUserId && payload.hostUserId !== game.user.id) return;
        const session = await this.hostService.registerSession(payload.userId, payload.publicKey);
        if (!session) return;
        await this.hostService.broadcastAll();
        await this.sendPrivate(payload.userId, {
          kind: "session",
          token: session.token,
          hostUserId: game.user.id,
          secureTransport: true
        });
        await this.hostService.sendPrivateHandsForUser(payload.userId);
        return;
      }

      if (payload.type === REQUEST.SESSION || payload.type === REQUEST.PRIVATE) {
        if (payload.recipient !== game.user.id || payload.senderPublicKey?.mode !== "ecdh") return;
        const data = await this.crypto.decrypt(payload.senderPublicKey, payload.encrypted);
        await this.#handlePrivateData(data, payload.senderPublicKey);
        return;
      }

      if (payload.type === REQUEST.SNAPSHOT) {
        if (payload.hostUserId !== activeHost()?.id) return;
        this.#applySnapshot(payload);
        return;
      }

      if (isHostClient() && this.hostService) await this.hostService.enqueue(payload);
    } catch (error) {
      console.error("FBL Poker | Socket message failed", error);
    }
  }
}

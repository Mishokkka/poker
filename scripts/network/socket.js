import { MODULE_ID, QUERY_NAME, REQUEST, SCHEMA_VERSION, SOCKET_NAME } from "../constants.js";
import { PokerHostService } from "./host-service.js";
import { migrateTableState, PokerTableEngine } from "../engine/table-engine.js";
import { activeHost, isHostClient, localize, randomId } from "../util.js";

const QUERY_TIMEOUT_MS = 10_000;
const SESSION_DELIVERY_TIMEOUT_MS = 5_000;

function queryErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error ?? "FBLPoker.Errors.Unknown");
  return message.startsWith("FBLPoker.") ? localize(message) : message;
}

export class PokerSocket {
  constructor({ hostServiceFactory = (socket) => new PokerHostService(socket) } = {}) {
    this.hostServiceFactory = hostServiceFactory;
    this.hostService = null;
    this.tables = new Map();
    this.privateHands = new Map();
    this.sessionToken = null;
    this.sessionEstablishPromise = null;
    this.hostInitPromise = null;
    this.initializingHostService = null;
    this.hostRetirementPromise = null;
    this.hostGeneration = 0;
    this.closed = false;
    this.hostId = null;
    this.syncPromise = null;
    this.epoch = 0;
    this.sequence = 0;
    this.fullSequence = -1;
    this.tableSequences = new Map();
    this.automation = new Map();
    this.clockSample = null;
    this.provisionPromise = null;
    this.boundHandler = (payload, senderId) => this.#onMessage(payload, senderId);
  }

  async initialize() {
    this.closed = false;
    game.socket.on(SOCKET_NAME, this.boundHandler);
    try {
      this.#bootstrapFromStoredTables();
      await this.refreshHostRole();
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  async shutdown() {
    this.closed = true;
    this.hostGeneration += 1;
    this.sessionToken = null;
    this.sessionEstablishPromise = null;
    this.syncPromise = null;
    const retirement = this.#retireHostServices();
    globalThis.game?.socket?.off?.(SOCKET_NAME, this.boundHandler);
    await retirement;
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
      this.epoch = 0;
      this.fullSequence = -1;
      this.tableSequences.clear();
      this.automation.clear();
      this.clockSample = null;
      this.sessionToken = null;
      this.sessionEstablishPromise = null;
      this.privateHands.clear();
      this.syncPromise = null;
    }

    if (this.closed) return;

    if (!isHostClient()) {
      this.hostGeneration += 1;
      await this.#retireHostServices();
      return;
    }

    if (this.hostRetirementPromise) await this.hostRetirementPromise;
    if (!this.hostService) {
      if (!this.hostInitPromise) {
        const generation = ++this.hostGeneration;
        const service = this.hostServiceFactory(this);
        this.initializingHostService = service;
        const initialization = (async () => {
          try {
            const storedEpoch = Number(game.settings.get(MODULE_ID, "networkEpoch")) || 0;
            this.epoch = Math.max(storedEpoch + 1, Date.now());
            this.sequence = 0;
            this.fullSequence = -1;
            this.tableSequences.clear();
            this.automation.clear();
            this.clockSample = null;
            await game.settings.set(MODULE_ID, "networkEpoch", this.epoch);
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

    if (this.closed || activeHost()?.id !== game.user.id || !this.hostService) return;
    await this.#establishLocalHostSession();
  }

  #bootstrapFromStoredTables() {
    if (!game?.settings?.get) return;
    const stored = game.settings.get(MODULE_ID, "tables");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
    const storedHistories = game.settings.get(MODULE_ID, "tableHistories");
    const histories = storedHistories && typeof storedHistories === "object" && !Array.isArray(storedHistories) ? storedHistories : {};
    const worldSchemaVersion = Number(game.settings.get(MODULE_ID, "schemaVersion")) || SCHEMA_VERSION;
    const tables = [];
    for (const [id, table] of Object.entries(stored)) {
      if (!table || typeof table !== "object" || Array.isArray(table)) {
        console.error(`FBL Poker | Rejected stored table ${id}: invalid table state`);
        continue;
      }
      try {
        const archive = histories[id];
        const archivedHands = Array.isArray(archive) ? archive : (Array.isArray(archive?.hands) ? archive.hands : null);
        const source = archivedHands ? { ...table, handHistory: archivedHands } : table;
        if (archive && !Array.isArray(archive) && Number.isSafeInteger(archive.revision) && source.historyRevision === undefined) {
          source.historyRevision = archive.revision;
        }
        tables.push(new PokerTableEngine(migrateTableState(source, worldSchemaVersion)).publicState());
      } catch (error) {
        console.error(`FBL Poker | Rejected stored table ${id} during client bootstrap`, error);
      }
    }
    if (tables.length) this.#applySnapshot({ tables, full: true });
  }

  broadcast(payload) {
    game.socket.emit(SOCKET_NAME, payload);
  }

  snapshotEnvelope() {
    return { epoch: this.epoch, sequence: ++this.sequence, hostNow: Date.now() };
  }

  hostNow() {
    return this.clockSample ? this.clockSample.host + (performance.now() - this.clockSample.local) : Date.now();
  }

  expectedState(tableId) {
    const table = this.getTable(tableId);
    return table ? { handNumber: table.handNumber, status: table.status, revision: table.revision } : undefined;
  }

  publishSnapshot(tables, { full = true, deletedTableIds = [], historyUpdates = [] } = {}) {
    if (this.closed || activeHost()?.id !== game.user?.id) return;
    const payload = { ...this.snapshotEnvelope(), type: REQUEST.SNAPSHOT, hostUserId: game.user.id, full, tables, deletedTableIds, historyUpdates };
    this.#applySnapshot(payload);
    this.broadcast(payload);
  }

  async synchronize() {
    if (this.closed || isHostClient() || !activeHost()) return;
    if (this.syncPromise) return this.syncPromise;
    const sync = this.request(REQUEST.REQUEST_STATE).finally(() => {
      if (this.syncPromise === sync) this.syncPromise = null;
    });
    this.syncPromise = sync;
    return sync;
  }

  async request(type, data = {}) {
    data = structuredClone(data);
    if (data.tableId && !data.expected && type !== REQUEST.REQUEST_STATE && type !== REQUEST.RESOLVE_MONEY) data.expected = this.expectedState(data.tableId);
    const host = activeHost();
    if (!host) throw new Error(localize("FBLPoker.Errors.NoActiveGM"));

    if (isHostClient()) {
      await this.refreshHostRole();
      if (!this.hostService) throw new Error(localize("FBLPoker.Errors.NotReady"));
      if (!this.sessionToken) await this.#establishLocalHostSession();
      const value = await this.hostService.enqueueLocal({
        type,
        data,
        userId: game.user.id,
        token: this.sessionToken,
        requestId: randomId("request-")
      });
      if (type === REQUEST.REQUEST_STATE && value?.kind === "snapshot") {
        this.#applySnapshot({ type: REQUEST.SNAPSHOT, hostUserId: host.id, full: true, ...value, tables: value.tables ?? [] });
        return true;
      }
      return value;
    }

    if (typeof host.query !== "function") throw new Error(localize("FBLPoker.Errors.PrivateTransportUnavailable"));
    if (host.id !== this.hostId) await this.refreshHostRole();
    await this.#ensureRemoteSession(host.id);

    const requestId = randomId("request-");
    const sendRequest = async () => {
      try {
        return await host.query(QUERY_NAME, {
          kind: "request",
          protocol: 2,
          epoch: this.epoch,
          hostUserId: host.id,
          userId: game.user.id,
          token: this.sessionToken,
          requestId,
          type,
          data
        }, { timeout: QUERY_TIMEOUT_MS });
      } catch (error) {
        throw new Error(queryErrorMessage(error));
      }
    };

    let result = await sendRequest();
    if (!result?.ok && result?.message === "FBLPoker.Errors.InvalidSession") {
      await this.#ensureRemoteSession(host.id, { force: true });
      result = await sendRequest();
    }

    if (!result?.ok) {
      const message = String(result?.message ?? "FBLPoker.Errors.Unknown");
      throw new Error(message.startsWith("FBLPoker.") ? localize(message) : message);
    }
    if (type === REQUEST.REQUEST_STATE && result.value?.kind === "snapshot") {
      this.#applySnapshot({ type: REQUEST.SNAPSHOT, hostUserId: host.id, full: true, ...result.value, tables: result.value.tables ?? [] });
      return true;
    }
    return result.value ?? true;
  }

  getTable(tableId) {
    return this.tables.get(tableId) ?? null;
  }

  getPrivateHand(tableId, handNumber, seatIndex) {
    return this.privateHands.get(`${tableId}:${handNumber}:${seatIndex}`) ?? [];
  }

  isAutomatedSeat(tableId, seatIndex) {
    if (this.hostService) return this.hostService.isBotSeat(tableId, seatIndex);
    return Boolean(this.automation.get(tableId)?.seats.includes(seatIndex));
  }

  hasAutomationInfo(tableId) {
    return !game.user.isGM || Boolean(this.hostService)
      || (this.automation.get(tableId)?.revision ?? -1) >= (this.tables.get(tableId)?.revision ?? 0);
  }

  async sendPrivate(userId, data) {
    if (userId === game.user.id) {
      await this.#handlePrivateData(data);
      return;
    }

    const session = this.hostService?.sessions.get(userId);
    const user = game.users.get(userId);
    if (!session || !user?.active || typeof user.query !== "function") throw new Error("FBLPoker.Errors.PrivateTransportUnavailable");

    const response = await user.query(QUERY_NAME, {
      kind: "delivery",
      hostUserId: game.user.id,
      userId,
      token: session.token,
      data
    }, { timeout: QUERY_TIMEOUT_MS });

    if (!response?.ok) {
      const message = String(response?.message ?? "FBLPoker.Errors.Unknown");
      throw new Error(message.startsWith("FBLPoker.") ? localize(message) : message);
    }
  }

  async sendAck() {
    // Remote requests use Foundry v13 targeted queries and receive their result directly.
  }

  async sendError(userId, error, requestId = null) {
    console.error("FBL Poker | Host request failed", error);
    if (!requestId) return;
    await this.sendPrivate(userId, {
      kind: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  async #establishLocalHostSession() {
    if (!this.hostService) return;
    let session = this.hostService.sessions.get(game.user.id);
    if (!session) session = await this.hostService.registerSession(game.user.id);
    if (session) this.sessionToken = session.token;
  }

  async provisionActiveSessions() {
    if (this.provisionPromise) return this.provisionPromise;
    const pending = this.#provisionActiveSessions().finally(() => { if (this.provisionPromise === pending) this.provisionPromise = null; });
    this.provisionPromise = pending;
    return pending;
  }

  async #provisionActiveSessions() {
    if (this.closed || !isHostClient() || !this.hostService) return;
    const users = (game.users?.contents ?? []).filter((user) => user?.active && user.id !== game.user.id && typeof user.query === "function");
    await Promise.all(users.map(async (user) => {
      let session = this.hostService.sessions.get(user.id);
      if (!session) session = await this.hostService.registerSession(user.id);
      if (!session) return;
      try {
        const response = await user.query(QUERY_NAME, {
          kind: "sessionDelivery",
          epoch: this.epoch,
          hostUserId: game.user.id,
          userId: user.id,
          token: session.token
        }, { timeout: SESSION_DELIVERY_TIMEOUT_MS });
        if (!response?.ok) {
          console.warn(`FBL Poker | Could not provision private session for ${user.id}`, response?.message ?? "unknown response");
        }
      } catch (error) {
        console.warn(`FBL Poker | Could not provision private session for ${user.id}`, error);
      }
    }));
  }

  async #ensureRemoteSession(hostUserId, { force = false } = {}) {
    if (force) this.sessionToken = null;
    if (this.sessionToken) return;
    if (this.sessionEstablishPromise) return this.sessionEstablishPromise;

    let pending = null;
    pending = this.#establishRemoteSession(hostUserId).finally(() => {
      if (this.sessionEstablishPromise === pending) this.sessionEstablishPromise = null;
    });
    this.sessionEstablishPromise = pending;
    return pending;
  }

  async #establishRemoteSession(hostUserId) {
    const host = game.users.get(hostUserId);
    if (!host?.active || typeof host.query !== "function") throw new Error(localize("FBLPoker.Errors.NoActiveGM"));

    let response;
    try {
      response = await host.query(QUERY_NAME, {
        kind: "provisionSessions",
        hostUserId
      }, { timeout: QUERY_TIMEOUT_MS });
    } catch (error) {
      throw new Error(queryErrorMessage(error));
    }

    if (!response?.ok || response.hostUserId !== activeHost()?.id || response.hostUserId !== this.hostId || !this.sessionToken) {
      const message = String(response?.message ?? "FBLPoker.Errors.InvalidSession");
      throw new Error(message.startsWith("FBLPoker.") ? localize(message) : message);
    }
  }

  #applySnapshot(payload) {
    if (payload.hostUserId && payload.hostUserId !== activeHost()?.id) return;
    const ordered = Number.isSafeInteger(payload.epoch) && Number.isSafeInteger(payload.sequence);
    if (ordered) {
      if (payload.epoch < this.epoch) return;
      if (payload.epoch > this.epoch) {
        this.epoch = payload.epoch;
        this.sessionToken = null;
        this.clockSample = null;
        this.fullSequence = -1;
        this.tableSequences.clear();
        this.automation.clear();
        this.privateHands.clear();
      }
      if (payload.sequence < this.fullSequence) return;
      if (Number.isFinite(payload.hostNow) && payload.sequence >= (this.clockSample?.sequence ?? -1)) {
        this.clockSample = { host: payload.hostNow, local: performance.now(), sequence: payload.sequence };
      }
    }
    if (payload.automation && game.user.isGM) this.#applyAutomation(payload.automation);
    const previous = this.tables;
    const full = payload.full !== false;
    const incoming = Array.isArray(payload.tables) ? payload.tables : [];
    const deletedTableIds = new Set(Array.isArray(payload.deletedTableIds) ? payload.deletedTableIds : []);
    const historyUpdates = Array.isArray(payload.historyUpdates) ? payload.historyUpdates : [];
    let next;

    next = new Map(previous);
    const sequence = ordered ? payload.sequence : 0;
    for (const table of incoming) {
      if (ordered && sequence <= (this.tableSequences.get(table.id) ?? -1)) {
        const current = next.get(table.id);
        if (full && current && Array.isArray(table.handHistory)) {
          const history = new Map(table.handHistory.map(hand => [hand.handNumber, hand]));
          for (const hand of current.handHistory ?? []) history.set(hand.handNumber, hand);
          next.set(table.id, { ...current, handHistory: [...history.values()].sort((a, b) => b.handNumber - a.handNumber).slice(0, 100) });
        }
        continue;
      }
      const prior = previous.get(table.id);
      next.set(table.id, !Object.hasOwn(table, "handHistory") && prior ? { ...table, handHistory: prior.handHistory ?? [] } : table);
      if (ordered) this.tableSequences.set(table.id, sequence);
    }
    if (full) {
      const included = new Set(incoming.map((table) => table.id));
      for (const id of previous.keys()) if (!included.has(id) && (!ordered || sequence > (this.tableSequences.get(id) ?? -1))) deletedTableIds.add(id);
      if (ordered) this.fullSequence = Math.max(this.fullSequence, sequence);
    }
    for (const id of deletedTableIds) {
      if (ordered && sequence <= (this.tableSequences.get(id) ?? -1)) continue;
      next.delete(id);
      this.automation.delete(id);
      if (ordered) this.tableSequences.set(id, sequence);
    }
    for (const update of historyUpdates) {
      const table = next.get(update?.tableId);
      if (!table || !update.hand) continue;
      const history = [...(table.handHistory ?? [])];
      const index = history.findIndex((hand) => hand?.handNumber === update.hand.handNumber);
      if (index >= 0 && update.revision < (table.historyRevision ?? 0)) continue;
      if (index >= 0) history[index] = update.hand;
      else history.unshift(update.hand);
      next.set(update.tableId, { ...table, handHistory: history.sort((a, b) => b.handNumber - a.handNumber).slice(0, 100), historyRevision: Math.max(update.revision ?? 0, table.historyRevision ?? 0) });
    }

    this.tables = next;

    const changedTableIds = new Set();
    const historyChangedTableIds = new Set();
    let lobbyChanged = false;
    const candidateIds = full
      ? new Set([...previous.keys(), ...next.keys()])
      : new Set([...incoming.map((table) => table.id), ...deletedTableIds]);

    for (const tableId of candidateIds) {
      const before = previous.get(tableId);
      const after = next.get(tableId);
      if (full) {
        if (!before || !after || before.revision !== after.revision || before.updatedAt !== after.updatedAt) changedTableIds.add(tableId);
      } else {
        changedTableIds.add(tableId);
      }
      if (!before || !after || before.historyRevision !== after.historyRevision || historyUpdates.some((update) => update?.tableId === tableId)) {
        historyChangedTableIds.add(tableId);
      }
      if (!this.#sameLobbyState(before, after)) lobbyChanged = true;
    }

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

    Hooks.callAll("fblPokerStateUpdated", this.tables, {
      full,
      changedTableIds,
      historyChangedTableIds,
      deletedTableIds,
      lobbyChanged
    });
  }

  #sameLobbyState(before, after) {
    if (!before || !after) return before === after;
    if (before.name !== after.name || before.status !== after.status || before.maxSeats !== after.maxSeats) return false;
    if (before.smallBlind !== after.smallBlind || before.bigBlind !== after.bigBlind || before.ante !== after.ante) return false;
    if (before.minBuyIn !== after.minBuyIn || before.maxBuyIn !== after.maxBuyIn) return false;
    const beforeOccupied = (before.seats ?? []).reduce((count, seat) => count + (seat ? 1 : 0), 0);
    const afterOccupied = (after.seats ?? []).reduce((count, seat) => count + (seat ? 1 : 0), 0);
    return beforeOccupied === afterOccupied;
  }

  #applyAutomation(data) {
    if (!game.user.isGM) return;
    for (const [id, value] of Object.entries(data)) {
      if (value.revision < (this.automation.get(id)?.revision ?? -1)) continue;
      this.automation.set(id, value);
    }
  }

  async #handlePrivateData(data) {
    if (!data || typeof data !== "object") return;

    if (data.kind === "automation" && game.user.isGM) {
      this.#applyAutomation(data.tables);
      Hooks.callAll("fblPokerStateUpdated", this.tables, { changedTableIds: new Set(Object.keys(data.tables)) });
      return;
    }
    if (data.kind === "holeCards") {
      const table = this.tables.get(data.tableId);
      if (table && (data.handNumber < table.handNumber || (data.handNumber === table.handNumber && !table.seats?.[data.seatIndex]?.cardsCount))) return;
      this.privateHands.set(`${data.tableId}:${data.handNumber}:${data.seatIndex}`, [...data.cards]);
      Hooks.callAll("fblPokerPrivateUpdated", data);
      return;
    }

    if (data.kind === "error") {
      const message = String(data.message ?? "FBLPoker.Errors.Unknown");
      const localized = message.startsWith("FBLPoker.") ? localize(message) : message;
      ui.notifications?.error(localized);
    }
  }

  async handleQuery(payload) {
    try {
      if (this.closed || !payload || typeof payload !== "object") return { ok: false, message: "FBLPoker.Errors.NotReady" };

      if (payload.kind === "provisionSessions") {
        if (!isHostClient() || !this.hostService || payload.hostUserId !== game.user.id) {
          return { ok: false, message: "FBLPoker.Errors.NotReady" };
        }
        await this.provisionActiveSessions();
        return { ok: true, hostUserId: game.user.id };
      }

      if (payload.kind === "sessionDelivery") {
        if (isHostClient()) return { ok: false, message: "FBLPoker.Errors.InvalidSession" };
        if (payload.userId !== game.user.id || payload.hostUserId !== activeHost()?.id || payload.hostUserId !== this.hostId) {
          return { ok: false, message: "FBLPoker.Errors.InvalidSession" };
        }
        if (typeof payload.token !== "string" || !payload.token) {
          return { ok: false, message: "FBLPoker.Errors.InvalidSession" };
        }
        if (!Number.isSafeInteger(payload.epoch) || payload.epoch < this.epoch) return { ok: false, message: "FBLPoker.Errors.InvalidSession" };
        if (payload.epoch > this.epoch) {
          this.epoch = payload.epoch;
          this.clockSample = null;
          this.fullSequence = -1;
          this.tableSequences.clear();
          this.privateHands.clear();
          this.automation.clear();
        }
        this.sessionToken = payload.token;
        return { ok: true };
      }

      if (payload.kind === "request") {
        if (!isHostClient() || !this.hostService || payload.hostUserId !== game.user.id) {
          return { ok: false, message: "FBLPoker.Errors.NotReady" };
        }
        if (payload.protocol !== 2 || typeof payload.requestId !== "string" || !payload.requestId) {
          return { ok: false, message: "FBLPoker.Errors.StaleRequest" };
        }
        if (payload.epoch !== this.epoch) return { ok: false, message: "FBLPoker.Errors.InvalidSession" };
        if (payload.data?.tableId && !payload.data.expected && payload.type !== REQUEST.RESOLVE_MONEY) return { ok: false, message: "FBLPoker.Errors.StaleRequest" };
        try {
          const value = await this.hostService.enqueueLocal({
            type: payload.type,
            data: payload.data ?? {},
            userId: payload.userId,
            token: payload.token,
            requestId: payload.requestId
          });
          return { ok: true, value: value ?? null };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== "FBLPoker.Errors.InvalidSession") {
            console.error("FBL Poker | Host query request failed", error);
          }
          return { ok: false, message };
        }
      }

      if (payload.kind === "delivery") {
        if (isHostClient()) return { ok: false, message: "FBLPoker.Errors.InvalidSession" };
        if (payload.userId !== game.user.id || payload.hostUserId !== activeHost()?.id || payload.hostUserId !== this.hostId) {
          return { ok: false, message: "FBLPoker.Errors.InvalidSession" };
        }
        if (!this.sessionToken || payload.token !== this.sessionToken) {
          return { ok: false, message: "FBLPoker.Errors.InvalidSession" };
        }
        await this.#handlePrivateData(payload.data);
        return { ok: true };
      }

      return { ok: false, message: "FBLPoker.Errors.InvalidRequest" };
    } catch (error) {
      console.error("FBL Poker | Query handler failed", error);
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async #onMessage(payload, senderId) {
    try {
      if (this.closed || !payload || typeof payload !== "object") return;
      if (payload.type !== REQUEST.SNAPSHOT) return;
      if (payload.hostUserId !== activeHost()?.id || senderId !== payload.hostUserId) return;
      if (!Number.isSafeInteger(payload.epoch) || !Number.isSafeInteger(payload.sequence)) return;
      this.#applySnapshot(payload);
    } catch (error) {
      console.error("FBL Poker | Socket message failed", error);
    }
  }
}

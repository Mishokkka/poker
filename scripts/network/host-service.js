import { ACTIONS, ACTIVE_STREETS, MODULE_ID, REQUEST, SCHEMA_VERSION, TABLE_STATUS } from "../constants.js";
import { CurrencyAdapter } from "../economy/fbl-currency.js";
import { createTableState, migrateTableState, PokerTableEngine } from "../engine/table-engine.js";
import { PokerStorage } from "../storage.js";
import { isHostClient, randomId } from "../util.js";
import { botThinkDelay, chooseBotAction, normalizeBotLevel, normalizeBotPersonality } from "../bots/bot-player.js";
import { validateEcdhPublicKey } from "./crypto.js";
import { presentationDelay } from "../presentation-timing.js";

function safeInteger(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function requestBoolean(value) {
  if (typeof value !== "boolean") throw new Error("FBLPoker.Errors.InvalidRequest");
  return value;
}

export class PokerHostService {
  constructor(socket) {
    this.socket = socket;
    this.storage = new PokerStorage();
    this.currency = new CurrencyAdapter();
    this.tables = new Map();
    this.sessions = new Map();
    this.turnTimers = new Map();
    this.botTimers = new Map();
    this.autoNextTimers = new Map();
    this.rejectedTables = new Map();
    this.persistedTables = {};
    this.persistedHistories = {};
    this.persistedHistoryRevisions = new Map();
    this.publishedHistoryRevisions = new Map();
    this.queue = Promise.resolve();
    this.receipts = new Map();
    this.moneyJournal = {};
    this.activeRequest = null;
    this.retiring = false;
    this.stopped = false;
    this.shutdownPromise = null;
  }

  async initialize() {
    this.retiring = false;
    this.stopped = false;
    this.shutdownPromise = null;
    this.tables.clear();
    this.rejectedTables.clear();
    this.persistedTables = {};
    this.persistedHistories = {};
    this.persistedHistoryRevisions.clear();
    this.publishedHistoryRevisions.clear();

    const [stored, storedHistories] = await Promise.all([
      this.storage.loadTables(),
      this.storage.loadHistories()
    ]);
    if (this.stopped || this.retiring) return;

    const worldSchemaVersion = Number(game.settings.get(MODULE_ID, "schemaVersion")) || 0;
    if (worldSchemaVersion > SCHEMA_VERSION) throw new Error("FBLPoker.Errors.UnsupportedSchema");

    let liveDirty = worldSchemaVersion < SCHEMA_VERSION;
    let historiesDirty = false;

    for (const [id, value] of Object.entries(stored)) {
      try {
        const archive = this.#historyArchive(storedHistories[id], value?.handHistory);
        const source = { ...value, handHistory: archive.hands };
        if (archive.revision !== null && source.historyRevision === undefined) source.historyRevision = archive.revision;

        const migrated = migrateTableState(source, worldSchemaVersion);
        const engine = new PokerTableEngine(migrated);
        engine.rollbackActiveHand();
        this.tables.set(id, engine);

        const legacyEmbeddedHistory = Object.hasOwn(value, "handHistory");
        const archiveNeedsWrite = archive.fromArchive
          ? archive.revision !== engine.state.historyRevision
          : engine.state.historyRevision > 0;
        const liveState = engine.storageState({ includeHistory: false });
        const storedLiveState = structuredClone(value);
        delete storedLiveState.handHistory;
        if (JSON.stringify(storedLiveState) !== JSON.stringify(liveState)) liveDirty = true;
        if (archiveNeedsWrite || (legacyEmbeddedHistory && engine.state.historyRevision > 0)) historiesDirty = true;

        this.persistedTables[id] = liveState;
        this.persistedHistories[id] = { revision: engine.state.historyRevision, hands: engine.historyState() };
        this.persistedHistoryRevisions.set(id, engine.state.historyRevision);
        this.publishedHistoryRevisions.set(id, engine.state.historyRevision);
      } catch (error) {
        this.rejectedTables.set(id, structuredClone(value));
        this.persistedTables[id] = structuredClone(value);
        if (storedHistories[id] !== undefined) this.persistedHistories[id] = structuredClone(storedHistories[id]);
        console.error(`FBL Poker | Rejected stored table ${id}; original data was preserved`, error);
      }
    }

    // Preserve orphaned archives rather than deleting data during recovery/migration.
    for (const [id, archive] of Object.entries(storedHistories)) {
      if (!(id in this.persistedHistories)) this.persistedHistories[id] = structuredClone(archive);
    }

    if (this.stopped || this.retiring) return;
    for (const engine of this.tables.values()) {
      const previousDeadline = engine.state.nextHandDeadline;
      this.#scheduleAutoNext(engine);
      if (engine.state.nextHandDeadline !== previousDeadline) {
        this.persistedTables[engine.state.id] = engine.storageState({ includeHistory: false });
        liveDirty = true;
      }
    }

    this.moneyJournal = structuredClone(game.settings.get(MODULE_ID, "moneyJournal") ?? {});
    await this.#recoverMoney();

    if (historiesDirty) await this.storage.saveHistories(this.persistedHistories);
    if (liveDirty) await this.storage.saveTables(this.persistedTables);
    if (this.stopped || this.retiring) return;

    if (worldSchemaVersion < SCHEMA_VERSION) {
      await game.settings.set(MODULE_ID, "schemaVersion", SCHEMA_VERSION);
    }
    if (this.stopped || this.retiring) return;

    await this.broadcastAll();
    if (this.rejectedTables.size) {
      globalThis.ui?.notifications?.warn(game.i18n.format("FBLPoker.Errors.StoredTablesRejected", { count: this.rejectedTables.size }));
    }
  }

  enqueue(payload) {
    if (this.stopped || this.retiring) {
      return Promise.resolve()
        .then(() => this.socket.sendError(payload.userId, new Error("FBLPoker.Errors.NotReady"), payload.requestId))
        .catch((deliveryError) => console.error("FBL Poker | Could not deliver host request error", deliveryError));
    }

    const operation = this.queue.then(async () => {
      await this.handle(payload);
      await this.socket.sendAck(payload.userId, payload.requestId);
    });
    this.queue = operation.catch(async (error) => {
      try {
        await this.socket.sendError(payload.userId, error, payload.requestId);
      } catch (deliveryError) {
        console.error("FBL Poker | Could not deliver host request error", deliveryError);
      }
    });
    return this.queue;
  }

  enqueueLocal(payload) {
    if (this.stopped || this.retiring) return Promise.reject(new Error("FBLPoker.Errors.NotReady"));
    const operation = this.queue.then(() => this.handle(payload));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async sendPrivateHandsForUser(userId) {
    const deliveries = [];
    for (const engine of this.tables.values()) {
      if (!engine.isActiveHand) continue;
      for (const { seatIndex, cards } of engine.privateHands()) {
        const seat = engine.state.seats[seatIndex];
        if (seat?.isBot || seat?.userId !== userId) continue;
        deliveries.push(this.socket.sendPrivate(userId, {
          kind: "holeCards",
          tableId: engine.state.id,
          handNumber: engine.state.handNumber,
          seatIndex,
          cards
        }));
      }
    }
    await Promise.all(deliveries);
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.retiring = true;
    for (const tableId of [...this.turnTimers.keys()]) this.#clearTimer(tableId);
    for (const tableId of [...this.botTimers.keys()]) this.#clearBotTimer(tableId);
    for (const tableId of [...this.autoNextTimers.keys()]) this.#clearAutoNextTimer(tableId);

    const drain = this.queue.catch(() => undefined);
    this.shutdownPromise = drain.finally(() => {
      this.stopped = true;
      this.sessions.clear();
    });
    return this.shutdownPromise;
  }

  async registerSession(userId, publicKey = null) {
    if (this.stopped || this.retiring) return null;
    if (publicKey !== null && !(await validateEcdhPublicKey(publicKey))) return null;
    if (this.stopped || this.retiring) return null;
    const user = game.users.get(userId);
    if (!user?.active) return null;
    const session = {
      userId,
      publicKey: publicKey === null ? null : structuredClone(publicKey),
      transport: publicKey === null ? "query" : "ecdh",
      token: randomId("session-"),
      createdAt: Date.now()
    };
    this.sessions.set(userId, session);
    return session;
  }

  isBotSeat(tableId, seatIndex) {
    const index = safeInteger(seatIndex);
    if (index === null) return false;
    return Boolean(this.tables.get(tableId)?.state?.seats?.[index]?.isBot);
  }

  async handle(payload) {
    this.#validateSession(payload);
    if (payload.type === REQUEST.REQUEST_STATE) return this.#dispatch(payload);
    const key = payload.requestId ? `${payload.userId}:${payload.requestId}` : randomId("internal-");
    const fingerprint = JSON.stringify([payload.type, payload.data]);
    const receipt = this.receipts.get(key);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Error("FBLPoker.Errors.InvalidRequest");
      if (receipt.error) throw new Error(receipt.error);
      return receipt.value;
    }
    const durable = Object.values(this.moneyJournal).find((entry) => entry.requestKey === key);
    if (durable && durable.fingerprint !== fingerprint) throw new Error("FBLPoker.Errors.InvalidRequest");
    if (durable?.status === "cancelled") throw new Error("FBLPoker.Errors.InvalidRequest");
    if (durable?.status === "committed" && [REQUEST.JOIN, REQUEST.TOP_UP, REQUEST.CASH_OUT, REQUEST.LEAVE].includes(payload.type)) return;
    this.activeRequest = { key, fingerprint };
    try {
      if (payload.data?.expected && payload.data.tableId) {
        const state = this.tables.get(payload.data.tableId)?.state;
        const expected = payload.data.expected;
        if (!state || state.handNumber !== expected.handNumber || state.status !== expected.status || state.revision !== expected.revision) {
          throw new Error("FBLPoker.Errors.StaleRequest");
        }
      }
      const value = await this.#dispatch(payload);
      this.receipts.set(key, { fingerprint, value });
      return value;
    } catch (error) {
      this.receipts.set(key, { fingerprint, error: error.message });
      throw error;
    } finally { this.activeRequest = null; }
  }

  async #dispatch(payload) {
    if (this.stopped || this.retiring) throw new Error("FBLPoker.Errors.NotReady");
    const session = this.#validateSession(payload);
    const user = game.users.get(session.userId);
    switch (payload.type) {
      case REQUEST.REQUEST_STATE:
        await this.#recoverMoney();
        for (const engine of this.tables.values()) {
          if (engine.state.deliveryPending) await this.#mutated(engine, { sendHands: true, resetTurn: true });
        }
        await this.sendPrivateHandsForUser(user.id);
        return { kind: "snapshot", ...this.socket.snapshotEnvelope?.(), tables: this.#publicStates(),
          automation: user.isGM ? this.automationState() : undefined };
      case REQUEST.RESOLVE_MONEY:
        this.#requireGM(user);
        await this.#resolveMoney(user, payload.data);
        return;
      case REQUEST.CREATE_TABLE:
        this.#requireGM(user);
        await this.#createTable(payload.data);
        return;
      case REQUEST.UPDATE_TABLE:
        this.#requireGM(user);
        await this.#updateTable(payload.data);
        return;
      case REQUEST.DELETE_TABLE:
        this.#requireGM(user);
        await this.#deleteTable(payload.data.tableId);
        return;
      case REQUEST.JOIN:
        await this.#join(user, payload.data);
        return;
      case REQUEST.MOVE_SEAT:
        await this.#moveSeat(user, payload.data);
        return;
      case REQUEST.LEAVE:
      case REQUEST.CASH_OUT:
        await this.#cashOut(user, payload.data);
        return;
      case REQUEST.TOP_UP:
        await this.#topUp(user, payload.data);
        return;
      case REQUEST.SIT_OUT:
        await this.#setSittingOut(user, payload.data, true);
        return;
      case REQUEST.SIT_IN:
        await this.#setSittingOut(user, payload.data, false);
        return;
      case REQUEST.TOGGLE_SIT_OUT_AFTER_HAND:
        await this.#toggleSitOutAfterHand(user, payload.data);
        return;
      case REQUEST.TOGGLE_LEAVE_AFTER_HAND:
        await this.#toggleLeaveAfterHand(user, payload.data);
        return;
      case REQUEST.START_HAND:
      case REQUEST.NEXT_HAND:
        this.#requireGM(user);
        await this.#startHand(payload.data.tableId);
        return;
      case REQUEST.ACTION:
        await this.#action(user, payload.data);
        return;
      case REQUEST.PAUSE_TABLE:
        this.#requireGM(user);
        await this.#setPaused(payload.data.tableId, true);
        return;
      case REQUEST.RESUME_TABLE:
        this.#requireGM(user);
        await this.#setPaused(payload.data.tableId, false);
        return;
      case REQUEST.FORCE_RESET:
        this.#requireGM(user);
        await this.#forceReset(payload.data.tableId);
        return;
      case REQUEST.SET_AUTO_NEXT:
        this.#requireGM(user);
        await this.#setAutoNext(payload.data.tableId, payload.data.enabled);
        return;
      case REQUEST.SET_CARDS_REVEALED:
        await this.#setCardsRevealed(user, payload.data);
        return;
      default:
        throw new Error("FBLPoker.Errors.InvalidRequest");
    }
  }

  async persist(engine = null, { historyChanged = false } = {}) {
    if (this.stopped) return;

    if (!engine) {
      const nextTables = Object.fromEntries(this.rejectedTables);
      const nextHistories = { ...this.persistedHistories };
      for (const [id, candidate] of this.tables) {
        nextTables[id] = candidate.storageState({ includeHistory: false });
        nextHistories[id] = { revision: candidate.state.historyRevision, hands: candidate.historyState() };
        this.persistedHistoryRevisions.set(id, candidate.state.historyRevision);
      }
      this.persistedTables = nextTables;
      this.persistedHistories = nextHistories;
      await this.storage.saveHistories(this.persistedHistories);
      await this.storage.saveTables(this.persistedTables);
      return;
    }

    const id = engine.state.id;
    this.persistedTables[id] = engine.storageState({ includeHistory: false });
    await this.storage.saveTables(this.persistedTables);

    if (historyChanged) {
      this.persistedHistories[id] = { revision: engine.state.historyRevision, hands: engine.historyState() };
      await this.storage.saveHistories(this.persistedHistories);
      this.persistedHistoryRevisions.set(id, engine.state.historyRevision);
    }
  }

  #publicStates() {
    return [...this.tables.values()].map((engine) => engine.publicState());
  }

  async broadcastAll() {
    if (this.stopped) return;
    const tables = this.#publicStates();
    for (const engine of this.tables.values()) this.publishedHistoryRevisions.set(engine.state.id, engine.state.historyRevision);
    await this.socket.publishSnapshot(tables, { full: true });
  }

  async #broadcastTable(engine, { historyChanged = false } = {}) {
    if (this.stopped) return;
    const automation = { [engine.state.id]: this.automationState()[engine.state.id] };
    for (const user of game.users.contents ?? []) {
      if (user.isGM && user.active && user.id !== game.user.id) void this.socket.sendPrivate(user.id, { kind: "automation", tables: automation }).catch(() => undefined);
    }
    const table = engine.publicState({ includeHistory: false });
    const historyUpdates = [];
    if (historyChanged) {
      const hand = engine.state.handHistory.find((entry) => entry.handNumber === engine.state.handNumber) ?? engine.state.handHistory[0] ?? null;
      if (hand) {
        historyUpdates.push({
          tableId: engine.state.id,
          revision: engine.state.historyRevision,
          hand: structuredClone(hand)
        });
      }
      this.publishedHistoryRevisions.set(engine.state.id, engine.state.historyRevision);
    }
    await this.socket.publishSnapshot([table], { full: false, historyUpdates });
  }

  async #broadcastDeletion(tableId) {
    if (this.stopped) return;
    this.publishedHistoryRevisions.delete(tableId);
    await this.socket.publishSnapshot([], { full: false, deletedTableIds: [tableId] });
  }

  async #mutated(engine, { sendHands = false, resetTurn = false, resetAutoNext = false } = {}) {
    if (sendHands) {
      this.#clearTimer(engine.state.id);
      this.#clearBotTimer(engine.state.id);
      engine.state.deliveryPending = true;
      engine.state.turnDeadline = null;
      try { await this.#sendPrivateHands(engine); engine.state.deliveryPending = false; }
      catch (error) { console.warn("FBL Poker | Waiting for private-card delivery", error); }
    }
    const previous = this.persistedTables[engine.state.id];
    const carryGrace = previous?.handNumber === engine.state.handNumber
      && (ACTIVE_STREETS.has(engine.state.status) || (engine.state.status === TABLE_STATUS.COMPLETE && previous.community.length > 0))
      && !engine.state.paused && !engine.state.deliveryPending && !engine.state.recoveryRequired
      ? Math.max(0, (previous.turnDeadline ?? 0) - previous.actionSeconds * 1000 - Date.now()) : 0;
    const grace = Math.max(carryGrace, presentationDelay(previous, engine.state));
    this.#scheduleTurn(engine, { reset: resetTurn, grace });
    this.#scheduleAutoNext(engine, { reset: resetAutoNext, grace });
    const historyChanged = (this.persistedHistoryRevisions.get(engine.state.id) ?? 0) !== engine.state.historyRevision;
    try { await this.persist(engine, { historyChanged }); }
    catch (error) {
      this.#block(engine);
      await this.#broadcastTable(engine).catch(() => undefined);
      throw error;
    }
    const publishHistory = (this.publishedHistoryRevisions.get(engine.state.id) ?? 0) !== engine.state.historyRevision;
    // A notification failure cannot roll back a committed game or wallet operation.
    await this.#broadcastTable(engine, { historyChanged: publishHistory }).catch((error) => console.warn("FBL Poker | Snapshot delivery failed", error));
    this.#scheduleBotTurn(engine);
  }

  #historyArchive(entry, legacyHands = []) {
    if (Array.isArray(entry)) return { fromArchive: true, revision: null, hands: entry };
    if (entry && typeof entry === "object" && !Array.isArray(entry) && Array.isArray(entry.hands)) {
      const revision = Number.isSafeInteger(entry.revision) && entry.revision >= 0 ? entry.revision : null;
      return { fromArchive: true, revision, hands: entry.hands };
    }
    return { fromArchive: false, revision: null, hands: Array.isArray(legacyHands) ? legacyHands : [] };
  }

  async #createTable(data) {
    const id = randomId("table-");
    const engine = new PokerTableEngine(createTableState({ ...data, id }));
    this.tables.set(id, engine);
    await this.#mutated(engine);
  }

  async #updateTable(data) {
    const engine = this.#table(data.tableId);
    engine.updateConfiguration(data);
    await this.#mutated(engine, { resetAutoNext: true });
  }

  async #deleteTable(tableId) {
    const engine = this.#table(tableId);
    if (engine.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");

    const failedPayouts = [];
    for (const seat of [...engine.state.seats.filter(Boolean)]) {
      try {
        await this.#creditSeat(engine, seat, "tableDeleted");
      } catch (error) {
        if (engine.state.recoveryRequired) throw error;
        failedPayouts.push({ seat, error });
        console.error(`FBL Poker | Could not return chips to ${seat.actorName ?? seat.actorId} while deleting table`, error);
        await this.storage.appendLedger({
          id: randomId("tx-failed-"),
          at: Date.now(),
          tableId: engine.state.id,
          tableName: engine.state.name,
          actorId: seat.actorId,
          actorName: seat.actorName,
          userId: seat.userId ?? null,
          reason: "tableDeletePayoutFailed",
          status: "failed",
          chips: seat.stack,
          copper: seat.stack * engine.state.chipValueCopper,
          error: error instanceof Error ? error.message : String(error)
        }).catch((ledgerError) => console.error("FBL Poker | Could not record failed table-deletion payout", ledgerError));
      }
    }

    if (failedPayouts.length) {
      await this.persist(engine);
      await this.#broadcastTable(engine);
      const actors = failedPayouts.map(({ seat }) => seat.actorName ?? seat.actorId).join(", ");
      throw new Error(game.i18n.format("FBLPoker.Errors.TableDeletePayoutFailed", { actors }));
    }

    this.tables.delete(tableId);
    this.rejectedTables.delete(tableId);
    delete this.persistedTables[tableId];
    delete this.persistedHistories[tableId];
    this.persistedHistoryRevisions.delete(tableId);
    this.#clearTimer(tableId);
    this.#clearBotTimer(tableId);
    this.#clearAutoNextTimer(tableId);
    await this.storage.saveHistories(this.persistedHistories);
    await this.storage.saveTables(this.persistedTables);
    await this.#broadcastDeletion(tableId);
  }

  async #join(user, data) {
    const engine = this.#table(data.tableId);
    if (engine.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");
    const actor = game.actors.get(data.actorId);
    if (!actor || !this.currency.actorOwnedBy(actor, user)) throw new Error("FBLPoker.Errors.ActorNotOwned");
    const botLevel = normalizeBotLevel(data.botLevel);
    const botPersonality = normalizeBotPersonality(data.botPersonality);
    if (data.botLevel && !botLevel) throw new Error("FBLPoker.Errors.InvalidBotLevel");
    if (data.botPersonality && !botPersonality) throw new Error("FBLPoker.Errors.InvalidBotPersonality");
    if (botLevel && !user.isGM) throw new Error("FBLPoker.Errors.GMOnly");
    if ([...this.tables.values()].some((other) => other.state.seats.some((seat) => seat?.actorId === actor.id))) {
      throw new Error("FBLPoker.Errors.ActorAlreadySeated");
    }
    if (!user.isGM && [...this.tables.values()].some((other) => other.state.seats.some((seat) => seat?.userId === user.id))) {
      throw new Error("FBLPoker.Errors.UserAlreadySeated");
    }
    const buyIn = safeInteger(data.buyIn);
    if (buyIn === null || buyIn < engine.state.minBuyIn || buyIn > engine.state.maxBuyIn) {
      throw new Error("FBLPoker.Errors.BuyInRange");
    }
    const seatIndex = safeInteger(data.seatIndex);
    if (seatIndex === null) throw new Error("FBLPoker.Errors.InvalidSeat");
    const cost = buyIn * engine.state.chipValueCopper;
    if (!Number.isSafeInteger(cost)) throw new Error("FBLPoker.Errors.InvalidCurrencyChange");
    const balance = this.currency.balance(actor);
    const isBot = Boolean(botLevel);
    // A GM may grant the missing buy-in to any seat, regardless of its controller.
    const chargedCost = user.isGM ? Math.min(cost, balance.totalCopper) : cost;
    const target = new PokerTableEngine(engine.storageState());
    target.addSeat(seatIndex, {
      userId: user.id, actorId: actor.id, actorName: actor.name, actorImg: actor.img,
      stack: buyIn, isBot, botLevel, botPersonality: botLevel ? (botPersonality ?? "calm") : null
    });
    await this.#money(engine, target, actor, user, -chargedCost, "buyIn", { subsidyCopper: cost - chargedCost });
  }

  async #moveSeat(user, data) {
    const engine = this.#table(data.tableId);
    if (engine.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");
    const fromIndex = safeInteger(data.fromSeatIndex);
    const toIndex = safeInteger(data.toSeatIndex);
    const seat = this.#ownedSeat(engine, user, fromIndex);
    if (!user.isGM) {
      const ownedSeats = [...this.tables.values()].flatMap((other) => other.state.seats.filter((candidate) => candidate?.userId === user.id));
      if (ownedSeats.length !== 1 || ownedSeats[0].actorId !== seat.actorId) throw new Error("FBLPoker.Errors.UserAlreadySeated");
    }
    engine.moveSeat(fromIndex, toIndex);
    await this.#mutated(engine);
  }

  async #topUp(user, data) {
    const engine = this.#table(data.tableId);
    if (engine.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");
    const seat = this.#ownedSeat(engine, user, data.seatIndex);
    const actor = game.actors.get(seat.actorId);
    if (!actor) throw new Error("FBLPoker.Errors.ActorMissing");
    const chips = safeInteger(data.amount);
    if (chips === null || chips < 1) throw new Error("FBLPoker.Errors.InvalidTopUp");
    if ((seat.stack + chips) > engine.state.maxBuyIn) throw new Error("FBLPoker.Errors.TopUpLimit");
    const cost = chips * engine.state.chipValueCopper;
    if (!this.currency.actorOwnedBy(actor, user)) throw new Error("FBLPoker.Errors.ActorNotOwned");
    const target = new PokerTableEngine(engine.storageState());
    target.addChips(seat.index, chips);
    await this.#money(engine, target, actor, user, -cost, "topUp");
  }

  async #cashOut(user, data) {
    const engine = this.#table(data.tableId);
    const seat = this.#ownedSeat(engine, user, data.seatIndex);
    if (engine.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");
    await this.#creditSeat(engine, seat, "cashOut");
  }

  async #creditSeat(engine, seat, reason) {
    const actor = game.actors.get(seat.actorId);
    if (!actor) throw new Error("FBLPoker.Errors.ActorMissing");
    const target = new PokerTableEngine(engine.storageState());
    target.removeSeat(seat.index);
    await this.#money(engine, target, actor, game.users.get(seat.userId), seat.stack * engine.state.chipValueCopper, reason);
  }

  async #saveJournal() {
    await game.settings.set(MODULE_ID, "moneyJournal", structuredClone(this.moneyJournal));
  }

  #block(engine) {
    if (!engine.state.recoveryRequired) engine.touch();
    engine.state.recoveryRequired = true;
    engine.state.turnDeadline = null;
    engine.state.nextHandDeadline = null;
    this.#clearTimer(engine.state.id);
    this.#clearBotTimer(engine.state.id);
    this.#clearAutoNextTimer(engine.state.id);
  }

  async #money(engine, target, actor, user, delta, reason, extra = {}) {
    if (Object.values(this.moneyJournal).some((entry) => entry.status === "pending" && (entry.actorId === actor.id || entry.tableId === engine.state.id))) {
      throw new Error("FBLPoker.Errors.RecoveryRequired");
    }
    const before = this.currency.balance(actor).totalCopper;
    const after = before + delta;
    if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(after)) throw new Error("FBLPoker.Errors.InvalidCurrencyChange");
    if (after < 0) throw new Error("FBLPoker.Errors.NotEnoughCurrency");
    const id = randomId("money-");
    const entry = { id, status: "pending", at: Date.now(), tableId: engine.state.id, actorId: actor.id,
      tableName: engine.state.name, actorName: actor.name, currencyRates: this.currency.rates, chipValueCopper: engine.state.chipValueCopper,
      userId: user?.id, reason, beforeCopper: before, afterCopper: after, deltaCopper: delta, ...extra,
      requestKey: this.activeRequest?.key, fingerprint: this.activeRequest?.fingerprint,
      beforeState: engine.storageState(), afterState: target.storageState() };
    this.moneyJournal[id] = entry;
    try {
      // Intent is durable before the Actor write; never compensate an ambiguous write.
      await this.#saveJournal();
      const walletReason = reason === "buyIn" ? (extra.subsidyCopper > 0 ? "pokerBuyInGMOverride" : "pokerBuyIn") : reason === "topUp" ? "pokerTopUp" : reason;
      await this.currency.change(actor, delta, { reason: walletReason, tableId: engine.state.id, transactionId: id, expectedBefore: before });
      await this.#finishMoney(entry, engine, entry.afterState);
    } catch (error) {
      this.#block(engine);
      await this.#broadcastTable(engine).catch(() => undefined);
      console.error("FBL Poker | Money operation requires reconciliation", id, error);
      throw new Error("FBLPoker.Errors.RecoveryRequired");
    }
    await this.#mutated(engine);
  }

  async #finishMoney(entry, engine, state, status = "committed") {
    // Keep the engine instance: its private cards may still be revealed after a hand.
    const revision = Math.max(state.revision, engine.state.revision + 1);
    engine.state = structuredClone(state);
    engine.state.revision = revision;
    engine.state.updatedAt = Date.now();
    delete engine.state.recoveryRequired;
    await this.persist(engine);
    const compact = { ...entry, status };
    delete compact.beforeState;
    delete compact.afterState;
    this.moneyJournal[entry.id] = compact;
    try { await this.#saveJournal(); }
    catch (error) { this.moneyJournal[entry.id] = entry; throw error; }
    await this.storage.appendLedger(compact).catch((error) => console.error("FBL Poker | Ledger append failed", error));
  }

  async #recoverMoney() {
    for (const entry of Object.values(this.moneyJournal)) {
      if (entry.status !== "pending") continue;
      const engine = this.tables.get(entry.tableId);
      if (!engine) continue;
      const actor = game.actors.get(entry.actorId);
      if (actor?.flags?.[MODULE_ID]?.moneyTx?.id === entry.id) {
        try { await this.#finishMoney(entry, engine, entry.afterState); await this.#mutated(engine); }
        catch (error) { this.#block(engine); console.error("FBL Poker | Recovery write failed", error); }
      } else this.#block(engine);
    }
  }

  async #resolveMoney(user, { operationId, applied }) {
    const entry = this.moneyJournal[operationId];
    if (!entry || entry.status !== "pending" || typeof applied !== "boolean") throw new Error("FBLPoker.Errors.InvalidRequest");
    const engine = this.tables.get(entry.tableId);
    if (!engine) throw new Error("FBLPoker.Errors.TableMissing");
    if (!applied && game.actors.get(entry.actorId)?.flags?.[MODULE_ID]?.moneyTx?.id === entry.id) throw new Error("FBLPoker.Errors.InvalidRequest");
    entry.resolution = { userId: user.id, at: Date.now(), applied };
    // Explicit GM reconciliation of an ambiguous Actor response; this never writes currency.
    try { await this.#finishMoney(entry, engine, applied ? entry.afterState : entry.beforeState, applied ? "committed" : "cancelled"); }
    catch (error) {
      this.#block(engine);
      await this.#broadcastTable(engine).catch(() => undefined);
      throw new Error("FBLPoker.Errors.RecoveryRequired", { cause: error });
    }
    await this.#mutated(engine);
  }

  automationState() {
    return Object.fromEntries([...this.tables].map(([id, engine]) => [id, { revision: engine.state.revision, seats: engine.state.seats.filter((seat) => seat?.isBot).map((seat) => seat.index) }]));
  }

  async #setSittingOut(user, data, value) {
    const engine = this.#table(data.tableId);
    const seat = this.#ownedSeat(engine, user, data.seatIndex);
    engine.setSittingOut(seat.index, value);
    await this.#mutated(engine);
  }

  async #toggleSitOutAfterHand(user, data) {
    const engine = this.#table(data.tableId);
    const seat = this.#ownedSeat(engine, user, data.seatIndex);
    engine.toggleSitOutAfterHand(seat.index);
    await this.#mutated(engine);
  }

  async #toggleLeaveAfterHand(user, data) {
    const engine = this.#table(data.tableId);
    const seat = this.#ownedSeat(engine, user, data.seatIndex);
    engine.toggleLeaveAfterHand(seat.index);
    await this.#mutated(engine);
  }

  async #startHand(tableId) {
    const engine = this.#table(tableId);
    this.#clearAutoNextTimer(tableId);
    engine.state.nextHandDeadline = null;
    engine.state.currencyRates = this.currency.rates;
    engine.startHand();
    await this.#mutated(engine, { sendHands: true, resetTurn: true });
  }

  async #action(user, data) {
    const engine = this.#table(data.tableId);
    const seat = this.#ownedSeat(engine, user, data.seatIndex);
    engine.act(seat.index, data.action, data.amount);
    await this.#mutated(engine, { resetTurn: true });
    await this.#afterCompletedHand(engine);
  }

  async #setPaused(tableId, paused) {
    const engine = this.#table(tableId);
    engine.setPaused(paused);
    await this.#mutated(engine);
  }

  async #forceReset(tableId) {
    const engine = this.#table(tableId);
    this.#clearAutoNextTimer(tableId);
    engine.forceReset();
    await this.#mutated(engine);
  }

  async #setAutoNext(tableId, enabled) {
    const engine = this.#table(tableId);
    engine.setAutoNext(requestBoolean(enabled));
    await this.#mutated(engine, { resetAutoNext: true });
  }

  async #setCardsRevealed(user, data) {
    const engine = this.#table(data.tableId);
    const seat = this.#ownedSeat(engine, user, data.seatIndex);
    engine.setCardsRevealed(seat.index, requestBoolean(data.revealed));
    await this.#mutated(engine);
  }

  async #afterCompletedHand(engine) {
    if (engine.state.status !== TABLE_STATUS.COMPLETE) return;
    let changed = false;
    for (const seat of [...engine.state.seats.filter(Boolean)]) {
      if (seat.leaveAfterHand) {
        try {
          await this.#creditSeat(engine, seat, "leaveAfterHand");
          changed = true;
        } catch (error) {
          if (engine.state.recoveryRequired) throw error;
          console.error("FBL Poker | Deferred cash-out failed", error);
          const retained = engine.state.seats[seat.index];
          retained.leaveAfterHand = false;
          retained.sittingOut = true;
          engine.touch();
          changed = true;
        }
      } else if (seat.sitOutAfterHand) {
        engine.setSittingOut(seat.index, true);
        changed = true;
      }
    }
    if (changed) await this.#mutated(engine);
  }

  async #sendPrivateHands(engine) {
    const deliveries = [];
    for (const { seatIndex, cards } of engine.privateHands()) {
      const seat = engine.state.seats[seatIndex];
      if (!seat || seat.isBot) continue;
      deliveries.push(this.socket.sendPrivate(seat.userId, {
        kind: "holeCards",
        tableId: engine.state.id,
        handNumber: engine.state.handNumber,
        seatIndex,
        cards
      }));
    }
    await Promise.all(deliveries);
  }

  #scheduleTurn(engine, { reset = false, grace = 0 } = {}) {
    this.#clearTimer(engine.state.id);
    if (this.stopped || this.retiring) return;
    this.#clearBotTimer(engine.state.id);
    if (engine.state.recoveryRequired || engine.state.deliveryPending || engine.state.paused || !ACTIVE_STREETS.has(engine.state.status) || engine.state.currentSeat === null) {
      engine.state.turnDeadline = null;
      return;
    }

    const revision = engine.state.revision;
    const seatIndex = engine.state.currentSeat;
    let duration = engine.state.actionSeconds * 1000 + grace;

    if (!reset && engine.state.turnTimeRemaining !== null) {
      duration = Math.max(0, engine.state.turnTimeRemaining);
      engine.state.turnTimeRemaining = null;
    } else if (!reset && engine.state.turnDeadline && engine.state.turnDeadline > Date.now()) {
      duration = engine.state.turnDeadline - Date.now();
    } else {
      engine.state.turnTimeRemaining = null;
    }

    const deadline = Date.now() + Math.max(0, duration);
    engine.state.turnDeadline = deadline;
    let timer = null;
    timer = setTimeout(() => {
      const operation = this.queue.then(async () => {
        if (this.turnTimers.get(engine.state.id) !== timer) return;
        this.turnTimers.delete(engine.state.id);
        if (this.stopped || this.retiring || !isHostClient() || engine.state.paused || engine.state.revision !== revision || engine.state.currentSeat !== seatIndex) return;
        const legal = engine.legalActions(seatIndex);
        if (!legal) return;
        engine.act(seatIndex, legal.canCheck ? ACTIONS.CHECK : ACTIONS.FOLD);
        await this.#mutated(engine, { resetTurn: true });
        await this.#afterCompletedHand(engine);
      });
      this.queue = operation.catch((error) => console.error("FBL Poker | Turn timer failed", error));
    }, Math.max(0, duration));
    this.turnTimers.set(engine.state.id, timer);
  }

  #scheduleBotTurn(engine) {
    this.#clearBotTimer(engine.state.id);
    if (this.stopped || this.retiring) return;
    if (engine.state.recoveryRequired || engine.state.deliveryPending || engine.state.paused || !ACTIVE_STREETS.has(engine.state.status) || engine.state.currentSeat === null) return;
    const seatIndex = engine.state.currentSeat;
    const seat = engine.state.seats[seatIndex];
    if (!seat?.isBot || !normalizeBotLevel(seat.botLevel)) return;

    const revision = engine.state.revision;
    const handNumber = engine.state.handNumber;
    const grace = Math.max(0, (engine.state.turnDeadline ?? 0) - engine.state.actionSeconds * 1000 - Date.now());
    const delay = grace + botThinkDelay(seat.botLevel, seat.botPersonality);
    const timer = setTimeout(() => {
      const operation = this.queue.then(async () => {
        if (this.botTimers.get(engine.state.id) !== timer) return;
        this.botTimers.delete(engine.state.id);
        if (this.stopped || this.retiring || !isHostClient()) return;
        if (engine.state.paused || engine.state.revision !== revision || engine.state.handNumber !== handNumber || engine.state.currentSeat !== seatIndex) return;
        const currentSeat = engine.state.seats[seatIndex];
        if (!currentSeat?.isBot) return;

        let decision;
        try {
          decision = chooseBotAction(engine, seatIndex, currentSeat.botLevel, currentSeat.botPersonality);
          engine.act(seatIndex, decision.action, decision.amount);
        } catch (error) {
          console.error("FBL Poker | Bot decision failed", error);
          const legal = engine.legalActions(seatIndex);
          if (!legal) return;
          engine.act(seatIndex, legal.canCheck ? ACTIONS.CHECK : ACTIONS.FOLD);
        }

        await this.#mutated(engine, { resetTurn: true });
        await this.#afterCompletedHand(engine);
      });
      this.queue = operation.catch((error) => console.error("FBL Poker | Bot turn failed", error));
    }, delay);
    this.botTimers.set(engine.state.id, timer);
  }

  #scheduleAutoNext(engine, { reset = false, grace = 0 } = {}) {
    const tableId = engine.state.id;
    if (this.stopped || this.retiring) {
      this.#clearAutoNextTimer(tableId);
      return;
    }
    const eligibleCount = engine.state.seats.filter((seat) => seat && !seat.sittingOut && !seat.leaveAfterHand && !seat.sitOutAfterHand && seat.stack > 0).length;
    const shouldRun = !engine.state.recoveryRequired && !engine.state.deliveryPending && engine.state.autoNextHand && engine.state.status === TABLE_STATUS.COMPLETE && eligibleCount >= 2;

    if (!shouldRun) {
      this.#clearAutoNextTimer(tableId);
      engine.state.nextHandDeadline = null;
      return;
    }

    const existing = this.autoNextTimers.get(tableId);
    if (!reset && existing && engine.state.nextHandDeadline && engine.state.nextHandDeadline > Date.now()) return;

    this.#clearAutoNextTimer(tableId);
    let duration = grace + Math.max(1000, Number(engine.state.autoNextHandSeconds || 1) * 1000);
    if (!reset && engine.state.nextHandDeadline && engine.state.nextHandDeadline > Date.now()) {
      duration = engine.state.nextHandDeadline - Date.now();
    }
    engine.state.nextHandDeadline = Date.now() + duration;
    const handNumber = engine.state.handNumber;
    let timer = null;
    timer = setTimeout(() => {
      const operation = this.queue.then(async () => {
        if (this.autoNextTimers.get(tableId) !== timer) return;
        this.autoNextTimers.delete(tableId);
        if (this.stopped || this.retiring || !isHostClient()) return;
        const current = this.tables.get(tableId);
        if (!current || current.state.status !== TABLE_STATUS.COMPLETE || current.state.handNumber !== handNumber || !current.state.autoNextHand) return;
        const available = current.state.seats.filter((seat) => seat && !seat.sittingOut && !seat.leaveAfterHand && !seat.sitOutAfterHand && seat.stack > 0).length;
        if (available < 2) {
          current.state.nextHandDeadline = null;
          current.touch();
          await this.persist(current);
          await this.#broadcastTable(current);
          return;
        }
        current.state.nextHandDeadline = null;
        current.state.currencyRates = this.currency.rates;
        current.startHand();
        await this.#mutated(current, { sendHands: true, resetTurn: true });
      });
      this.queue = operation.catch((error) => console.error("FBL Poker | Auto-next hand failed", error));
    }, duration);
    this.autoNextTimers.set(tableId, timer);
  }

  #clearAutoNextTimer(tableId) {
    const timer = this.autoNextTimers.get(tableId);
    if (timer) clearTimeout(timer);
    this.autoNextTimers.delete(tableId);
  }

  #clearBotTimer(tableId) {
    const timer = this.botTimers.get(tableId);
    if (timer) clearTimeout(timer);
    this.botTimers.delete(tableId);
  }

  #clearTimer(tableId) {
    const timer = this.turnTimers.get(tableId);
    if (timer) clearTimeout(timer);
    this.turnTimers.delete(tableId);
  }


  #ownedSeat(engine, user, seatIndex) {
    const index = safeInteger(seatIndex);
    if (index === null || index < 0 || index >= engine.state.maxSeats) throw new Error("FBLPoker.Errors.InvalidSeat");
    const seat = engine.state.seats[index];
    if (!seat) throw new Error("FBLPoker.Errors.EmptySeat");
    if (!user?.isGM && seat.userId !== user?.id) throw new Error("FBLPoker.Errors.NotSeatOwner");
    return seat;
  }

  #validateSession(payload) {
    const session = this.sessions.get(payload.userId);
    if (!session || session.token !== payload.token) throw new Error("FBLPoker.Errors.InvalidSession");
    return session;
  }

  #requireGM(user) {
    if (!user?.isGM) throw new Error("FBLPoker.Errors.GMOnly");
  }

  #table(id) {
    const engine = this.tables.get(id);
    if (!engine) throw new Error("FBLPoker.Errors.TableMissing");
    if (engine.state.recoveryRequired) throw new Error("FBLPoker.Errors.RecoveryRequired");
    return engine;
  }
}

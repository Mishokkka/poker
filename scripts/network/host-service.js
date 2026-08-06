import { ACTIONS, ACTIVE_STREETS, MODULE_ID, REQUEST, SCHEMA_VERSION, TABLE_STATUS } from "../constants.js";
import { CurrencyAdapter } from "../economy/fbl-currency.js";
import { createTableState, migrateTableState, PokerTableEngine } from "../engine/table-engine.js";
import { PokerStorage } from "../storage.js";
import { isHostClient, randomId } from "../util.js";
import { botThinkDelay, chooseBotAction, normalizeBotLevel, normalizeBotPersonality } from "../bots/bot-player.js";

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
    this.queue = Promise.resolve();
  }

  async initialize() {
    const stored = await this.storage.loadTables();
    const worldSchemaVersion = Number(game.settings.get(MODULE_ID, "schemaVersion")) || 0;
    for (const [id, value] of Object.entries(stored)) {
      const migrated = migrateTableState(value, worldSchemaVersion);
      const engine = new PokerTableEngine(migrated);
      engine.rollbackActiveHand();
      this.tables.set(id, engine);
    }
    for (const engine of this.tables.values()) this.#scheduleAutoNext(engine);
    await this.persist();
    if (worldSchemaVersion !== SCHEMA_VERSION) {
      await game.settings.set(MODULE_ID, "schemaVersion", SCHEMA_VERSION);
    }
    await this.broadcastAll();
  }

  enqueue(payload) {
    const operation = this.queue.then(async () => {
      await this.handle(payload);
      await this.socket.sendAck(payload.userId, payload.requestId);
    });
    this.queue = operation.catch((error) => this.socket.sendError(payload.userId, error, payload.requestId));
    return this.queue;
  }

  enqueueLocal(payload) {
    const operation = this.queue.then(() => this.handle(payload));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async sendPrivateHandsForUser(userId) {
    for (const engine of this.tables.values()) {
      if (!engine.isActiveHand) continue;
      for (const { seatIndex, cards } of engine.privateHands()) {
        const seat = engine.state.seats[seatIndex];
        if (seat?.isBot || seat?.userId !== userId) continue;
        await this.socket.sendPrivate(userId, {
          kind: "holeCards",
          tableId: engine.state.id,
          handNumber: engine.state.handNumber,
          seatIndex,
          cards
        });
      }
    }
  }

  shutdown() {
    for (const tableId of this.turnTimers.keys()) this.#clearTimer(tableId);
    for (const tableId of this.botTimers.keys()) this.#clearBotTimer(tableId);
    for (const tableId of this.autoNextTimers.keys()) this.#clearAutoNextTimer(tableId);
  }

  registerSession(userId, publicKey) {
    const user = game.users.get(userId);
    if (!user) return null;
    const session = { userId, publicKey, token: randomId("session-"), createdAt: Date.now() };
    this.sessions.set(userId, session);
    return session;
  }

  isBotSeat(tableId, seatIndex) {
    return Boolean(this.tables.get(tableId)?.state?.seats?.[Number(seatIndex)]?.isBot);
  }

  async handle(payload) {
    const session = this.#validateSession(payload);
    const user = game.users.get(session.userId);
    switch (payload.type) {
      case REQUEST.REQUEST_STATE:
        await this.broadcastAll();
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

  async persist() {
    const data = Object.fromEntries([...this.tables.entries()].map(([id, engine]) => [id, engine.storageState()]));
    await this.storage.saveTables(data);
  }

  async broadcastAll() {
    const tables = [...this.tables.values()].map((engine) => engine.publicState());
    this.socket.publishSnapshot(tables);
  }

  async #mutated(engine, { sendHands = false, resetTurn = false, resetAutoNext = false } = {}) {
    this.#scheduleTurn(engine, { reset: resetTurn });
    this.#scheduleAutoNext(engine, { reset: resetAutoNext });
    await this.persist();
    // Deliver private cards first so the following public snapshot produces one complete render.
    // Broadcasting first caused every player client to rebuild the hand twice and replay the deal animation.
    if (sendHands) await this.#sendPrivateHands(engine);
    await this.broadcastAll();
    this.#scheduleBotTurn(engine);
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
      } finally {
        engine.removeSeat(seat.index);
      }
    }

    this.tables.delete(tableId);
    this.#clearTimer(tableId);
    this.#clearBotTimer(tableId);
    this.#clearAutoNextTimer(tableId);
    await this.persist();
    await this.broadcastAll();

    if (failedPayouts.length) {
      const actors = failedPayouts.map(({ seat }) => seat.actorName ?? seat.actorId).join(", ");
      throw new Error(game.i18n.format("FBLPoker.Errors.TableDeletePayoutFailed", { actors }));
    }
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
    const buyIn = Number(data.buyIn);
    if (!Number.isSafeInteger(buyIn) || buyIn < engine.state.minBuyIn || buyIn > engine.state.maxBuyIn) {
      throw new Error("FBLPoker.Errors.BuyInRange");
    }
    const cost = buyIn * engine.state.chipValueCopper;
    if (!Number.isSafeInteger(cost)) throw new Error("FBLPoker.Errors.InvalidCurrencyChange");
    const balance = this.currency.balance(actor);
    const chargedCost = user.isGM ? Math.min(cost, balance.totalCopper) : cost;
    const transaction = await this.currency.change(actor, -chargedCost, {
      reason: chargedCost < cost ? "pokerBuyInGMOverride" : "pokerBuyIn",
      tableId: engine.state.id
    });
    const seatIndex = Number(data.seatIndex);
    let seated = false;
    try {
      engine.addSeat(seatIndex, {
        userId: user.id,
        actorId: actor.id,
        actorName: actor.name,
        actorImg: actor.img,
        stack: buyIn,
        isBot: Boolean(botLevel),
        botLevel,
        botPersonality: botLevel ? (botPersonality ?? "calm") : null
      });
      seated = true;
      await this.#mutated(engine);
    } catch (error) {
      if (seated && engine.state.seats[seatIndex]?.actorId === actor.id) {
        engine.state.seats[seatIndex] = null;
        engine.touch();
        await this.persist().catch(() => undefined);
        await this.broadcastAll().catch(() => undefined);
      }
      if (chargedCost > 0) {
        await this.currency.change(actor, chargedCost, { reason: "pokerBuyInRollback", tableId: engine.state.id });
      }
      throw error;
    }
    await this.#recordTransaction(engine, actor, user, "buyIn", transaction).catch((error) => {
      console.error("FBL Poker | Could not append buy-in ledger entry", error);
    });
  }

  async #moveSeat(user, data) {
    const engine = this.#table(data.tableId);
    if (engine.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");
    const fromIndex = Number(data.fromSeatIndex);
    const toIndex = Number(data.toSeatIndex);
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
    const chips = Number(data.amount);
    if (!Number.isSafeInteger(chips) || chips < 1) throw new Error("FBLPoker.Errors.InvalidTopUp");
    if ((seat.stack + chips) > engine.state.maxBuyIn) throw new Error("FBLPoker.Errors.TopUpLimit");
    const cost = chips * engine.state.chipValueCopper;
    const transaction = await this.currency.change(actor, -cost, { reason: "pokerTopUp", tableId: engine.state.id });
    try {
      engine.addChips(seat.index, chips);
      await this.#mutated(engine);
    } catch (error) {
      await this.currency.change(actor, cost, { reason: "pokerTopUpRollback", tableId: engine.state.id });
      throw error;
    }
    await this.#recordTransaction(engine, actor, user, "topUp", transaction).catch((error) => {
      console.error("FBL Poker | Could not append top-up ledger entry", error);
    });
  }

  async #cashOut(user, data) {
    const engine = this.#table(data.tableId);
    const seat = this.#ownedSeat(engine, user, data.seatIndex);
    if (engine.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");
    await this.#creditSeat(engine, seat, "cashOut");
    engine.removeSeat(seat.index);
    await this.#mutated(engine);
  }

  async #creditSeat(engine, seat, reason) {
    const actor = game.actors.get(seat.actorId);
    if (!actor) throw new Error("FBLPoker.Errors.ActorMissing");
    const amount = seat.stack * engine.state.chipValueCopper;
    const transaction = await this.currency.change(actor, amount, { reason, tableId: engine.state.id });
    await this.#recordTransaction(engine, actor, game.users.get(seat.userId), reason, transaction).catch((error) => {
      console.error("FBL Poker | Could not append cash-out ledger entry", error);
    });
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
    engine.setAutoNext(Boolean(enabled));
    await this.#mutated(engine, { resetAutoNext: true });
  }

  async #setCardsRevealed(user, data) {
    const engine = this.#table(data.tableId);
    const seat = this.#ownedSeat(engine, user, data.seatIndex);
    engine.setCardsRevealed(seat.index, Boolean(data.revealed));
    await this.#mutated(engine);
  }

  async #afterCompletedHand(engine) {
    if (engine.state.status !== TABLE_STATUS.COMPLETE) return;
    let changed = false;
    for (const seat of [...engine.state.seats.filter(Boolean)]) {
      if (seat.leaveAfterHand) {
        try {
          await this.#creditSeat(engine, seat, "leaveAfterHand");
          engine.removeSeat(seat.index);
          changed = true;
        } catch (error) {
          console.error("FBL Poker | Deferred cash-out failed", error);
          seat.leaveAfterHand = false;
          seat.sittingOut = true;
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
    for (const { seatIndex, cards } of engine.privateHands()) {
      const seat = engine.state.seats[seatIndex];
      if (!seat || seat.isBot) continue;
      await this.socket.sendPrivate(seat.userId, {
        kind: "holeCards",
        tableId: engine.state.id,
        handNumber: engine.state.handNumber,
        seatIndex,
        cards
      });
    }
  }

  #scheduleTurn(engine, { reset = false } = {}) {
    this.#clearTimer(engine.state.id);
    this.#clearBotTimer(engine.state.id);
    if (engine.state.paused || !ACTIVE_STREETS.has(engine.state.status) || engine.state.currentSeat === null) {
      engine.state.turnDeadline = null;
      return;
    }

    const revision = engine.state.revision;
    const seatIndex = engine.state.currentSeat;
    let duration = engine.state.actionSeconds * 1000;

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
        if (this.turnTimers.get(engine.state.id) === timer) this.turnTimers.delete(engine.state.id);
        if (!isHostClient() || engine.state.paused || engine.state.revision !== revision || engine.state.currentSeat !== seatIndex) return;
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
    if (engine.state.paused || !ACTIVE_STREETS.has(engine.state.status) || engine.state.currentSeat === null) return;
    const seatIndex = engine.state.currentSeat;
    const seat = engine.state.seats[seatIndex];
    if (!seat?.isBot || !normalizeBotLevel(seat.botLevel)) return;

    const revision = engine.state.revision;
    const handNumber = engine.state.handNumber;
    const delay = botThinkDelay(seat.botLevel, seat.botPersonality);
    const timer = setTimeout(() => {
      const operation = this.queue.then(async () => {
        if (!isHostClient()) return;
        if (engine.state.paused || engine.state.revision !== revision || engine.state.handNumber !== handNumber || engine.state.currentSeat !== seatIndex) return;
        const currentSeat = engine.state.seats[seatIndex];
        if (!currentSeat?.isBot) return;

        let decision;
        try {
          decision = chooseBotAction(engine, seatIndex, currentSeat.botLevel, currentSeat.botPersonality);
        } catch (error) {
          console.error("FBL Poker | Bot decision failed", error);
          const legal = engine.legalActions(seatIndex);
          if (!legal) return;
          decision = { action: legal.canCheck ? ACTIONS.CHECK : ACTIONS.FOLD, amount: null };
        }

        engine.act(seatIndex, decision.action, decision.amount);
        await this.#mutated(engine, { resetTurn: true });
        await this.#afterCompletedHand(engine);
      });
      this.queue = operation.catch((error) => console.error("FBL Poker | Bot turn failed", error));
    }, delay);
    this.botTimers.set(engine.state.id, timer);
  }

  #scheduleAutoNext(engine, { reset = false } = {}) {
    const tableId = engine.state.id;
    const eligibleCount = engine.state.seats.filter((seat) => seat && !seat.sittingOut && !seat.leaveAfterHand && seat.stack > 0).length;
    const shouldRun = engine.state.autoNextHand && engine.state.status === TABLE_STATUS.COMPLETE && eligibleCount >= 2;

    if (!shouldRun) {
      this.#clearAutoNextTimer(tableId);
      engine.state.nextHandDeadline = null;
      return;
    }

    const existing = this.autoNextTimers.get(tableId);
    if (!reset && existing && engine.state.nextHandDeadline && engine.state.nextHandDeadline > Date.now()) return;

    this.#clearAutoNextTimer(tableId);
    let duration = Math.max(1000, Number(engine.state.autoNextHandSeconds || 1) * 1000);
    if (!reset && engine.state.nextHandDeadline && engine.state.nextHandDeadline > Date.now()) {
      duration = engine.state.nextHandDeadline - Date.now();
    }
    engine.state.nextHandDeadline = Date.now() + duration;
    const handNumber = engine.state.handNumber;
    let timer = null;
    timer = setTimeout(() => {
      const operation = this.queue.then(async () => {
        if (this.autoNextTimers.get(tableId) === timer) this.autoNextTimers.delete(tableId);
        if (!isHostClient()) return;
        const current = this.tables.get(tableId);
        if (!current || current.state.status !== TABLE_STATUS.COMPLETE || current.state.handNumber !== handNumber || !current.state.autoNextHand) return;
        const available = current.state.seats.filter((seat) => seat && !seat.sittingOut && !seat.leaveAfterHand && seat.stack > 0).length;
        if (available < 2) {
          current.state.nextHandDeadline = null;
          current.touch();
          await this.persist();
          await this.broadcastAll();
          return;
        }
        current.state.nextHandDeadline = null;
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


  async #recordTransaction(engine, actor, user, reason, transaction) {
    await this.storage.appendLedger({
      id: randomId("tx-"),
      at: Date.now(),
      tableId: engine.state.id,
      tableName: engine.state.name,
      actorId: actor.id,
      actorName: actor.name,
      userId: user?.id ?? null,
      reason,
      beforeCopper: transaction.before.totalCopper,
      deltaCopper: transaction.deltaCopper,
      afterCopper: transaction.after.totalCopper
    });
  }

  #ownedSeat(engine, user, seatIndex) {
    const seat = engine.state.seats[Number(seatIndex)];
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
    return engine;
  }
}

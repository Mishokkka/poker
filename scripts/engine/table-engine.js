import { ACTIONS, ACTIVE_STREETS, BOT_LEVELS, BOT_PERSONALITIES, DEFAULT_TABLE, SCHEMA_VERSION, TABLE_STATUS } from "../constants.js";
import { createDeck, shuffleDeck } from "./cards.js";
import { compareEvaluations, evaluateSeven } from "./evaluator.js";
import { buildSidePots, clockwiseOrder } from "./pots.js";

function occupied(seat) {
  return Boolean(seat?.actorId && seat?.userId);
}

function inHand(seat) {
  return occupied(seat) && seat.inHand;
}

function canAct(seat) {
  return inHand(seat) && !seat.folded && !seat.allIn;
}

function integer(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  if (value === null || value === undefined || value === "") return Boolean(fallback);
  return Boolean(fallback);
}

export function normalizeTableConfiguration(configuration = {}, base = DEFAULT_TABLE) {
  const fallbackName = base.name ?? "Poker Table";
  const name = String(configuration.name ?? fallbackName).trim().slice(0, 80);
  if (!name) throw new Error("FBLPoker.Errors.TableNameRequired");

  const maxSeats = integer(configuration.maxSeats, base.maxSeats ?? DEFAULT_TABLE.maxSeats);
  const smallBlind = integer(configuration.smallBlind, base.smallBlind ?? DEFAULT_TABLE.smallBlind);
  const bigBlind = integer(configuration.bigBlind, base.bigBlind ?? DEFAULT_TABLE.bigBlind);
  const ante = integer(configuration.ante, base.ante ?? DEFAULT_TABLE.ante);
  const minBuyIn = integer(configuration.minBuyIn, base.minBuyIn ?? DEFAULT_TABLE.minBuyIn);
  const maxBuyIn = integer(configuration.maxBuyIn, base.maxBuyIn ?? DEFAULT_TABLE.maxBuyIn);
  const actionSeconds = integer(configuration.actionSeconds, base.actionSeconds ?? DEFAULT_TABLE.actionSeconds);
  const chipValueCopper = integer(configuration.chipValueCopper, base.chipValueCopper ?? DEFAULT_TABLE.chipValueCopper);
  const autoNextHand = boolean(configuration.autoNextHand, base.autoNextHand ?? DEFAULT_TABLE.autoNextHand);
  const autoNextHandSeconds = integer(configuration.autoNextHandSeconds, base.autoNextHandSeconds ?? DEFAULT_TABLE.autoNextHandSeconds);

  if (maxSeats < 2 || maxSeats > 10) throw new Error("FBLPoker.Errors.SeatCountRange");
  if (bigBlind < 1 || smallBlind < 0 || smallBlind > bigBlind) throw new Error("FBLPoker.Errors.BlindOrder");
  if (ante < 0) throw new Error("FBLPoker.Errors.InvalidAnte");
  if (minBuyIn < bigBlind || maxBuyIn < minBuyIn) throw new Error("FBLPoker.Errors.BuyInOrder");
  if (actionSeconds < 10 || actionSeconds > 300) throw new Error("FBLPoker.Errors.ActionTimeRange");
  if (chipValueCopper < 1) throw new Error("FBLPoker.Errors.InvalidChipValue");
  if (autoNextHandSeconds < 1 || autoNextHandSeconds > 120) throw new Error("FBLPoker.Errors.AutoNextTimeRange");

  return {
    name,
    maxSeats,
    smallBlind,
    bigBlind,
    ante,
    minBuyIn,
    maxBuyIn,
    actionSeconds,
    chipValueCopper,
    autoNextHand,
    autoNextHandSeconds
  };
}

function normalizeSeat(seat, index) {
  if (!seat) return null;
  return {
    index,
    userId: seat.userId,
    actorId: seat.actorId,
    actorName: seat.actorName,
    actorImg: seat.actorImg || "icons/svg/mystery-man.svg",
    isBot: Boolean(seat.isBot),
    botLevel: Object.values(BOT_LEVELS).includes(seat.botLevel) ? seat.botLevel : null,
    botPersonality: Object.values(BOT_PERSONALITIES).includes(seat.botPersonality) ? seat.botPersonality : BOT_PERSONALITIES.CALM,
    stack: Math.max(0, Number(seat.stack) || 0),
    sittingOut: Boolean(seat.sittingOut),
    sitOutAfterHand: Boolean(seat.sitOutAfterHand),
    leaveAfterHand: Boolean(seat.leaveAfterHand),
    inHand: Boolean(seat.inHand),
    folded: Boolean(seat.folded),
    allIn: Boolean(seat.allIn),
    streetBet: Math.max(0, Number(seat.streetBet) || 0),
    handCommitted: Math.max(0, Number(seat.handCommitted) || 0),
    lastAction: seat.lastAction ?? null,
    cardsCount: Math.max(0, Number(seat.cardsCount) || 0),
    revealedCards: Array.isArray(seat.revealedCards) ? [...seat.revealedCards] : []
  };
}

export function migrateTableState(source, fallbackSchemaVersion = 0) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("FBLPoker.Errors.InvalidTableState");
  }

  const sourceVersion = integer(source.schemaVersion, integer(fallbackSchemaVersion, 0));
  if (sourceVersion > SCHEMA_VERSION) throw new Error("FBLPoker.Errors.UnsupportedSchema");

  const migrated = structuredClone(source);
  migrated.schemaVersion = SCHEMA_VERSION;
  migrated.status = Object.values(TABLE_STATUS).includes(migrated.status) ? migrated.status : TABLE_STATUS.WAITING;
  migrated.community = Array.isArray(migrated.community) ? migrated.community : [];
  migrated.seats = Array.isArray(migrated.seats) ? migrated.seats : [];
  migrated.acted = Array.isArray(migrated.acted) ? migrated.acted : [];
  migrated.raiseLocked = Array.isArray(migrated.raiseLocked) ? migrated.raiseLocked : [];
  migrated.pots = Array.isArray(migrated.pots) ? migrated.pots : [];
  migrated.log = Array.isArray(migrated.log) ? migrated.log : [];
  migrated.handParticipants = Array.isArray(migrated.handParticipants) ? migrated.handParticipants : [];
  migrated.handActions = Array.isArray(migrated.handActions) ? migrated.handActions : [];
  migrated.handHistory = Array.isArray(migrated.handHistory) ? migrated.handHistory : [];
  migrated.autoNextHand = boolean(migrated.autoNextHand, DEFAULT_TABLE.autoNextHand);
  migrated.autoNextHandSeconds = integer(migrated.autoNextHandSeconds, DEFAULT_TABLE.autoNextHandSeconds);
  migrated.nextHandDeadline = Number.isFinite(Number(migrated.nextHandDeadline)) ? Number(migrated.nextHandDeadline) : null;
  migrated.turnDeadline = Number.isFinite(Number(migrated.turnDeadline)) ? Number(migrated.turnDeadline) : null;
  migrated.turnTimeRemaining = Number.isFinite(Number(migrated.turnTimeRemaining)) ? Math.max(0, Number(migrated.turnTimeRemaining)) : null;

  return migrated;
}

export function createTableState(configuration = {}) {
  const normalized = normalizeTableConfiguration(configuration, { ...DEFAULT_TABLE, name: "Poker Table" });
  return {
    schemaVersion: SCHEMA_VERSION,
    id: configuration.id,
    ...normalized,
    status: TABLE_STATUS.WAITING,
    paused: false,
    revision: 0,
    handNumber: 0,
    dealerIndex: -1,
    smallBlindIndex: null,
    bigBlindIndex: null,
    currentSeat: null,
    currentBet: 0,
    lastFullRaise: normalized.bigBlind,
    community: [],
    seats: Array.from({ length: normalized.maxSeats }, () => null),
    acted: [],
    raiseLocked: [],
    pots: [],
    log: [],
    handStartedAt: null,
    handParticipants: [],
    handActions: [],
    handHistory: [],
    lastResult: null,
    turnDeadline: null,
    turnTimeRemaining: null,
    nextHandDeadline: null,
    updatedAt: Date.now()
  };
}

export class PokerTableEngine {
  #deck = [];
  #holeCards = new Map();

  constructor(source) {
    const initial = source ?? createTableState();
    const state = migrateTableState(initial, initial.schemaVersion ?? SCHEMA_VERSION);
    const configuration = normalizeTableConfiguration(state, { ...DEFAULT_TABLE, name: state.name ?? "Poker Table" });
    const maxSeats = configuration.maxSeats;
    this.state = {
      ...state,
      ...configuration,
      schemaVersion: SCHEMA_VERSION,
      maxSeats,
      paused: Boolean(state.paused),
      autoNextHand: boolean(state.autoNextHand, DEFAULT_TABLE.autoNextHand),
      autoNextHandSeconds: integer(state.autoNextHandSeconds, DEFAULT_TABLE.autoNextHandSeconds),
      seats: Array.from({ length: maxSeats }, (_, index) => normalizeSeat(state.seats?.[index], index)),
      community: [...(state.community ?? [])],
      acted: [...(state.acted ?? [])],
      raiseLocked: [...(state.raiseLocked ?? [])],
      pots: [...(state.pots ?? [])],
      log: [...(state.log ?? [])].slice(0, 100),
      handParticipants: [...(state.handParticipants ?? [])],
      handActions: [...(state.handActions ?? [])],
      handHistory: [...(state.handHistory ?? [])].slice(0, 100),
      turnDeadline: Number.isFinite(Number(state.turnDeadline)) ? Number(state.turnDeadline) : null,
      turnTimeRemaining: Number.isFinite(Number(state.turnTimeRemaining)) ? Math.max(0, Number(state.turnTimeRemaining)) : null,
      nextHandDeadline: Number.isFinite(Number(state.nextHandDeadline)) ? Number(state.nextHandDeadline) : null
    };
  }

  get isActiveHand() {
    return ACTIVE_STREETS.has(this.state.status) || this.state.status === TABLE_STATUS.SHOWDOWN;
  }

  get potTotal() {
    return this.state.seats.reduce((total, seat) => total + (seat?.handCommitted ?? 0), 0);
  }

  privateCards(seatIndex) {
    return [...(this.#holeCards.get(seatIndex) ?? [])];
  }

  storageState() {
    this.state.pots = buildSidePots(this.state.seats.filter(Boolean));
    return structuredClone({ ...this.state, potTotal: this.potTotal });
  }

  publicState() {
    const state = this.storageState();
    state.seats = state.seats.map((seat) => {
      if (!seat) return null;
      const { isBot: _isBot, botLevel: _botLevel, botPersonality: _botPersonality, ...publicSeat } = seat;
      return publicSeat;
    });
    return state;
  }

  touch() {
    this.state.revision += 1;
    this.state.updatedAt = Date.now();
  }

  updateConfiguration(configuration) {
    if (this.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");
    const normalized = normalizeTableConfiguration(configuration, this.state);
    const hasSeats = this.state.seats.some(Boolean);

    if (normalized.maxSeats !== this.state.maxSeats && hasSeats) {
      throw new Error("FBLPoker.Errors.SeatCountLocked");
    }
    if (normalized.chipValueCopper !== this.state.chipValueCopper && hasSeats) {
      throw new Error("FBLPoker.Errors.ChipValueLocked");
    }

    if (normalized.maxSeats !== this.state.maxSeats) {
      this.state.maxSeats = normalized.maxSeats;
      this.state.seats = Array.from({ length: normalized.maxSeats }, (_, index) => normalizeSeat(this.state.seats[index], index));
      this.state.dealerIndex = -1;
      this.state.smallBlindIndex = null;
      this.state.bigBlindIndex = null;
    }

    Object.assign(this.state, normalized);
    this.state.lastFullRaise = normalized.bigBlind;
    this.#log("settings", null);
    this.touch();
  }

  addSeat(index, data) {
    this.#assertSeatIndex(index);
    if (this.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");
    if (this.state.seats[index]) throw new Error("FBLPoker.Errors.SeatOccupied");
    if (this.state.seats.some((seat) => seat?.actorId === data.actorId)) throw new Error("FBLPoker.Errors.ActorAlreadySeated");
    this.state.seats[index] = normalizeSeat({ ...data, index, sittingOut: false }, index);
    this.#log("join", index, data.stack);
    this.touch();
  }

  moveSeat(fromIndex, toIndex) {
    if (this.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");
    this.#assertSeatIndex(fromIndex);
    this.#assertSeatIndex(toIndex);
    if (fromIndex === toIndex) return;
    const seat = this.state.seats[fromIndex];
    if (!seat) throw new Error("FBLPoker.Errors.EmptySeat");
    if (this.state.seats[toIndex]) throw new Error("FBLPoker.Errors.SeatOccupied");
    this.state.seats[fromIndex] = null;
    seat.index = toIndex;
    this.state.seats[toIndex] = seat;
    if (this.state.dealerIndex === fromIndex) this.state.dealerIndex = toIndex;
    if (this.state.smallBlindIndex === fromIndex) this.state.smallBlindIndex = toIndex;
    if (this.state.bigBlindIndex === fromIndex) this.state.bigBlindIndex = toIndex;
    this.#log("moveSeat", toIndex);
    this.touch();
  }

  addChips(index, amount) {
    if (this.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");
    const seat = this.#seat(index);
    const chips = Number.parseInt(amount, 10);
    if (!Number.isFinite(chips) || chips < 1) throw new Error("FBLPoker.Errors.InvalidTopUp");
    if ((seat.stack + chips) > this.state.maxBuyIn) throw new Error("FBLPoker.Errors.TopUpLimit");
    seat.stack += chips;
    this.#log("topUp", index, chips);
    this.touch();
  }

  removeSeat(index) {
    this.#assertSeatIndex(index);
    if (this.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");
    const seat = this.state.seats[index];
    if (!seat) throw new Error("FBLPoker.Errors.EmptySeat");
    this.#log("leave", index, seat.stack);
    this.state.seats[index] = null;
    this.touch();
    return seat;
  }

  setSittingOut(index, value) {
    const seat = this.#seat(index);
    if (this.isActiveHand && seat.inHand) throw new Error("FBLPoker.Errors.HandInProgress");
    seat.sittingOut = Boolean(value);
    seat.sitOutAfterHand = false;
    if (!value) seat.leaveAfterHand = false;
    this.#log(value ? "sitOut" : "sitIn", index);
    this.touch();
  }

  toggleSitOutAfterHand(index) {
    const seat = this.#seat(index);
    if (!this.isActiveHand || !seat.inHand) throw new Error("FBLPoker.Errors.NoActiveHandForQueue");
    seat.sitOutAfterHand = !seat.sitOutAfterHand;
    if (seat.sitOutAfterHand) seat.leaveAfterHand = false;
    this.#log(seat.sitOutAfterHand ? "sitOutQueued" : "sitOutQueueCanceled", index);
    this.touch();
  }

  toggleLeaveAfterHand(index) {
    const seat = this.#seat(index);
    if (!this.isActiveHand || !seat.inHand) throw new Error("FBLPoker.Errors.NoActiveHandForQueue");
    seat.leaveAfterHand = !seat.leaveAfterHand;
    if (seat.leaveAfterHand) seat.sitOutAfterHand = false;
    this.#log(seat.leaveAfterHand ? "leaveQueued" : "leaveQueueCanceled", index);
    this.touch();
  }

  setPaused(value) {
    if (!this.isActiveHand) throw new Error("FBLPoker.Errors.NoActiveHand");
    const paused = Boolean(value);
    if (this.state.paused === paused) return;
    if (paused) {
      this.state.turnTimeRemaining = this.state.turnDeadline
        ? Math.max(0, this.state.turnDeadline - Date.now())
        : (this.state.actionSeconds * 1000);
      this.state.turnDeadline = null;
    }
    this.state.paused = paused;
    this.#log(paused ? "pause" : "resume", null);
    this.touch();
  }

  setAutoNext(enabled) {
    this.state.autoNextHand = Boolean(enabled);
    if (!this.state.autoNextHand) this.state.nextHandDeadline = null;
    this.touch();
  }

  setCardsRevealed(index, revealed) {
    const seat = this.#seat(index);
    const optionalRevealWinner = this.state.status === TABLE_STATUS.COMPLETE
      && this.state.lastResult?.type === "uncontested"
      && this.state.lastResult.awards?.some((award) => award.seatIndex === index);
    if (!optionalRevealWinner || seat.cardsCount < 1) {
      throw new Error("FBLPoker.Errors.CardsVisibilityUnavailable");
    }

    const shouldReveal = Boolean(revealed);
    const cards = this.#holeCards.get(index) ?? [];
    if (shouldReveal && cards.length !== seat.cardsCount) {
      throw new Error("FBLPoker.Errors.CardsUnavailable");
    }

    seat.revealedCards = shouldReveal ? [...cards] : [];
    const history = this.state.handHistory.find((hand) => hand.handNumber === this.state.handNumber);
    const participant = history?.participants?.find((candidate) => candidate.seatIndex === index);
    if (participant) participant.cards = [...seat.revealedCards];
    this.#log(shouldReveal ? "showCards" : "hideCards", index);
    this.touch();
  }

  rollbackActiveHand() {
    if (!this.isActiveHand) return false;
    const refunded = this.potTotal;
    for (const seat of this.state.seats.filter(Boolean)) {
      seat.stack += seat.handCommitted;
      this.#resetSeatForHand(seat);
      seat.sitOutAfterHand = false;
      seat.leaveAfterHand = false;
    }
    this.#deck = [];
    this.#holeCards.clear();
    this.state.status = TABLE_STATUS.WAITING;
    this.state.paused = false;
    this.state.currentSeat = null;
    this.state.turnDeadline = null;
    this.state.turnTimeRemaining = null;
    this.state.currentBet = 0;
    this.state.lastFullRaise = this.state.bigBlind;
    this.state.community = [];
    this.state.acted = [];
    this.state.raiseLocked = [];
    this.state.pots = [];
    this.state.handStartedAt = null;
    this.state.handParticipants = [];
    this.state.handActions = [];
    this.state.nextHandDeadline = null;
    this.state.lastResult = { type: "rollback", refunded };
    this.#log("rollback", null, refunded);
    this.touch();
    return true;
  }

  startHand() {
    if (this.isActiveHand) throw new Error("FBLPoker.Errors.HandInProgress");
    const eligible = this.#eligibleSeatIndices();
    if (eligible.length < 2) throw new Error("FBLPoker.Errors.NotEnoughPlayers");

    for (const seat of this.state.seats.filter(Boolean)) this.#resetSeatForHand(seat);
    for (const index of eligible) this.state.seats[index].inHand = true;

    this.state.handNumber += 1;
    this.state.status = TABLE_STATUS.PREFLOP;
    this.state.nextHandDeadline = null;
    this.state.paused = false;
    this.state.community = [];
    this.state.lastResult = null;
    this.state.acted = [];
    this.state.raiseLocked = [];
    this.state.currentBet = 0;
    this.state.lastFullRaise = this.state.bigBlind;
    this.state.turnDeadline = null;
    this.state.turnTimeRemaining = null;
    this.state.handStartedAt = Date.now();
    this.state.handActions = [];
    this.state.handParticipants = eligible.map((index) => {
      const seat = this.state.seats[index];
      return {
        seatIndex: index,
        userId: seat.userId,
        actorId: seat.actorId,
        actorName: seat.actorName,
        startingStack: seat.stack
      };
    });
    this.state.dealerIndex = this.#nextIndex(this.state.dealerIndex, eligible);
    this.state.smallBlindIndex = eligible.length === 2
      ? this.state.dealerIndex
      : this.#nextIndex(this.state.dealerIndex, eligible);
    this.state.bigBlindIndex = this.#nextIndex(this.state.smallBlindIndex, eligible);

    this.#deck = shuffleDeck(createDeck());
    this.#holeCards.clear();

    if (this.state.ante > 0) {
      for (const index of eligible) this.#commitAnte(index, Math.min(this.state.ante, this.state.seats[index].stack));
    }
    this.#postBlind(this.state.smallBlindIndex, this.state.smallBlind, "smallBlind");
    this.#postBlind(this.state.bigBlindIndex, this.state.bigBlind, "bigBlind");
    this.state.currentBet = Math.max(...eligible.map((index) => this.state.seats[index].streetBet));

    const dealOrder = this.#orderedAfter(this.state.dealerIndex, eligible);
    for (let round = 0; round < 2; round += 1) {
      for (const index of dealOrder) {
        const cards = this.#holeCards.get(index) ?? [];
        cards.push(this.#deck.pop());
        this.#holeCards.set(index, cards);
        this.state.seats[index].cardsCount = cards.length;
      }
    }

    this.state.currentSeat = this.#nextActionable(this.state.bigBlindIndex);
    this.#log("handStart", null, this.state.handNumber);
    this.touch();

    if (this.state.currentSeat === null) this.#runoutAndShowdown();
    return this.privateHands();
  }

  privateHands() {
    return [...this.#holeCards.entries()].map(([seatIndex, cards]) => ({ seatIndex, cards: [...cards] }));
  }

  legalActions(index) {
    const seat = this.#seat(index);
    if (this.state.paused || !ACTIVE_STREETS.has(this.state.status) || this.state.currentSeat !== index || !canAct(seat)) return null;
    const callAmount = Math.max(0, this.state.currentBet - seat.streetBet);
    const maxTarget = seat.streetBet + seat.stack;
    const minTarget = this.state.currentBet === 0
      ? this.state.bigBlind
      : (this.state.currentBet < this.state.bigBlind ? this.state.bigBlind : this.state.currentBet + this.state.lastFullRaise);
    const raiseAllowed = !this.state.raiseLocked.includes(index) && maxTarget > this.state.currentBet;
    return {
      callAmount: Math.min(callAmount, seat.stack),
      canFold: true,
      canCheck: callAmount === 0,
      canCall: callAmount > 0 && seat.stack > 0,
      canBet: this.state.currentBet === 0 && raiseAllowed,
      canRaise: this.state.currentBet > 0 && raiseAllowed,
      canAllIn: seat.stack > 0,
      minTarget: Math.min(maxTarget, minTarget),
      fullRaiseTarget: minTarget,
      maxTarget,
      potTotal: this.potTotal
    };
  }

  act(index, action, amount = null) {
    if (this.state.paused) throw new Error("FBLPoker.Errors.TablePaused");
    const legal = this.legalActions(index);
    if (!legal) throw new Error("FBLPoker.Errors.NotYourTurn");
    const seat = this.#seat(index);
    const previousActed = [...this.state.acted];

    switch (action) {
      case ACTIONS.FOLD:
        seat.folded = true;
        seat.lastAction = { type: ACTIONS.FOLD, amount: 0 };
        this.#markActed(index);
        break;
      case ACTIONS.CHECK:
        if (!legal.canCheck) throw new Error("FBLPoker.Errors.CannotCheck");
        seat.lastAction = { type: ACTIONS.CHECK, amount: 0 };
        this.#markActed(index);
        break;
      case ACTIONS.CALL: {
        if (!legal.canCall) throw new Error("FBLPoker.Errors.CannotCall");
        const paid = this.#commit(index, legal.callAmount, ACTIONS.CALL);
        seat.lastAction = { type: ACTIONS.CALL, amount: paid };
        this.#markActed(index);
        break;
      }
      case ACTIONS.ALL_IN: {
        if (!legal.canAllIn) throw new Error("FBLPoker.Errors.CannotAllIn");
        const target = seat.streetBet + seat.stack;
        if (target <= this.state.currentBet) {
          const paid = this.#commit(index, seat.stack, ACTIONS.ALL_IN);
          seat.lastAction = { type: ACTIONS.ALL_IN, amount: paid, target };
          this.#markActed(index);
        } else {
          this.#raiseTo(index, target, previousActed, true);
        }
        break;
      }
      case ACTIONS.BET:
      case ACTIONS.RAISE: {
        const target = Number.parseInt(amount, 10);
        if (!Number.isFinite(target)) throw new Error("FBLPoker.Errors.InvalidBet");
        this.#raiseTo(index, target, previousActed, false);
        break;
      }
      default:
        throw new Error("FBLPoker.Errors.InvalidAction");
    }

    this.#log(seat.lastAction?.type ?? action, index, seat.lastAction?.amount ?? amount ?? 0);
    this.touch();
    this.#afterAction(index);
  }

  forceReset() {
    const refunded = this.potTotal;
    for (const seat of this.state.seats.filter(Boolean)) {
      seat.stack += seat.handCommitted;
      this.#resetSeatForHand(seat);
      seat.sitOutAfterHand = false;
      seat.leaveAfterHand = false;
    }
    this.#deck = [];
    this.#holeCards.clear();
    this.state.status = TABLE_STATUS.WAITING;
    this.state.paused = false;
    this.state.currentSeat = null;
    this.state.turnDeadline = null;
    this.state.turnTimeRemaining = null;
    this.state.currentBet = 0;
    this.state.community = [];
    this.state.acted = [];
    this.state.raiseLocked = [];
    this.state.pots = [];
    this.state.handStartedAt = null;
    this.state.handParticipants = [];
    this.state.handActions = [];
    this.state.nextHandDeadline = null;
    this.state.lastResult = { type: "reset", refunded };
    this.#log("reset", null, refunded);
    this.touch();
  }

  #raiseTo(index, target, previousActed, allInRequested) {
    const seat = this.#seat(index);
    const maxTarget = seat.streetBet + seat.stack;
    if (target <= this.state.currentBet || target > maxTarget) throw new Error("FBLPoker.Errors.InvalidBet");
    if (this.state.raiseLocked.includes(index)) throw new Error("FBLPoker.Errors.RaiseNotReopened");

    const fullRaiseTarget = this.state.currentBet === 0
      ? this.state.bigBlind
      : (this.state.currentBet < this.state.bigBlind ? this.state.bigBlind : this.state.currentBet + this.state.lastFullRaise);
    const isAllIn = target === maxTarget;
    const fullRaise = target >= fullRaiseTarget;
    if (!fullRaise && !isAllIn) throw new Error("FBLPoker.Errors.BelowMinimumRaise");
    if (allInRequested && !isAllIn) throw new Error("FBLPoker.Errors.InvalidBet");

    const priorBet = this.state.currentBet;
    const paid = this.#commit(index, target - seat.streetBet, allInRequested ? ACTIONS.ALL_IN : (priorBet === 0 ? ACTIONS.BET : ACTIONS.RAISE));
    this.state.currentBet = target;
    seat.lastAction = {
      type: allInRequested ? ACTIONS.ALL_IN : (priorBet === 0 ? ACTIONS.BET : ACTIONS.RAISE),
      amount: paid,
      target
    };

    if (fullRaise) {
      this.state.lastFullRaise = target - priorBet;
      this.state.acted = [index];
      this.state.raiseLocked = [];
    } else {
      this.#markActed(index);
      this.state.raiseLocked = [...new Set([...this.state.raiseLocked, ...previousActed.filter((seatIndex) => seatIndex !== index)])];
    }
  }

  #afterAction(index) {
    const remaining = this.state.seats.filter((seat) => inHand(seat) && !seat.folded);
    if (remaining.length === 1) {
      this.#awardUncontested(remaining[0]);
      return;
    }

    if (this.#bettingRoundComplete()) {
      this.#advanceStreet();
      return;
    }

    this.state.currentSeat = this.#nextActionable(index);
    if (this.state.currentSeat === null) this.#runoutAndShowdown();
  }

  #bettingRoundComplete() {
    const actionable = this.state.seats.filter((seat) => canAct(seat));
    if (actionable.length === 0) return true;
    return actionable.every((seat) => this.state.acted.includes(seat.index) && seat.streetBet === this.state.currentBet);
  }

  #advanceStreet() {
    if (this.state.status === TABLE_STATUS.RIVER) {
      this.#showdown();
      return;
    }

    for (const seat of this.state.seats.filter(Boolean)) seat.streetBet = 0;
    this.state.currentBet = 0;
    this.state.lastFullRaise = this.state.bigBlind;
    this.state.acted = [];
    this.state.raiseLocked = [];
    this.#deck.pop();

    if (this.state.status === TABLE_STATUS.PREFLOP) {
      this.state.community.push(this.#deck.pop(), this.#deck.pop(), this.#deck.pop());
      this.state.status = TABLE_STATUS.FLOP;
    } else if (this.state.status === TABLE_STATUS.FLOP) {
      this.state.community.push(this.#deck.pop());
      this.state.status = TABLE_STATUS.TURN;
    } else if (this.state.status === TABLE_STATUS.TURN) {
      this.state.community.push(this.#deck.pop());
      this.state.status = TABLE_STATUS.RIVER;
    }

    const actionable = this.state.seats.filter((seat) => canAct(seat));
    if (actionable.length <= 1) {
      this.#runoutAndShowdown();
      return;
    }
    this.state.currentSeat = this.#nextActionable(this.state.dealerIndex);
    this.#log("street", null, this.state.status);
    this.touch();
  }

  #runoutAndShowdown() {
    while (this.state.community.length < 5) {
      this.#deck.pop();
      const count = this.state.community.length === 0 ? 3 : 1;
      for (let index = 0; index < count; index += 1) this.state.community.push(this.#deck.pop());
    }
    this.#showdown();
  }

  #showdown() {
    this.state.status = TABLE_STATUS.SHOWDOWN;
    this.state.paused = false;
    this.state.currentSeat = null;
    const evaluations = new Map();
    for (const seat of this.state.seats.filter((candidate) => inHand(candidate) && !candidate.folded)) {
      const cards = this.#holeCards.get(seat.index) ?? [];
      seat.revealedCards = [...cards];
      evaluations.set(seat.index, evaluateSeven([...cards, ...this.state.community]));
    }

    const pots = buildSidePots(this.state.seats.filter(Boolean));
    const awards = [];
    for (const pot of pots) {
      const contenders = pot.eligible.filter((index) => evaluations.has(index));
      if (!contenders.length) continue;
      let winners = [contenders[0]];
      for (const contender of contenders.slice(1)) {
        const comparison = compareEvaluations(evaluations.get(contender), evaluations.get(winners[0]));
        if (comparison > 0) winners = [contender];
        else if (comparison === 0) winners.push(contender);
      }
      const ordered = clockwiseOrder(winners, (this.state.dealerIndex + 1) % this.state.maxSeats, this.state.maxSeats);
      const share = Math.floor(pot.amount / ordered.length);
      let remainder = pot.amount % ordered.length;
      for (const index of ordered) {
        const award = share + (remainder > 0 ? 1 : 0);
        remainder -= remainder > 0 ? 1 : 0;
        this.state.seats[index].stack += award;
        awards.push({ seatIndex: index, amount: award, categoryName: evaluations.get(index).categoryName });
      }
    }

    this.state.pots = pots;
    this.state.lastResult = { type: "showdown", awards };
    this.state.status = TABLE_STATUS.COMPLETE;
    this.#log("showdown", null, awards.reduce((sum, award) => sum + award.amount, 0));
    this.#finalizeHandHistory("showdown", awards);
    this.touch();
  }

  #awardUncontested(winner) {
    const amount = this.potTotal;
    winner.stack += amount;
    this.state.paused = false;
    this.state.currentSeat = null;
    const awards = [{ seatIndex: winner.index, amount }];
    this.state.lastResult = { type: "uncontested", awards };
    this.state.status = TABLE_STATUS.COMPLETE;
    this.state.pots = buildSidePots(this.state.seats.filter(Boolean));
    this.#log("uncontested", winner.index, amount);
    this.#finalizeHandHistory("uncontested", awards);
    this.touch();
  }

  #finalizeHandHistory(type, awards) {
    if (!this.state.handStartedAt) return;
    const participants = this.state.handParticipants.map((participant) => {
      const seat = this.state.seats[participant.seatIndex];
      return {
        ...participant,
        endingStack: seat?.stack ?? 0,
        committed: seat?.handCommitted ?? 0,
        folded: Boolean(seat?.folded),
        allIn: Boolean(seat?.allIn),
        cards: type === "showdown" ? [...(seat?.revealedCards ?? [])] : []
      };
    });
    const enrichedAwards = awards.map((award) => ({
      ...award,
      actorName: this.state.seats[award.seatIndex]?.actorName ?? "?"
    }));
    this.state.handHistory.unshift({
      handNumber: this.state.handNumber,
      type,
      startedAt: this.state.handStartedAt,
      completedAt: Date.now(),
      dealerIndex: this.state.dealerIndex,
      smallBlind: this.state.smallBlind,
      bigBlind: this.state.bigBlind,
      ante: this.state.ante,
      potTotal: this.potTotal,
      community: [...this.state.community],
      participants,
      awards: enrichedAwards,
      actions: [...this.state.handActions]
    });
    this.state.handHistory = this.state.handHistory.slice(0, 100);
    this.state.handStartedAt = null;
    this.state.handParticipants = [];
    this.state.handActions = [];
  }

  #resetSeatForHand(seat) {
    seat.inHand = false;
    seat.folded = false;
    seat.allIn = false;
    seat.streetBet = 0;
    seat.handCommitted = 0;
    seat.lastAction = null;
    seat.cardsCount = 0;
    seat.revealedCards = [];
  }

  #commitAnte(index, amount) {
    const seat = this.#seat(index);
    const paid = Math.max(0, Math.min(Number(amount) || 0, seat.stack));
    seat.stack -= paid;
    seat.handCommitted += paid;
    if (seat.stack === 0) seat.allIn = true;
    seat.lastAction = { type: "ante", amount: paid };
    return paid;
  }

  #postBlind(index, amount, type) {
    const seat = this.#seat(index);
    const paid = this.#commit(index, Math.min(amount, seat.stack), type);
    seat.lastAction = { type, amount: paid };
  }

  #commit(index, amount, type) {
    const seat = this.#seat(index);
    const paid = Math.max(0, Math.min(Number(amount) || 0, seat.stack));
    seat.stack -= paid;
    seat.streetBet += paid;
    seat.handCommitted += paid;
    if (seat.stack === 0) seat.allIn = true;
    if (type) seat.lastAction = { type, amount: paid };
    return paid;
  }

  #markActed(index) {
    if (!this.state.acted.includes(index)) this.state.acted.push(index);
  }

  #eligibleSeatIndices() {
    return this.state.seats
      .filter((seat) => occupied(seat) && !seat.sittingOut && !seat.sitOutAfterHand && !seat.leaveAfterHand && seat.stack > 0)
      .map((seat) => seat.index);
  }

  #orderedAfter(startIndex, indices) {
    const allowed = new Set(indices);
    const result = [];
    for (let step = 1; step <= this.state.maxSeats; step += 1) {
      const index = (startIndex + step + this.state.maxSeats) % this.state.maxSeats;
      if (allowed.has(index)) result.push(index);
    }
    return result;
  }

  #nextIndex(startIndex, indices) {
    return this.#orderedAfter(startIndex, indices)[0] ?? null;
  }

  #nextActionable(startIndex) {
    const indices = this.state.seats.filter((seat) => canAct(seat)).map((seat) => seat.index);
    return this.#nextIndex(startIndex, indices);
  }

  #seat(index) {
    this.#assertSeatIndex(index);
    const seat = this.state.seats[index];
    if (!seat) throw new Error("FBLPoker.Errors.EmptySeat");
    return seat;
  }

  #assertSeatIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.state.maxSeats) {
      throw new Error("FBLPoker.Errors.InvalidSeat");
    }
  }

  #log(type, seatIndex = null, amount = null) {
    const entry = { id: `${Date.now()}-${Math.random()}`, type, seatIndex, amount, at: Date.now() };
    this.state.log.unshift(entry);
    this.state.log = this.state.log.slice(0, 100);
    if (this.state.handStartedAt) this.state.handActions.push(structuredClone(entry));
  }
}

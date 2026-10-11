export const MODULE_ID = "fbl-poker-table";
export const SOCKET_NAME = `module.${MODULE_ID}`;
export const QUERY_NAME = `${MODULE_ID}.rpc`;
export const SCHEMA_VERSION = 5;

export const TABLE_STATUS = Object.freeze({
  WAITING: "waiting",
  PREFLOP: "preflop",
  FLOP: "flop",
  TURN: "turn",
  RIVER: "river",
  SHOWDOWN: "showdown",
  COMPLETE: "complete"
});

export const ACTIVE_STREETS = new Set([
  TABLE_STATUS.PREFLOP,
  TABLE_STATUS.FLOP,
  TABLE_STATUS.TURN,
  TABLE_STATUS.RIVER
]);


export const BOT_LEVELS = Object.freeze({
  NOVICE: "novice",
  EXPERIENCED: "experienced",
  EXPERT: "expert"
});

export const BOT_PERSONALITIES = Object.freeze({
  CALM: "calm",
  RISKY: "risky",
  RECKLESS: "reckless"
});

export const ACTIONS = Object.freeze({
  FOLD: "fold",
  CHECK: "check",
  CALL: "call",
  BET: "bet",
  RAISE: "raise",
  ALL_IN: "allIn"
});

export const REQUEST = Object.freeze({
  HELLO: "hello",
  SESSION: "session",
  SNAPSHOT: "snapshot",
  PRIVATE: "private",
  CREATE_TABLE: "createTable",
  UPDATE_TABLE: "updateTable",
  DELETE_TABLE: "deleteTable",
  JOIN: "join",
  MOVE_SEAT: "moveSeat",
  LEAVE: "leave",
  CASH_OUT: "cashOut",
  TOP_UP: "topUp",
  SIT_OUT: "sitOut",
  SIT_IN: "sitIn",
  TOGGLE_SIT_OUT_AFTER_HAND: "toggleSitOutAfterHand",
  TOGGLE_LEAVE_AFTER_HAND: "toggleLeaveAfterHand",
  START_HAND: "startHand",
  NEXT_HAND: "nextHand",
  ACTION: "action",
  PAUSE_TABLE: "pauseTable",
  RESUME_TABLE: "resumeTable",
  FORCE_RESET: "forceReset",
  SET_AUTO_NEXT: "setAutoNext",
  SET_CARDS_REVEALED: "setCardsRevealed",
  RESOLVE_MONEY: "resolveMoney",
  REQUEST_STATE: "requestState"
});

export const DEFAULT_TABLE = Object.freeze({
  maxSeats: 9,
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  minBuyIn: 40,
  maxBuyIn: 200,
  actionSeconds: 45,
  chipValueCopper: 1,
  autoNextHand: false,
  autoNextHandSeconds: 6
});

export const CARD_SUITS = Object.freeze(["s", "h", "d", "c"]);
export const CARD_RANKS = Object.freeze(["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"]);

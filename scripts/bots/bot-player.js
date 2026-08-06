import { ACTIONS, BOT_LEVELS, BOT_PERSONALITIES, CARD_RANKS, CARD_SUITS } from "../constants.js";
import { compareEvaluations, evaluateSeven } from "../engine/evaluator.js";

const RANK_VALUE = Object.freeze({
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7,
  "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14
});

const LEVEL_SET = new Set(Object.values(BOT_LEVELS));
const PERSONALITY_SET = new Set(Object.values(BOT_PERSONALITIES));
const FULL_DECK = Object.freeze(CARD_SUITS.flatMap((suit) => CARD_RANKS.map((rank) => `${rank}${suit}`)));

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function randomBetween(rng, min, max) {
  return min + ((max - min) * clamp(Number(rng()) || 0));
}

function integerBetween(rng, min, max) {
  return Math.min(max, Math.floor(randomBetween(rng, min, max + 1)));
}

function resolvePersonalityAndRng(personalityOrRng, maybeRng) {
  if (typeof personalityOrRng === "function") {
    return { personality: BOT_PERSONALITIES.CALM, rng: personalityOrRng };
  }
  return {
    personality: normalizeBotPersonality(personalityOrRng) ?? BOT_PERSONALITIES.CALM,
    rng: typeof maybeRng === "function" ? maybeRng : Math.random
  };
}

function shuffledSample(values, count, rng) {
  const copy = [...values];
  const take = Math.min(count, copy.length);
  for (let index = 0; index < take; index += 1) {
    const swapIndex = integerBetween(rng, index, copy.length - 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy.slice(0, take);
}

function preflopStrength(cards) {
  if (!Array.isArray(cards) || cards.length !== 2) return 0.35;
  const first = { rank: RANK_VALUE[cards[0][0]] ?? 2, suit: cards[0][1] };
  const second = { rank: RANK_VALUE[cards[1][0]] ?? 2, suit: cards[1][1] };
  const high = Math.max(first.rank, second.rank);
  const low = Math.min(first.rank, second.rank);
  const pair = high === low;
  const suited = first.suit === second.suit;
  const gap = Math.abs(first.rank - second.rank);

  if (pair) return clamp(0.45 + ((high - 2) / 20), 0.48, 0.96);

  let value = 0.18 + ((high - 2) / 25) + ((low - 2) / 55);
  if (suited) value += 0.055;
  if (gap === 1) value += 0.055;
  else if (gap === 2) value += 0.028;
  else if (gap >= 5) value -= 0.045;
  if (high >= 11 && low >= 10) value += 0.065;
  if (high === 14) value += 0.035;
  if (low <= 5 && high <= 9 && gap <= 2) value += 0.018;
  return clamp(value, 0.12, 0.82);
}

function madeHandStrength(cards) {
  if (!Array.isArray(cards) || cards.length < 5) return preflopStrength(cards?.slice?.(0, 2) ?? []);
  const evaluation = evaluateSeven(cards.slice(0, 7));
  const categoryBase = [0.22, 0.42, 0.57, 0.67, 0.72, 0.78, 0.86, 0.94, 0.99][evaluation.category] ?? 0.25;
  const topKicker = (evaluation.kickers?.[0] ?? 2) / 14;
  return clamp(categoryBase + ((topKicker - 0.5) * 0.08));
}

function estimateEquity({ holeCards, community, opponentCount, iterations, rng }) {
  const known = new Set([...(holeCards ?? []), ...(community ?? [])]);
  const deck = FULL_DECK.filter((card) => !known.has(card));
  const boardNeeded = Math.max(0, 5 - (community?.length ?? 0));
  const opponents = Math.max(1, Number(opponentCount) || 1);
  const cardsNeeded = boardNeeded + (opponents * 2);
  if (deck.length < cardsNeeded) return madeHandStrength([...(holeCards ?? []), ...(community ?? [])]);

  let equity = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = shuffledSample(deck, cardsNeeded, rng);
    const board = [...(community ?? []), ...sample.slice(0, boardNeeded)];
    let cursor = boardNeeded;
    const hero = evaluateSeven([...(holeCards ?? []), ...board]);
    const evaluations = [hero];
    for (let opponent = 0; opponent < opponents; opponent += 1) {
      const hand = sample.slice(cursor, cursor + 2);
      cursor += 2;
      evaluations.push(evaluateSeven([...hand, ...board]));
    }

    let best = evaluations[0];
    for (const evaluation of evaluations.slice(1)) {
      if (compareEvaluations(evaluation, best) > 0) best = evaluation;
    }
    const winners = evaluations.filter((evaluation) => compareEvaluations(evaluation, best) === 0);
    if (compareEvaluations(hero, best) === 0) equity += 1 / winners.length;
  }
  return clamp(equity / Math.max(1, iterations));
}

function positionScore(state, seatIndex) {
  const active = (state.seats ?? []).filter((seat) => seat?.inHand && !seat.folded).map((seat) => seat.index);
  if (active.length <= 1) return 0.5;
  const ordered = [];
  for (let step = 1; step <= state.maxSeats; step += 1) {
    const index = (state.dealerIndex + step + state.maxSeats) % state.maxSeats;
    if (active.includes(index)) ordered.push(index);
  }
  const position = ordered.indexOf(seatIndex);
  return position < 0 ? 0.5 : position / Math.max(1, ordered.length - 1);
}

function raiseTarget(state, legal, fraction) {
  const pot = Math.max(state.bigBlind * 2, state.potTotal ?? 0);
  const target = state.currentBet === 0
    ? Math.round(pot * fraction)
    : state.currentBet + Math.round((pot + legal.callAmount) * fraction);
  return Math.max(legal.minTarget, Math.min(legal.maxTarget, target));
}

function fallbackAction(legal) {
  if (legal.canCheck) return { action: ACTIONS.CHECK, amount: null };
  if (legal.canCall) return { action: ACTIONS.CALL, amount: null };
  return { action: ACTIONS.FOLD, amount: null };
}

function chooseNovice({ state, seat, legal, strength, rng }) {
  const pressure = legal.callAmount / Math.max(1, seat.stack + legal.callAmount);
  const noisy = clamp(strength + randomBetween(rng, -0.16, 0.16));

  if (legal.canCheck) {
    if ((legal.canBet || legal.canRaise) && noisy > 0.72 && rng() < 0.68) {
      return { action: state.currentBet === 0 ? ACTIONS.BET : ACTIONS.RAISE, amount: raiseTarget(state, legal, rng() < 0.55 ? 0.5 : 0.75) };
    }
    if (legal.canBet && rng() < 0.10) return { action: ACTIONS.BET, amount: raiseTarget(state, legal, 0.4) };
    return { action: ACTIONS.CHECK, amount: null };
  }

  if ((legal.canRaise || legal.canBet) && noisy > 0.84 && rng() < 0.42) {
    if (legal.maxTarget <= legal.minTarget * 1.2 && legal.canAllIn) return { action: ACTIONS.ALL_IN, amount: null };
    return { action: ACTIONS.RAISE, amount: raiseTarget(state, legal, 0.6) };
  }
  if (noisy > (0.36 + (pressure * 0.45)) || rng() < 0.12) return { action: ACTIONS.CALL, amount: null };
  return { action: ACTIONS.FOLD, amount: null };
}

function chooseExperienced({ state, seat, legal, equity, position, rng }) {
  const pot = Math.max(1, state.potTotal ?? 0);
  const potOdds = legal.callAmount / Math.max(1, pot + legal.callAmount);
  const adjusted = clamp(equity + ((position - 0.5) * 0.06) + randomBetween(rng, -0.035, 0.035));
  const stackToPot = seat.stack / pot;

  if (legal.canCheck) {
    const bluff = position > 0.58 && rng() < 0.07;
    if ((legal.canBet || legal.canRaise) && (adjusted > 0.58 || bluff)) {
      const fraction = adjusted > 0.76 ? 0.75 : (bluff ? 0.4 : 0.55);
      return { action: state.currentBet === 0 ? ACTIONS.BET : ACTIONS.RAISE, amount: raiseTarget(state, legal, fraction) };
    }
    return { action: ACTIONS.CHECK, amount: null };
  }

  if (legal.canAllIn && adjusted > 0.88 && stackToPot < 1.25) return { action: ACTIONS.ALL_IN, amount: null };
  if (legal.canRaise && adjusted > 0.72 && rng() < 0.62) {
    return { action: ACTIONS.RAISE, amount: raiseTarget(state, legal, adjusted > 0.85 ? 0.85 : 0.6) };
  }
  if (adjusted + 0.045 >= potOdds) return { action: ACTIONS.CALL, amount: null };
  return { action: ACTIONS.FOLD, amount: null };
}

function chooseExpert({ state, seat, legal, equity, position, rng }) {
  const pot = Math.max(1, state.potTotal ?? 0);
  const potOdds = legal.callAmount / Math.max(1, pot + legal.callAmount);
  const stackToPot = seat.stack / pot;
  const positionalEdge = (position - 0.5) * 0.08;
  const adjusted = clamp(equity + positionalEdge + randomBetween(rng, -0.018, 0.018));
  const bluffChance = 0.035 + (position * 0.085);

  if (legal.canCheck) {
    const bluff = rng() < bluffChance;
    if ((legal.canBet || legal.canRaise) && (adjusted > 0.50 || bluff)) {
      let fraction = 0.5;
      if (adjusted > 0.82) fraction = stackToPot < 1.5 ? 1 : 0.75;
      else if (adjusted < 0.58) fraction = rng() < 0.55 ? 0.33 : 0.66;
      return { action: state.currentBet === 0 ? ACTIONS.BET : ACTIONS.RAISE, amount: raiseTarget(state, legal, fraction) };
    }
    return { action: ACTIONS.CHECK, amount: null };
  }

  const edge = adjusted - potOdds;
  if (legal.canAllIn && adjusted > 0.90 && stackToPot < 1.7) return { action: ACTIONS.ALL_IN, amount: null };
  if (legal.canRaise && (adjusted > 0.76 || (position > 0.68 && rng() < bluffChance * 0.45))) {
    const fraction = adjusted > 0.88 ? 1 : (edge > 0.34 ? 0.75 : 0.55);
    return { action: ACTIONS.RAISE, amount: raiseTarget(state, legal, fraction) };
  }
  if (edge >= 0.015 || (edge > -0.025 && position > 0.65 && rng() < 0.45)) return { action: ACTIONS.CALL, amount: null };
  return { action: ACTIONS.FOLD, amount: null };
}


function applyPersonality({ decision, personality, state, seat, legal, rng }) {
  const normalized = normalizeBotPersonality(personality) ?? BOT_PERSONALITIES.CALM;
  const aggressive = decision.action === ACTIONS.BET || decision.action === ACTIONS.RAISE || decision.action === ACTIONS.ALL_IN;
  const passiveFallback = () => legal.canCheck
    ? { action: ACTIONS.CHECK, amount: null }
    : (legal.canCall ? { action: ACTIONS.CALL, amount: null } : { action: ACTIONS.FOLD, amount: null });

  if (normalized === BOT_PERSONALITIES.CALM) {
    if (aggressive && rng() < 0.32) return passiveFallback();
    if (decision.action === ACTIONS.CALL) {
      const pressure = legal.callAmount / Math.max(1, seat.stack + legal.callAmount);
      if (pressure > 0.35 && rng() < 0.20) return { action: ACTIONS.FOLD, amount: null };
    }
    return decision;
  }

  if (normalized === BOT_PERSONALITIES.RISKY) {
    if (decision.action === ACTIONS.CHECK && legal.canBet && rng() < 0.20) {
      return { action: ACTIONS.BET, amount: raiseTarget(state, legal, rng() < 0.5 ? 0.45 : 0.7) };
    }
    if (decision.action === ACTIONS.CALL && legal.canRaise && rng() < 0.18) {
      return { action: ACTIONS.RAISE, amount: raiseTarget(state, legal, rng() < 0.55 ? 0.55 : 0.8) };
    }
    if (decision.action === ACTIONS.FOLD && legal.canCall && rng() < 0.10) return { action: ACTIONS.CALL, amount: null };
    return decision;
  }

  if (normalized !== BOT_PERSONALITIES.RECKLESS) return decision;

  if (decision.action === ACTIONS.CHECK && legal.canBet && rng() < 0.42) {
    return { action: ACTIONS.BET, amount: raiseTarget(state, legal, rng() < 0.45 ? 0.65 : 1) };
  }
  if (decision.action === ACTIONS.CALL && legal.canRaise && rng() < 0.38) {
    if (legal.canAllIn && rng() < 0.20) return { action: ACTIONS.ALL_IN, amount: null };
    return { action: ACTIONS.RAISE, amount: raiseTarget(state, legal, rng() < 0.45 ? 0.75 : 1.15) };
  }
  if (decision.action === ACTIONS.FOLD && legal.canCall) {
    if (legal.canAllIn && rng() < 0.08) return { action: ACTIONS.ALL_IN, amount: null };
    if (rng() < 0.24) return { action: ACTIONS.CALL, amount: null };
  }
  if (aggressive && legal.canAllIn && rng() < 0.16) return { action: ACTIONS.ALL_IN, amount: null };
  return decision;
}

export function normalizeBotLevel(value) {
  return LEVEL_SET.has(value) ? value : null;
}

export function normalizeBotPersonality(value) {
  return PERSONALITY_SET.has(value) ? value : null;
}

export function botThinkDelay(level, personalityOrRng = BOT_PERSONALITIES.CALM, maybeRng = Math.random) {
  const { personality, rng } = resolvePersonalityAndRng(personalityOrRng, maybeRng);
  const levelFactor = {
    [BOT_LEVELS.NOVICE]: 1.12,
    [BOT_LEVELS.EXPERIENCED]: 1,
    [BOT_LEVELS.EXPERT]: 0.88
  }[normalizeBotLevel(level)] ?? 1;
  const ranges = {
    [BOT_PERSONALITIES.CALM]: [1700, 4700],
    [BOT_PERSONALITIES.RISKY]: [850, 3100],
    [BOT_PERSONALITIES.RECKLESS]: [350, 2200]
  };
  const [min, max] = ranges[personality];
  return Math.round(integerBetween(rng, min, max) * levelFactor);
}

export function chooseBotAction(engine, seatIndex, level, personalityOrRng = BOT_PERSONALITIES.CALM, maybeRng = Math.random) {
  const normalizedLevel = normalizeBotLevel(level) ?? BOT_LEVELS.NOVICE;
  const { personality, rng } = resolvePersonalityAndRng(personalityOrRng, maybeRng);
  const state = { ...engine.state, potTotal: engine.potTotal ?? engine.state?.potTotal ?? 0 };
  const seat = state.seats?.[seatIndex];
  const legal = engine.legalActions(seatIndex);
  if (!seat || !legal) throw new Error("FBLPoker.Errors.BotCannotAct");

  const holeCards = engine.privateCards(seatIndex);
  const community = [...(state.community ?? [])];
  const opponentCount = Math.max(1, state.seats.filter((candidate) => candidate?.inHand && !candidate.folded && candidate.index !== seatIndex).length);
  const position = positionScore(state, seatIndex);

  let decision;
  if (normalizedLevel === BOT_LEVELS.NOVICE) {
    const strength = community.length ? madeHandStrength([...holeCards, ...community]) : preflopStrength(holeCards);
    decision = chooseNovice({ state, seat, legal, strength, rng });
  } else {
    const baseIterations = normalizedLevel === BOT_LEVELS.EXPERT ? 220 : 75;
    const iterations = Math.max(35, Math.round(baseIterations / Math.sqrt(opponentCount)));
    const equity = estimateEquity({ holeCards, community, opponentCount, iterations, rng });
    decision = normalizedLevel === BOT_LEVELS.EXPERT
      ? chooseExpert({ state, seat, legal, equity, position, rng })
      : chooseExperienced({ state, seat, legal, equity, position, rng });
  }

  if (!decision?.action) return fallbackAction(legal);
  decision = applyPersonality({ decision, personality, state, seat, legal, rng });
  if ((decision.action === ACTIONS.BET && !legal.canBet) || (decision.action === ACTIONS.RAISE && !legal.canRaise)) return fallbackAction(legal);
  if (decision.action === ACTIONS.CALL && !legal.canCall) return fallbackAction(legal);
  if (decision.action === ACTIONS.CHECK && !legal.canCheck) return fallbackAction(legal);
  if (decision.action === ACTIONS.ALL_IN && !legal.canAllIn) return fallbackAction(legal);
  return decision;
}

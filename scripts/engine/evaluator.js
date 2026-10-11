const RANK_VALUE = Object.freeze({
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7,
  "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14
});

const CATEGORY_NAMES = Object.freeze([
  "highCard",
  "pair",
  "twoPair",
  "threeKind",
  "straight",
  "flush",
  "fullHouse",
  "fourKind",
  "straightFlush"
]);

function straightHigh(ranks) {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  let run = 1;
  for (let index = 1; index < unique.length; index += 1) {
    if (unique[index - 1] - 1 === unique[index]) {
      run += 1;
      if (run >= 5) return unique[index - 4];
    } else {
      run = 1;
    }
  }
  return 0;
}

export function evaluateFive(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) throw new Error("Exactly five cards are required");
  const parsed = cards.map((card) => ({ card, rank: RANK_VALUE[card[0]], suit: card[1] }));
  const ranks = parsed.map((card) => card.rank).sort((a, b) => b - a);
  const flush = parsed.every((card) => card.suit === parsed[0].suit);
  const highStraight = straightHigh(ranks);
  const groups = [...ranks.reduce((map, rank) => map.set(rank, (map.get(rank) ?? 0) + 1), new Map()).entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  let category;
  let kickers;
  if (flush && highStraight) {
    category = 8;
    kickers = [highStraight];
  } else if (groups[0].count === 4) {
    category = 7;
    kickers = [groups[0].rank, groups[1].rank];
  } else if (groups[0].count === 3 && groups[1].count === 2) {
    category = 6;
    kickers = [groups[0].rank, groups[1].rank];
  } else if (flush) {
    category = 5;
    kickers = ranks;
  } else if (highStraight) {
    category = 4;
    kickers = [highStraight];
  } else if (groups[0].count === 3) {
    category = 3;
    kickers = [groups[0].rank, ...groups.slice(1).map((group) => group.rank).sort((a, b) => b - a)];
  } else if (groups[0].count === 2 && groups[1].count === 2) {
    const pairs = groups.filter((group) => group.count === 2).map((group) => group.rank).sort((a, b) => b - a);
    const single = groups.find((group) => group.count === 1).rank;
    category = 2;
    kickers = [...pairs, single];
  } else if (groups[0].count === 2) {
    category = 1;
    kickers = [groups[0].rank, ...groups.slice(1).map((group) => group.rank).sort((a, b) => b - a)];
  } else {
    category = 0;
    kickers = ranks;
  }

  return {
    category,
    categoryName: CATEGORY_NAMES[category],
    kickers,
    cards: [...cards],
    score: [category, ...kickers]
  };
}

export function compareEvaluations(left, right) {
  const length = Math.max(left.score.length, right.score.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.score[index] ?? 0) - (right.score[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function evaluateSeven(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) {
    throw new Error("Five to seven cards are required");
  }
  if (cards.length === 5) return evaluateFive(cards);

  const parsed = cards.map((card) => ({ card, rank: RANK_VALUE[card[0]], suit: card[1] }));
  const rankCounts = Array(15).fill(0);
  const cardsByRank = Array.from({ length: 15 }, () => []);
  const cardsBySuit = new Map();
  for (const entry of parsed) {
    rankCounts[entry.rank] += 1;
    cardsByRank[entry.rank].push(entry.card);
    const suited = cardsBySuit.get(entry.suit) ?? [];
    suited.push(entry);
    cardsBySuit.set(entry.suit, suited);
  }

  const ranksDescending = [];
  const pairs = [];
  const trips = [];
  let quads = 0;
  for (let rank = 14; rank >= 2; rank -= 1) {
    if (!rankCounts[rank]) continue;
    ranksDescending.push(rank);
    if (rankCounts[rank] >= 4 && !quads) quads = rank;
    if (rankCounts[rank] >= 3) trips.push(rank);
    if (rankCounts[rank] >= 2) pairs.push(rank);
  }

  let straightFlushHigh = 0;
  let straightFlushSuit = null;
  for (const [suit, suited] of cardsBySuit) {
    if (suited.length < 5) continue;
    const high = straightHigh(suited.map((entry) => entry.rank));
    if (high > straightFlushHigh) {
      straightFlushHigh = high;
      straightFlushSuit = suit;
    }
  }
  if (straightFlushHigh) {
    return evaluationResult(8, [straightFlushHigh], selectStraightCards(parsed, straightFlushHigh, straightFlushSuit));
  }

  if (quads) {
    const kicker = ranksDescending.find((rank) => rank !== quads);
    return evaluationResult(7, [quads, kicker], [...cardsByRank[quads].slice(0, 4), cardsByRank[kicker][0]]);
  }

  if (trips.length) {
    const trip = trips[0];
    const pair = pairs.find((rank) => rank !== trip);
    if (pair) {
      return evaluationResult(6, [trip, pair], [...cardsByRank[trip].slice(0, 3), ...cardsByRank[pair].slice(0, 2)]);
    }
  }

  let flushEntries = null;
  for (const suited of cardsBySuit.values()) {
    if (suited.length < 5) continue;
    if (!flushEntries || compareRankLists(
      suited.map((entry) => entry.rank).sort((a, b) => b - a).slice(0, 5),
      flushEntries.map((entry) => entry.rank)
    ) > 0) {
      flushEntries = [...suited].sort((a, b) => b.rank - a.rank).slice(0, 5);
    }
  }
  if (flushEntries) {
    const kickers = flushEntries.map((entry) => entry.rank);
    return evaluationResult(5, kickers, flushEntries.map((entry) => entry.card));
  }

  const highStraight = straightHigh(ranksDescending);
  if (highStraight) {
    return evaluationResult(4, [highStraight], selectStraightCards(parsed, highStraight));
  }

  if (trips.length) {
    const trip = trips[0];
    const kickers = ranksDescending.filter((rank) => rank !== trip).slice(0, 2);
    return evaluationResult(3, [trip, ...kickers], [...cardsByRank[trip].slice(0, 3), ...kickers.map((rank) => cardsByRank[rank][0])]);
  }

  if (pairs.length >= 2) {
    const highPair = pairs[0];
    const lowPair = pairs[1];
    const kicker = ranksDescending.find((rank) => rank !== highPair && rank !== lowPair);
    return evaluationResult(2, [highPair, lowPair, kicker], [
      ...cardsByRank[highPair].slice(0, 2),
      ...cardsByRank[lowPair].slice(0, 2),
      cardsByRank[kicker][0]
    ]);
  }

  if (pairs.length === 1) {
    const pair = pairs[0];
    const kickers = ranksDescending.filter((rank) => rank !== pair).slice(0, 3);
    return evaluationResult(1, [pair, ...kickers], [...cardsByRank[pair].slice(0, 2), ...kickers.map((rank) => cardsByRank[rank][0])]);
  }

  const kickers = ranksDescending.slice(0, 5);
  return evaluationResult(0, kickers, kickers.map((rank) => cardsByRank[rank][0]));
}

function evaluationResult(category, kickers, cards) {
  return {
    category,
    categoryName: CATEGORY_NAMES[category],
    kickers,
    cards,
    score: [category, ...kickers]
  };
}

function selectStraightCards(parsed, high, suit = null) {
  const ranks = high === 5 ? [5, 4, 3, 2, 14] : [high, high - 1, high - 2, high - 3, high - 4];
  return ranks.map((rank) => parsed.find((entry) => entry.rank === rank && (suit === null || entry.suit === suit))?.card).filter(Boolean);
}

function compareRankLists(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

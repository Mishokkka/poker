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

function combinations(values, count) {
  const result = [];
  const walk = (start, chosen) => {
    if (chosen.length === count) {
      result.push(chosen);
      return;
    }
    for (let index = start; index <= values.length - (count - chosen.length); index += 1) {
      walk(index + 1, [...chosen, values[index]]);
    }
  };
  walk(0, []);
  return result;
}

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
  const candidates = combinations(cards, 5).map(evaluateFive);
  return candidates.reduce((best, candidate) => compareEvaluations(candidate, best) > 0 ? candidate : best);
}

import assert from "node:assert/strict";
import { evaluateFive, evaluateSeven } from "../scripts/engine/evaluator.js";

const ranks = "23456789TJQKA";
const suits = "cdhs";
const deck = [...ranks].flatMap((rank) => [...suits].map((suit) => `${rank}${suit}`));

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

function compareScores(left, right) {
  const length = Math.max(left.score.length, right.score.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.score[index] ?? 0) - (right.score[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// Reference implementation used by evaluateSeven before the performance optimization.
function referenceEvaluateSeven(cards) {
  const candidates = combinations(cards, 5).map(evaluateFive);
  return candidates.reduce((best, candidate) => compareScores(candidate, best) > 0 ? candidate : best);
}

let seed = 0x51f15e7;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x1_0000_0000;
}

function sampleCards(count) {
  const pool = [...deck];
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const selected = index + Math.floor(random() * (pool.length - index));
    [pool[index], pool[selected]] = [pool[selected], pool[index]];
    result.push(pool[index]);
  }
  return result;
}

const edgeCases = [
  ["As", "Ks", "Qs", "Js", "Ts", "9s", "8s"],
  ["Ah", "Ad", "Ac", "Kh", "Kd", "Kc", "2s"],
  ["5s", "4d", "3h", "2c", "As", "Kd", "Qh"],
  ["Ah", "Ad", "Ac", "As", "Kh", "Kd", "2c"],
  ["As", "Js", "9s", "6s", "3s", "2s", "Kd"],
  ["Qh", "Qd", "Jh", "Jd", "Ts", "9c", "8s"]
];

for (const cards of edgeCases) {
  assert.deepEqual(evaluateSeven(cards).score, referenceEvaluateSeven(cards).score, `Edge-case score mismatch for ${cards.join(" ")}`);
}

for (const count of [6, 7]) {
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const cards = sampleCards(count);
    const optimized = evaluateSeven(cards);
    const reference = referenceEvaluateSeven(cards);
    assert.deepEqual(optimized.score, reference.score, `Score mismatch for ${cards.join(" ")}`);
    assert.equal(optimized.categoryName, reference.categoryName, `Category mismatch for ${cards.join(" ")}`);
  }
}

console.log("Optimized evaluator matches the previous combination-based evaluator on edge cases and 20,000 seeded random hands.");

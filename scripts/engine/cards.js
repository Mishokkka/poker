import { CARD_RANKS, CARD_SUITS } from "../constants.js";

export function createDeck() {
  return CARD_SUITS.flatMap((suit) => CARD_RANKS.map((rank) => `${rank}${suit}`));
}

export function shuffleDeck(deck = createDeck(), randomSource = crypto) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const bytes = new Uint32Array(1);
    randomSource.getRandomValues(bytes);
    const j = bytes[0] % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function cardRank(card) {
  return card?.[0] ?? "";
}

export function cardSuit(card) {
  return card?.[1] ?? "";
}

export function cardDisplay(card) {
  if (!card) return { rank: "?", suit: "?", symbol: "?", red: false };
  const rawRank = cardRank(card);
  const rank = rawRank === "T" ? "10" : rawRank;
  const suit = cardSuit(card);
  const symbols = { s: "♠", h: "♥", d: "♦", c: "♣" };
  return { rank, suit: suit || "?", symbol: symbols[suit] ?? "?", red: suit === "h" || suit === "d" };
}

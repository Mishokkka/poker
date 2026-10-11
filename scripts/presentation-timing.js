export const PRESENTATION = Object.freeze({ card: 520, holeInterval: 140, boardInterval: 100, chips: 320, pot: 420, deckCycle: 280 });

export function dealDuration(count, interval = PRESENTATION.holeInterval) {
  return count > 0 ? (count - 1) * interval + PRESENTATION.card : 0;
}

/** Shared by the host's turn allowance and the client's visual sequence. */
export function presentationDelay(previous, table) {
  if (!previous || table.paused || table.deliveryPending || table.recoveryRequired || table.status === "waiting") return 0;
  const newHand = previous.handNumber !== table.handNumber;
  if (table.status !== "complete" && (newHand || previous.deliveryPending)) {
    return dealDuration(table.seats.filter(seat => seat?.inHand).length * 2);
  }
  const added = table.community.length - (newHand ? 0 : previous.community.length);
  return dealDuration(Math.max(0, added), PRESENTATION.boardInterval);
}

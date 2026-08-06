export function buildSidePots(seats) {
  const contributors = seats.filter((seat) => seat?.handCommitted > 0);
  const levels = [...new Set(contributors.map((seat) => seat.handCommitted))].sort((a, b) => a - b);
  const pots = [];
  let previous = 0;

  for (const level of levels) {
    const participants = contributors.filter((seat) => seat.handCommitted >= level);
    const amount = (level - previous) * participants.length;
    if (amount > 0) {
      pots.push({
        amount,
        cap: level,
        contributors: participants.map((seat) => seat.index),
        eligible: participants.filter((seat) => !seat.folded).map((seat) => seat.index)
      });
    }
    previous = level;
  }
  return pots;
}

export function clockwiseOrder(indices, dealerIndex, seatCount) {
  return [...indices].sort((left, right) => {
    const leftDistance = (left - dealerIndex + seatCount) % seatCount;
    const rightDistance = (right - dealerIndex + seatCount) % seatCount;
    return leftDistance - rightDistance;
  });
}

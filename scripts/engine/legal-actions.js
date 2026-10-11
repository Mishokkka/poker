import { ACTIVE_STREETS } from "../constants.js";

/** Pure rules shared by the host, bots, and the action panel. Amounts are street totals. */
export function legalActions(table, seat) {
  if (table.paused || table.deliveryPending || table.recoveryRequired || !seat?.inHand
    || !ACTIVE_STREETS.has(table.status) || table.currentSeat !== seat.index || seat.folded || seat.allIn) return null;
  const owed = Math.max(0, table.currentBet - seat.streetBet);
  const maxTarget = seat.streetBet + seat.stack;
  const fullRaiseTarget = table.currentBet === 0 ? table.bigBlind : table.currentBet + Math.max(table.bigBlind, table.lastFullRaise);
  const reopened = seat.actedAtBet == null
    ? !(table.raiseLocked ?? []).includes(seat.index)
    : table.currentBet - seat.actedAtBet >= (seat.actedRaiseSize ?? table.lastFullRaise);
  const raiseAllowed = reopened && maxTarget > table.currentBet;
  const potTotal = table.potTotal ?? table.seats.reduce((sum, s) => sum + (s?.handCommitted ?? 0), 0);
  const minTarget = Math.min(maxTarget, fullRaiseTarget);
  const fractionTarget = fraction => Math.min(maxTarget, Math.max(minTarget,
    table.currentBet === 0 ? Math.round(potTotal * fraction) : table.currentBet + Math.round((potTotal + owed) * fraction)));
  return {
    callAmount: Math.min(owed, seat.stack), canFold: true, canCheck: owed === 0,
    canCall: owed > 0 && seat.stack > 0, canBet: table.currentBet === 0 && raiseAllowed,
    canRaise: table.currentBet > 0 && raiseAllowed,
    canAllIn: seat.stack > 0 && (maxTarget <= table.currentBet || raiseAllowed),
    minTarget, fullRaiseTarget, maxTarget, potTotal, showRaiseControls: raiseAllowed,
    thirdPotTarget: fractionTarget(1 / 3), halfPotTarget: fractionTarget(1 / 2),
    threeQuarterPotTarget: fractionTarget(3 / 4), potTarget: fractionTarget(1)
  };
}

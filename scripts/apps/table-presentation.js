import { PRESENTATION } from "../presentation-timing.js";

const displayedPot = table => table.status === "complete" ? (table.lastResult?.potTotal ?? 0) : table.potTotal;
const blocked = table => table.paused || table.deliveryPending || table.recoveryRequired || table.status === "waiting";

/** Local presentation state survives Foundry replacing the entire template body. */
export class TablePresentation {
  effects = new Map();
  previous = null;
  resultAt = 0;

  effect(key, now = Date.now()) {
    const effect = this.effects.get(key);
    return effect && effect.start + effect.duration > now
      ? { ...effect, delay: effect.start - now } : null;
  }

  update(table, { now = Date.now(), reducedMotion = false, ownTurn = false } = {}) {
    const previous = this.previous;
    const newHand = previous && previous.handNumber !== table.handNumber;
    const completed = previous && table.status === "complete" && (newHand || previous.status !== "complete");
    const stop = blocked(table);
    const motionChanged = this.reducedMotion !== undefined && reducedMotion !== this.reducedMotion;
    const cancelSounds = Boolean(newHand || completed || stop || motionChanged);
    const turnChanged = !previous || newHand || previous.status !== table.status || previous.currentSeat !== table.currentSeat
      || Boolean(blocked(previous)) !== Boolean(stop) || this.ownTurn !== ownTurn;
    if (newHand || stop || motionChanged) { this.effects.clear(); this.resultAt = 0; }
    for (const [key, effect] of this.effects) {
      if (effect.start + effect.duration <= now || (completed && (key.startsWith("hole:") || key === "deck"))) this.effects.delete(key);
    }
    const sounds = [];
    const sound = (id, delay = 0, turn = false) => sounds.push({ id, at: now + delay, turn });
    const put = (key, duration, delay = 0) => {
      if (!reducedMotion) this.effects.set(key, { start: now + delay, duration });
    };
    if (previous && !stop) {
      const deal = table.status !== "complete" && (newHand || previous.deliveryPending);
      if (deal) {
        const order = [];
        for (let step = 1; step <= table.maxSeats; step++) {
          const index = (table.dealerIndex + step + table.maxSeats) % table.maxSeats;
          if (table.seats[index]?.inHand) order.push(index);
        }
        for (let round = 0; round < 2; round++) order.forEach((index, position) => {
          const delay = (round * order.length + position) * PRESENTATION.holeInterval;
          put(`hole:${index}:${round}`, PRESENTATION.card, delay);
          if (!reducedMotion) sound("holeDeal", delay);
        });
      }
      const from = newHand ? 0 : previous.community.length;
      const added = table.community.length - from;
      if (added > 0) {
        for (let i = from; i < table.community.length; i++) {
          const delay = (i - from) * PRESENTATION.boardInterval;
          put(`board:${i}`, PRESENTATION.card, delay);
          if (!reducedMotion) sound("communityDeal", delay);
        }
      }
      if (completed) {
        // Cancelling the old audio queue must not silence board cards that have yet to start.
        for (let i = 0; i < from; i++) {
          const pending = this.effect(`board:${i}`, now);
          if (pending?.start > now) sound("communityDeal", pending.start - now);
        }
      }
      if (deal || added > 0 || completed) {
        const ends = [...this.effects].filter(([key]) => key.startsWith("hole:") || key.startsWith("board:"))
          .map(([, effect]) => effect.start + effect.duration);
        const remaining = Math.max(now, ...ends) - now;
        this.effects.delete("deck");
        if (remaining > 0) put("deck", remaining);
      }
      if (displayedPot(table) !== displayedPot(previous)) put("pot", PRESENTATION.pot);
      table.seats.forEach((seat, index) => {
        const prior = newHand ? null : previous.seats[index];
        if (seat?.streetBet > 0 && (seat.actorId !== prior?.actorId || seat.streetBet > (prior?.streetBet ?? 0))) put(`chips:${index}`, PRESENTATION.chips);
      });
      // A mutation can append an action, a street, and a result. Consume all new log entries.
      const boundary = (table.log ?? []).findIndex(entry => entry.id === previous.log?.[0]?.id);
      const seen = new Set(previous.log.map(entry => entry.id));
      const entries = boundary >= 0 ? table.log.slice(0, boundary) : (table.log ?? []).filter(entry => entry.handNumber === table.handNumber && !seen.has(entry.id));
      const actionSounds = new Set();
      // Forced bets are recorded on seats, rather than as separate log entries.
      if ((newHand || deal) && (table.seats.some(seat => seat?.handCommitted > 0) || table.lastResult?.potTotal > 0)) actionSounds.add("chips");
      for (const entry of entries.toReversed()) {
        if (["smallBlind", "bigBlind", "ante", "call", "bet", "raise"].includes(entry.type)) actionSounds.add("chips");
        else if (["allIn", "fold", "check"].includes(entry.type)) actionSounds.add(entry.type);
      }
      for (const id of actionSounds) sound(id);
      if (completed) {
        const deck = this.effect("deck", now);
        this.resultAt = deck ? deck.start + deck.duration : now;
        sound("win", Math.max(0, this.resultAt - now));
      }
      if (turnChanged && ownTurn && table.currentSeat !== null) {
        const deck = this.effect("deck", now);
        sound("turn", deck ? Math.max(0, deck.start + deck.duration - now) : 0, true);
      }
    }
    this.previous = { ...table, seats: table.seats.map(seat => seat ? { ...seat } : null), community: [...table.community], log: [...(table.log ?? [])] };
    this.reducedMotion = reducedMotion;
    this.ownTurn = ownTurn;
    return { sounds, cancelSounds, cancelTurn: turnChanged || cancelSounds, resultPending: table.status === "complete" && this.resultAt > now };
  }
}

/** Translation is relative to each card's untransformed center, including after a resize. */
export function positionCardOrigins(root) {
  const deck = root?.querySelector?.(".fbl-poker-deck")?.getBoundingClientRect();
  if (!deck) return;
  const cards = [...root.querySelectorAll(".fbl-poker-card.is-dealing")];
  const rects = cards.map(card => {
    const rect = card.getBoundingClientRect();
    const transform = getComputedStyle(card).transform;
    const matrix = transform === "none" ? { m41: 0, m42: 0 } : new DOMMatrixReadOnly(transform);
    return { x: rect.x + rect.width / 2 - matrix.m41, y: rect.y + rect.height / 2 - matrix.m42 };
  });
  cards.forEach((card, i) => {
    card.style.setProperty("--deal-x", `${deck.x + deck.width / 2 - rects[i].x}px`);
    card.style.setProperty("--deal-y", `${deck.y + deck.height / 2 - rects[i].y}px`);
  });
}

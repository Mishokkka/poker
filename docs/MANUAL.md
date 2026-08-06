# User Manual

## Opening the lobby

Use the spade tool in the Token scene controls, press `Ctrl+Shift+P`, or run `game.fblPoker.openLobby()` from a macro.

At least one GM must remain connected. The alphabetically first active GM user ID becomes the table host.

## Creating and editing a table

Only a GM can create, edit or delete a table. Configure seats, blinds, ante, buy-in limits, turn time, and the copper value of one chip.

Rules can be edited between hands. Seat count and chip value are locked while any Actor remains seated because changing either would invalidate the layout or existing stacks.

## Joining

Choose an Actor you own, enter a buy-in inside the table limits, then click an empty chair. The module converts the Actor's entire wallet to a canonical copper value, deducts the buy-in, then writes the remaining amount back as gold, silver, and copper.

A single Actor cannot be seated at multiple module tables.


## NPC poker bots

A GM can add a bot from the same dialog used to occupy an empty seat. Select an NPC Actor, enter the buy-in, and choose Novice, Experienced, or Expert in the seat-controller field. A normal player-controlled Actor must have enough Forbidden Lands currency for the buy-in. A GM may seat an NPC with a full stack even when its wallet is short; the Actor pays only the currency currently available, and the table still grants the selected buy-in.

Novice bots play loosely and make intentional errors. Experienced bots use equity, pot odds, and position. Expert bots run a larger local equity simulation and vary their sizing and bluffs. Bots act automatically after a short thinking delay. Their hidden cards remain concealed in the table UI until showdown.

Bots do not receive opponent hole cards. They use their own hand, the board, stacks, bets, position, and the public action state. A bot that loses its stack remains seated but cannot enter another hand until the GM buys more chips.

## Playing

The action panel appears only for the user who controls the current seat. A GM may act for any seat, which permits manually controlled NPC opponents.

Bet and raise inputs are total street amounts, not an amount added on top. The range input and quick buttons calculate minimum, one-third-pot, half-pot, three-quarter-pot, pot and maximum legal targets.

When the timer expires, the host checks automatically when checking is legal; otherwise it folds. A GM may pause the hand. Resuming starts a fresh action timer for the current seat.

## Stack management

Between hands, the seat menu can buy more chips up to the table maximum. The top-up window also limits the purchase by the Actor's available wallet.

Cash-out returns the full remaining stack to the seated Actor and removes the seat. Sit Out keeps the seat while skipping future hands.

During a hand, a player may queue either Sit Out After Hand or Leave After Hand. The queued choice can be cancelled before the hand ends. Deferred cash-out includes any winnings from that hand.

## Hand history

The history control in the window header opens the latest 100 completed hands. Each entry contains the board, public showdown cards, stack changes, awards and public action log. The history can be exported as JSON.

Unshown folded cards and cards from uncontested pots are never added to public history.

## Interrupted sessions

If the host reloads during an active hand, the hand is cancelled. Every seat receives its committed chips back. This is deliberate because the deck and hole cards are never persisted publicly.


## Remote clients and Web Crypto

Private poker transport requires Web Crypto. Every participating browser must open Foundry through HTTPS or localhost. If the API is unavailable, the module refuses to initialize rather than sending hole cards, session tokens, action requests, acknowledgements, or private errors as readable socket payloads.
## Sound settings

The GM-only speaker icon in the table title bar opens the sound editor. Each poker event has its own path, preview button, and volume slider. Empty or reset paths use the bundled sounds in `assets/sounds`. Volume zero disables the selected event.



## Automatic continuation

The GM can enable automatic continuation with the forward icon in the table title bar. The delay is configured in **Table Settings → Automatic play**. When a hand finishes and at least two eligible players remain, the next hand starts after the countdown. Disabling the option cancels a pending countdown.

## Automated NPC personalities

When a GM places an NPC Actor at a seat, the controller may be set to Novice, Experienced, or Expert and assigned one of three personalities:

- **Calm**: slower, more conservative, less likely to bluff or escalate marginal hands.
- **Risky**: more calls, raises, and occasional positional bluffs.
- **Reckless**: faster and highly aggressive, with substantially more loose calls, raises, and all-ins.

Automated seats are not visually identified at the table. Their control metadata is omitted from client-facing table snapshots.

## Seat management

Right-click a seat you control to open its management menu. Top-up, sit-out, queued sit-out, queued departure, and cash-out are available there according to the current hand state.

# Forbidden Lands Poker Table

A Foundry VTT module for character-based No-Limit Texas Hold'em using Forbidden Lands Actor currency.

## Target environment

- Foundry VTT 13.351
- Forbidden Lands 13.0.5
- Application V2 UI
- No external module dependency

## Implemented in 1.7.12

- 2–10 seat No-Limit Texas Hold'em cash tables
- dealer button, small blind, big blind and ante
- fold, check, call, bet, raise and all-in
- minimum-raise validation and short all-in reopening rules
- side pots, ties and odd-chip allocation
- automatic flop, turn, river and showdown
- configurable automatic continuation to the next hand
- host-provisioned private sessions, action requests, errors, and hole-card delivery through Foundry v13 targeted user queries
- active-GM authoritative game engine
- action timer with automatic check or fold
- GM pause and resume during an active hand
- Actor portraits and ownership validation
- Forbidden Lands gold, silver and copper buy-in, top-up and cash-out
- queued sit-out or cash-out after the current hand
- editable table rules between hands
- persistent public history for the latest 100 completed hands
- JSON hand-history export
- compact ApplicationV2 header with status, hand, blinds, history, settings, and refresh controls
- enlarged poker cards with mirrored board corners and folded-hand dimming
- persistent public table state, durable money-operation journal and 500-entry display ledger
- safe recovery of interrupted hands by refunding committed bets
- Russian and English localization
- scene-control button and `Ctrl+Shift+P` shortcut

## Poker bots

A GM may click an empty seat, select an NPC Actor, choose its buy-in, assign one of three bot levels, and choose a playing personality:

- **Novice**: loose, inconsistent, and prone to visible mistakes.
- **Experienced**: uses equity, pot odds, position, and conventional bet sizing.
- **Expert**: uses deeper equity simulation, stack-to-pot pressure, variable sizing, and selective bluffs.

Bots use the selected Actor's Forbidden Lands wallet. Whenever a GM seats a character, with manual or automatic control, insufficient funds never block the buy-in: available funds are charged and the GM grants the difference. The journal records it as `subsidyCopper`. Their decisions are made on the active GM host from only their own hole cards and public table information. Opponent hole cards are not passed to the bot decision code. A GM can still sit the same Actor manually by leaving the controller set to manual.

## Installation

Extract the archive into:

`FoundryVTT/Data/modules/fbl-poker-table`

Enable **Forbidden Lands Poker Table** in the world. Open the lobby using the spade button in Token controls or press `Ctrl+Shift+P`.

A macro may also use:

```js
game.fblPoker.openLobby();
```

## Currency

Poker chips are internally integer values. Each table specifies how many copper coins one chip represents. Gold and silver conversion rates are world settings. Defaults are:

- 1 gold = 100 copper
- 1 silver = 10 copper

Buy-in and top-up remove currency from the selected Actor. Cash-out returns the remaining stack to that Actor.

## Recovery model

Hole cards and the shuffled deck are not written to world settings. If the active GM reloads during a hand, the module cancels that hand and returns each player's committed chips to their stack. Seated stacks, transaction records and completed hand histories remain persistent.

Money operations save their intent before writing the Actor wallet, and write a transaction marker together with the currency. Interrupted operations are reconciled from that marker without repeating the wallet change. An ambiguous outcome blocks the table until a GM refreshes and, if necessary, uses the reconciliation button in its title bar. A failed public notification does not refund an already committed buy-in or top-up. See the recovery procedure in `docs/MANUAL.md`.

After upgrading, reload all connected clients so that the host and players use the same request protocol.

## Security boundary

The module prevents ordinary accidental disclosure of hole cards and validates actions on the active GM client. On Foundry VTT v13, private poker traffic uses targeted `User.query` calls instead of the package-wide broadcast socket. The active GM provisions a separate session token directly to each active player, and action requests, private errors, and hole cards use Foundry's targeted query transport. These private payloads stay off the package-wide broadcast socket, while public table updates continue to use the normal module socket. Ordinary mutations send changed-table deltas; full snapshots are retained for startup/recovery. This works when Foundry is opened over a local-network HTTP address and does not require `crypto.subtle`.

Players need Foundry's normal `QUERY_USER` permission for remote poker actions. Foundry module code still runs on trusted clients, so this is not a hostile-client anti-cheat system and must not be used for real-money gambling.

See `docs/MANUAL.md`, `docs/ARCHITECTURE.md`, and `docs/KNOWN-LIMITATIONS.md`.

## Current interface

The table uses a full-window felt, lower-left action log, lower-right betting dock, title-bar GM controls, seat-selection dialog, one-seat-per-player enforcement, between-hand seat movement, and lightweight card/chip animations. Seat actions can be opened with the visible three-dot button, keyboard controls, or right-click.

## Sounds

The table includes built-in card, chip, action, turn, and victory sounds. A GM can open the speaker button in the poker-table title bar to replace any sound and set its volume independently. Setting a volume to zero disables that event.


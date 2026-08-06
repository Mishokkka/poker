# Forbidden Lands Poker Table

A Foundry VTT module for character-based No-Limit Texas Hold'em using Forbidden Lands Actor currency.

## Target environment

- Foundry VTT 13.351
- Forbidden Lands 13.0.5
- Application V2 UI
- No external module dependency

## Implemented in 1.7.6

- 2–10 seat No-Limit Texas Hold'em cash tables
- dealer button, small blind, big blind and ante
- fold, check, call, bet, raise and all-in
- minimum-raise validation and short all-in reopening rules
- side pots, ties and odd-chip allocation
- automatic flop, turn, river and showdown
- configurable automatic continuation to the next hand
- encrypted delivery of hole cards using Web Crypto ECDH + AES-GCM on secure browser contexts
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
- persistent public table state and 500-entry transaction ledger
- safe recovery of interrupted hands by refunding committed bets
- Russian and English localization
- scene-control button and `Ctrl+Shift+P` shortcut

## Poker bots

A GM may click an empty seat, select an NPC Actor, choose its buy-in, assign one of three bot levels, and choose a playing personality:

- **Novice**: loose, inconsistent, and prone to visible mistakes.
- **Experienced**: uses equity, pot odds, position, and conventional bet sizing.
- **Expert**: uses deeper equity simulation, stack-to-pot pressure, variable sizing, and selective bluffs.

Bots use the selected Actor's normal Forbidden Lands wallet. Their decisions are made on the active GM host from only their own hole cards and public table information. Opponent hole cards are not passed to the bot decision code. A GM can still sit the same Actor manually by leaving the controller set to manual.

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

## Security boundary

The module prevents ordinary accidental disclosure of hole cards and validates actions on the active GM client. Private payloads require Web Crypto and use ephemeral ECDH with AES-GCM. Foundry must be opened through HTTPS or localhost on every participating browser. If secure private transport is unavailable, the module refuses to initialize rather than broadcasting readable hole cards or session tokens.

Foundry module code runs on trusted clients, so this is not a hostile-client anti-cheat system and must not be used for real-money gambling.

See `docs/MANUAL.md`, `docs/ARCHITECTURE.md`, and `docs/KNOWN-LIMITATIONS.md`.

## Current interface

The table uses a full-window felt, lower-left action log, lower-right betting dock, title-bar GM controls, seat-selection dialog, one-seat-per-player enforcement, between-hand seat movement, and lightweight card/chip animations. Seat actions can be opened with the visible three-dot button, keyboard controls, or right-click.

## Sounds

The table includes built-in card, chip, action, turn, and victory sounds. A GM can open the speaker button in the poker-table title bar to replace any sound and set its volume independently. Setting a volume to zero disables that event.


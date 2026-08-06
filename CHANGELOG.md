## 1.7.3

- Added explicit stored-table schema migration and rejection of data created by unsupported newer module versions.
- Made module startup fail safely without exposing a partially initialized API or leaving socket listeners and timers behind.
- Serialized turn-timer actions through the same host queue as player, bot, and automatic-next-hand actions.
- Hardened buy-in and Actor-currency validation against `NaN`, infinities, overflow, and unsupported currency fields.
- Made table deletion clean every seat even when one payout fails, with failed payouts recorded for manual recovery.
- Fixed session-handshake timeout cleanup, secure-key wrapper mutation, unknown-card rendering, nullable checkbox defaults, and bot RNG boundary handling.
- Restored native form validation for table creation, table settings, and top-ups.
- Added a visible keyboard-accessible seat-actions button while retaining right-click support.
- Updated documentation, metadata, and regression tests for the current feature set.

## 1.7.2

- Synchronized the native Foundry window title on every table render, so the header follows pre-flop, flop, turn, river, pause, and hand completion instead of retaining the initial street.
- Automatically reveal every non-folded participant at a real showdown and record those cards in hand history.
- Keep cards hidden after an uncontested win; only that winner may choose to show or conceal them, with the same control available to the GM.
- Rebuilt the right-click seat menu as a client-local viewport portal. It no longer shifts with seat layout, cannot interfere with another client opening a menu, and renders above every table element.

## 1.7.1

- Compacted the table-creation window, removed stretched empty rows, and replaced the malformed automation checkbox with a stable custom control.
- GM seating now permits a full buy-in even when the selected Actor cannot afford it; the Actor pays only the currency currently available.
- Changed action colors: fold is red, check/call are green, bet/raise are orange, and all-in is gold.
- Replaced small fraction glyphs in bet presets with `1/3`, `1/2`, and `3/4`.
- Fixed duplicate hole-card dealing by delivering private hands before the public hand snapshot and suppressing mid-deal private-card rerenders.
- Added post-hand show/hide controls. Hole cards remain private by default, and each player may reveal or conceal their cards until the next hand.
- Reserved fixed board, pot, and result-banner slots so community cards no longer move when the pot or winner display changes.
- Confirmed and regression-tested games containing only automated seats; no human seat is required as long as at least two active seats have chips.

## 1.7.0

- Added per-table automatic continuation. The GM can enable or disable it from the title bar and configure a 1–120 second delay in table settings.
- Added an on-table countdown before the next automatically started hand.
- Added three bot personalities in addition to difficulty: Calm, Risky, and Reckless. Personality changes aggression, bluff frequency, and randomized thinking-time ranges.
- Removed all visible bot badges and robot icons from the table. Client-facing table snapshots no longer include bot level or personality metadata.
- Reworked hole-card animation persistence so a player’s revealed private cards still animate from the deck when the encrypted hand packet arrives after the public table update.
- Aggregated showdown awards by player, showing one total payout per winner instead of one line per side-pot share.
- Removed the redundant main/side-pot text below the community cards and slightly reduced community-card size.
- Moved top-up, sit-out, and leave actions into a right-click context menu on manageable player seats, freeing the player card width.
- Reworked the action-dock palette: neutral sizing presets, separated action buttons, consistent active colors, and smaller controls.
- Added regression tests for automatic continuation, anonymous public bot state, bot personalities, and randomized bot timing.

## 1.6.0

- Added GM-created poker bots using ordinary Forbidden Lands NPC Actors and their in-world currency wallets.
- Added three bot levels: Novice, Experienced, and Expert.
- Novice bots use simple hand categories, loose calls, and deliberate mistakes.
- Experienced bots estimate equity, compare pot odds, consider position, and use conventional value bets and occasional bluffs.
- Expert bots use deeper Monte Carlo equity estimates, stack-to-pot pressure, position, variable bet sizing, and selective bluffs.
- Bot decisions are made only from their own hole cards and public table state. They do not inspect opponent hole cards.
- Added automatic host-side bot turns with short human-like thinking delays and safe check/fold fallback behavior.
- Added bot selection to the GM seat dialog and bot difficulty badges on the table.
- Bot hole cards remain hidden from the GM table UI until showdown.
- Added bot decision and persistence regression tests.

## 1.5.1

- Replaced hand-tuned seat offsets with a single evenly spaced ellipse for every table size from 2 to 10 seats.
- Adjusted the ellipse center and vertical radius so neighboring seats no longer cluster or overlap on the sides.
- Lowered the bottom arc of seats into the previously unused gap above the action and history panels.
- Expanded the felt farther toward the bottom edge and moved the board area slightly higher for better vertical balance.
- Added a geometry regression test for equal angular spacing and ellipse placement.

## 1.5.0

- Adjusted the felt height and raised the central board, deck, pot, and community cards to better match the player seat ring.
- Added a visible card deck above the community-card slots, positioned to the left of the pot.
- Reworked hole-card dealing so cards animate sequentially clockwise from the dealer, over two dealing rounds, and originate from the visible deck.
- Added built-in sounds for hole-card deals, community cards, chips, check, fold, turn notification, all-in, and hand completion.
- Added a GM-only sound-settings button to the table header. Each event supports a custom audio path, preview, reset, and independent volume control.
- Added client-side transition sound playback driven by synchronized table state.

## 1.4.1

- Fixed the bottom overlay layout so the action history and action dock no longer cover the lower player seats.
- Reworked the action buttons to use a stable single-row layout without overlapping labels.
- Repositioned player bet chips so seats left of center place bets to the right, seats right of center place bets to the left, and center-aligned seats place them above or below.
- Added a collapsible action history panel.
- Lifted lower seats slightly to preserve visual separation from bottom overlays.

## 1.4.0

- Expanded the poker surface to the full window and replaced the permanent right sidebar with table overlays.
- Moved the action log to a PokerStars-style panel in the lower-left corner.
- Moved the betting controls to a compact lower-right dock with preset bet buttons, slider, amount field, and large action buttons.
- Moved GM start, pause/resume, cancel, history, settings, and refresh controls into the window title bar as icon-only buttons.
- Replaced the module close control with a single plain X and removed the surrounding circle/button decoration.
- Added a dedicated take-seat dialog opened from an empty chair.
- Enforced one occupied poker seat per non-GM user across all tables; GMs may seat multiple different Actors.
- Added voluntary seat movement between hands for players already seated at the same table.
- Moved seat management controls to a vertical strip on the right edge of each player card.
- Attached the turn countdown directly below the active player card.
- Preserved the remaining turn time across sit-out/leave queue changes and GM pause/resume instead of resetting the timer.
- Added card-dealing, chip-commit, and pot-update animations.

## 1.3.0

- Added manifest socket support (`"socket": true`) so remote players can discover the host and join tables reliably.
- Added world-setting bootstrap of the table list for players, improving lobby visibility before a session handshake completes.
- Reworked table window header: poker actions are injected directly into the title bar, and the close button now uses a normal X icon.
- Reworked seat cards: larger portrait area, top-aligned portrait crop, more compact text layout, and seat controls moved below the player block.
- Increased the size of hole cards and community cards. Hole cards now show the rank/suit line in the upper-left only; community cards show opposing corners.
- Folded hands now darken more clearly.
- Moved the turn timer from under the board to a shrinking progress bar under the active player seat.
- Reduced the width of the bottom action controls so they are easier to click.

# Changelog

## 1.2.0

- Fixed remote players failing to establish a poker session when Foundry is opened over plain HTTP and Web Crypto is unavailable.
- Added a compatibility private-payload transport and continuous handshake retries instead of leaving the player client disconnected.
- Broadcast public table state before the private session response so the lobby populates immediately for joining players.
- Clear cached private hands when a hand is canceled, rolled back, deleted, or replaced by a new hand.
- Removed poker result messages from Foundry chat; the table action log is now the only result feed.
- Moved table status, hand number, blinds, hand history, settings, and refresh controls into the ApplicationV2 window header.
- Rebuilt player-seat layering so occupied and empty seats render above the felt and rail.
- Moved seat-management controls below the player panel.
- Reworked hole cards to sit behind the player panel with their upper rank-and-suit corners exposed.
- Increased table and hole-card size, added mirrored board corners, darkened folded hands, and display ten as `10` instead of `T`.
- Added regression tests for HTTP clients, remote player state synchronization, private-card cache cleanup, and hand cancellation.

## 1.1.0

- Added stack top-ups between hands with wallet affordability and table-limit validation.
- Added queued sit-out and queued cash-out after the current hand.
- Added GM pause and resume for active hands.
- Added table settings editor with server-side validation and protected seat/chip-value changes.
- Added persistent public history for the latest 100 completed hands.
- Added JSON hand-history export.
- Added winner highlighting, result banner, main/side-pot labels and expanded raise presets.
- Added a synchronized raise slider and corrected pot-fraction raise target calculations.
- Added localized direct-host errors instead of exposing localization keys to the active GM.
- Expanded engine tests for administration, pause, top-up, queued actions and hand history.

## 1.0.1

- Fixed GM-hosted requests failing when the emitting Foundry client did not receive its own module-socket message.
- Added direct local dispatch for the active GM while preserving validated socket requests for remote clients.
- Applied snapshots and private hands locally on the host instead of waiting for a socket echo.
- Added ApplicationV2 content classes for stable window styling on Foundry v13 and v14.
- Reworked the lobby and table creation UI with fully scoped dark-theme styles.
- Added table configuration validation for names, blinds, and buy-in limits.

## 1.0.0

- Initial cash-game No-Limit Texas Hold'em release.
- Added Application V2 lobby and table UI.
- Added active-GM host, encrypted private card delivery, action timer, persistence, recovery, side pots, and Forbidden Lands currency integration.

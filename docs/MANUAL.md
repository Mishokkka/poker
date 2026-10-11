# User Manual

## Opening the lobby

Use the spade tool in the Token scene controls, press `Ctrl+Shift+P`, or run `game.fblPoker.openLobby()` from a macro.

At least one GM must remain connected. The alphabetically first active GM user ID becomes the table host.

## Creating and editing a table

Only a GM can create, edit or delete a table. Configure seats, blinds, ante, buy-in limits, turn time, and the copper value of one chip.

Rules can be edited between hands. Seat count and chip value are locked while any Actor remains seated because changing either would invalidate the layout or existing stacks.

## Joining

Choose an Actor you own, enter a buy-in inside the table limits, then click an empty chair. The module converts the Actor's entire wallet to a canonical copper value, deducts the buy-in, then writes the remaining amount back as gold, silver, and copper.

A GM can also seat a character without enough currency, for either manual or automatic control. Available currency is used and the missing amount is granted by the GM; this does not change table buy-in limits or top-up rules.

A single Actor cannot be seated at multiple module tables.


## NPC poker bots

A GM can add a bot from the same dialog used to occupy an empty seat. Select an NPC Actor, enter the buy-in, and choose Novice, Experienced, or Expert in the seat-controller field. A player seating their own Actor must cover the full buy-in. A GM may seat any character, manually controlled or automated, with the full selected stack even when its wallet is empty or short. The Actor pays the available amount up to the buy-in cost; the GM grants the remainder, recorded as `subsidyCopper`. Cash-out returns the full remaining stack at the table chip value.

Novice bots play loosely and make intentional errors. Experienced bots use equity, pot odds, and position. Expert bots run a larger local equity simulation and vary their sizing and bluffs. Bots act automatically after a short thinking delay. Their hidden cards remain concealed in the table UI until showdown.

Bots do not receive opponent hole cards. They use their own hand, the board, stacks, bets, position, and the public action state. A bot that loses its stack remains seated but cannot enter another hand until the GM buys more chips.

## Playing

The action panel appears only for the user who controls the current seat. A GM may act for any seat, which permits manually controlled NPC opponents.

Bet and raise inputs are total street amounts, not an amount added on top. The range input and quick buttons calculate minimum, one-third-pot, half-pot, three-quarter-pot, pot and maximum legal targets.

When the timer expires, the host checks automatically when checking is legal; otherwise it folds. A GM may pause the hand. Resuming preserves the unused part of the current action timer. Client countdowns use the host clock, with approximate network-delivery accuracy.

Card animations resume at their current progress when the window updates or private cards arrive. The host adds a dealing allowance before the configured action countdown; bots also wait for this allowance before their thinking delay. Players may still act early. The result banner and winner highlight appear after the remaining board animations, and automatic next-hand scheduling includes that presentation allowance. Pausing or resetting finishes the current visual effects without replaying them on resume. Reduced-motion preferences remove visual effects and local result waits; the host allowance remains common to all clients.

## Stack management

Between hands, the seat menu can buy more chips up to the table maximum. The top-up window also limits the purchase by the Actor's available wallet.

Cash-out returns the full remaining stack to the seated Actor and removes the seat. Sit Out keeps the seat while skipping future hands.

During a hand, a player may queue either Sit Out After Hand or Leave After Hand. The queued choice can be cancelled before the hand ends. Deferred cash-out includes any winnings from that hand.

## Hand history

The history control in the window header opens the latest 100 completed hands. Each entry contains the board, public showdown cards, stack changes, awards and public action log. The history can be exported as JSON.

Unshown folded cards and cards from uncontested pots are never added to public history.

## Interrupted sessions

If the host reloads during an active hand, the hand is cancelled. Every seat receives its committed chips back. This is deliberate because the deck and hole cards are never persisted publicly.


## Remote clients

Remote poker traffic uses Foundry VTT v13 targeted user queries. Players may connect through the same local-network HTTP address they normally use for Foundry; HTTPS or localhost is no longer required for poker initialization. Hole cards, session tokens, action requests, and private errors are not placed on the module's broadcast socket.

Players must retain Foundry's normal `QUERY_USER` permission. If that permission is disabled for a role, remote poker requests from that role cannot be delivered to the active GM.
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

## Interrupted money operations (1.7.10)

A buy-in, top-up or payout first saves a pending operation in `moneyJournal`. The wallet write includes a transaction marker. Table persistence follows, then the operation becomes committed. There is no automatic compensating wallet write after an ambiguous error.

If a recovery banner appears:

1. Use Refresh. A matching Actor transaction marker lets the host complete table persistence automatically, without writing the wallet again.
2. If the banner remains, the GM can open the scales button in the table title bar. Verify that the earlier Actor request has finished; reconnect/reload the GM client if necessary. Compare the Actor wallet and its change history with the operation's before/after totals in copper.
3. Choose **Wallet changed** only if that exact operation took effect. Choose **Wallet unchanged** only if it did not. These choices finalize or cancel the table mutation and never write Actor currency. Cancel when the evidence is ambiguous.
4. If no pending money operation exists, the banner reflects a failed ordinary state save. Reload the GM client after storage is available again. As before, an active hand is cancelled and committed bets return to stacks.

The same Actor and table cannot start another money operation while an earlier one is pending. Table deletion pays and durably removes seats one at a time. A retry pays only seats still present. The 500-entry display ledger is supplementary: do not clear the durable journal to bypass recovery.

If private cards cannot be delivered, the table displays a delivery message and stops its turn/bot/next-hand timers. Restore the affected player's connection and query permission, then use Refresh to retry. A GM may reset the active hand. Dealing remains paused until all required deliveries succeed.

The pot shown after completion is the awarded pot of that hand. It stays unchanged when a player leaves; the engine's active pot is zero. Exported new hands include their own chip value and currency rates. Older histories lack this information and are not retroactively assigned today's rates.

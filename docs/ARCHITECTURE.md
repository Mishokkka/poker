# Architecture

## Components

- `engine/`: pure card, evaluation, side-pot, table-state and public hand-history logic
- `economy/`: Forbidden Lands currency adapter
- `network/`: active-GM host, public socket snapshots, and targeted private query transport
- `apps/`: Application V2 lobby, table administration, top-up, history and table UI
- `storage.js`: compact live-table state, cold hand-history archives, and transaction ledger

## Authority

All clients submit requested actions. The active GM validates session, ownership, seat, turn, stack, table state and bet size before mutating the table. Public snapshots identify the active GM that produced them, and clients ignore snapshots from a previous host after authority changes.

Currency operations are serialized through the host queue. Once host retirement begins, new requests are rejected while already accepted operations drain through wallet mutation, table persistence, and response delivery before session state is cleared. Each money operation stores a durable pending intent containing before/after table states, request identity and wallet totals. Currency and an Actor transaction marker are updated in the same Actor write. The resulting table is persisted before the journal entry becomes a compact committed receipt. Interrupted writes are recovered from the marker; ambiguous outcomes block the table and Actor until explicit GM reconciliation. Notification failure never triggers a compensating wallet write.

## Private cards and remote requests

Foundry VTT v13 provides targeted user queries. Poker uses `User.query` for host-provisioned session delivery, player-to-host action requests, private errors, and host-to-player hole-card delivery. The active GM creates the per-user poker token and sends it directly to each active player instead of accepting a user identity supplied by a session requester. The token is then checked on both remote requests and private deliveries. These payloads do not travel on the package-wide broadcast module socket.

Public table updates remain on `module.fbl-poker-table` because every connected client needs the same public state. Normal mutations publish only the changed table plus an optional single-hand history patch; full snapshots are reserved for host startup/recovery and targeted refresh responses. Public messages carry a persisted host epoch and monotonic sequence. Clients verify the real sender ID supplied by Foundry, keep per-table sequence numbers and deletion tombstones, and merge a delayed full response without overwriting newer deltas. Private GM-only automation metadata controls secondary-GM action panels.

Because targeted queries are provided by Foundry itself, private poker transport works over ordinary local-network HTTP URLs and does not depend on the browser exposing `crypto.subtle`. The legacy ECDH helper remains covered by unit tests but is no longer required by the runtime transport.

## Persistence

Persistence is split into a hot live-table setting and a cold hand-history setting. Normal actions rewrite only compact live state such as seats, stacks, board, bets, logs and completed results. The capped latest 100 completed hands are written only when history actually changes. Existing worlds with history embedded in the legacy table setting migrate automatically. Deck order and unrevealed cards remain in host memory. Active hands are rolled back after host reconstruction.

## Deferred seat operations

Sit-out and cash-out requests made during a hand are stored as public seat flags. After the engine reaches `complete`, the host announces the result, applies queued sit-outs, performs queued wallet credits, then publishes the final post-hand snapshot.

## Rules engine

The betting round closes when each actionable seat has acted and matched the current street bet. A full raise resets action and reopens raising. A short all-in raises the amount to call. Each seat records the bet it last faced and the full-raise threshold then in force; cumulative short raises can reopen action once that threshold is reached. The UI and host use the same pure legal-actions function. A lone actionable seat with no outstanding call closes the round immediately, including at the initial blind stage. Preflop action uses the nominal big blind even when its poster is short. Side pots are formed at every unique contribution level. Before awarding any pot, the engine validates that each has an eligible contender. Reset refunds only an active hand.

Commands carry a request ID and expected hand/status/revision. Replays within a host session return their cached outcome; committed financial receipts also survive reconstruction. Commands for an old view are rejected before mutation. Connection changes use Foundry's `userConnected` hook as well as relevant user updates. Private-card delivery completes before the turn timer is started; failures publish a visible delivery barrier.

## Presentation timing

`presentation-timing.js` defines the shared card duration and stagger intervals. The host adds a bounded visual allowance to turn and next-hand deadlines and delays bot thinking until that allowance elapses; this does not delay authoritative engine mutations or persistence. Early actions preserve any unused allowance. Timing remains approximate across clients because snapshots have network and rendering latency.

`TablePresentation` keeps per-card/chip/pot start times independently of Foundry's replaced DOM. Negative CSS delays restore elapsed progress. Card origin vectors are measured from the deck and updated on resize; the deck animation uses a finite iteration count. The result waits for all remaining board cards, including overlapping street updates. Action audio consumes all new log entries, while turn sounds have a separately cancellable queue. Pause/reset/recovery/close cancel stale effects, timers and listeners. No financial or poker-rule state depends on animation completion.

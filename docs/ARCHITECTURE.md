# Architecture

## Components

- `engine/`: pure card, evaluation, side-pot, table-state and public hand-history logic
- `economy/`: Forbidden Lands currency adapter
- `network/`: active-GM host, socket transport, and encrypted private payloads
- `apps/`: Application V2 lobby, table administration, top-up, history and table UI
- `storage.js`: public state and transaction ledger

## Authority

All clients submit requested actions. The active GM validates session, ownership, seat, turn, stack, table state and bet size before mutating the table. Public snapshots identify the active GM that produced them, and clients ignore snapshots from a previous host after authority changes.

Currency operations are serialized through the host queue. Once host retirement begins, new requests are rejected while already accepted operations drain through wallet mutation, table persistence, and response delivery before session state is cleared. If a buy-in or top-up cannot be committed to the table after wallet deduction, the wallet change is rolled back.

## Private cards

Each client creates an ephemeral P-256 ECDH key pair. The host derives a per-client AES-GCM key and broadcasts encrypted private payloads. Session establishment, remote action requests, acknowledgements, errors, and hole cards all travel inside this encrypted envelope. Other clients receive ciphertext but cannot decrypt it through the normal module UI.

The network layer requires `crypto.subtle`. If a browser is opened in a context where Web Crypto is unavailable, such as many plain HTTP deployments, initialization fails closed. There is no readable compatibility transport for hole cards, session tokens, acknowledgements, or private errors.

## Persistence

The world setting stores public state only: seats, stacks, board, bets, logs, completed results and the latest 100 completed hand histories. Deck order and unrevealed cards remain in host memory. Active hands are rolled back after host reconstruction.

## Deferred seat operations

Sit-out and cash-out requests made during a hand are stored as public seat flags. After the engine reaches `complete`, the host announces the result, applies queued sit-outs, performs queued wallet credits, then publishes the final post-hand snapshot.

## Rules engine

The betting round closes when each actionable seat has acted and matched the current street bet. A full raise resets action and reopens raising. A short all-in raises the amount to call but locks previously acted seats from reraising. Side pots are formed at every unique contribution level.

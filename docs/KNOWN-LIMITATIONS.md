# Known Limitations

Version 1.7.6 provides a complete cash-game No-Limit Texas Hold'em loop with table administration, top-ups, automated NPC opponents, sounds, automatic continuation, and public hand history. It does not include:

- tournaments, blind schedules, re-entry, bounties, or table balancing
- Pot-Limit Omaha, draw poker, or limit betting
- statistical HUDs, player notes, or long-term aggregate statistics
- run-it-twice, rabbit hunting, straddles, or bomb pots
- a separate disconnected-player time bank beyond the table action timer
- cryptographic proof of shuffle fairness

The active GM host can inspect hands because it runs the authoritative engine. Foundry's client module environment does not provide a server-side trusted execution boundary.

Private payload encryption requires Web Crypto. Every participating browser must open Foundry through HTTPS or localhost. If the API is unavailable, the module refuses to initialize rather than sending readable private payloads.

If deleting a table cannot return chips to one or more missing or invalid Actors, every seat whose payout succeeds is removed immediately. Seats whose payout fails remain at the retained table, and each failed payout is recorded in the transaction ledger. After repairing or restoring the affected Actors, the GM can retry deletion without paying the already removed seats twice.

Actor wallet updates and poker-table settings are separate Foundry document writes. A storage failure at the exact boundary between them can require transaction-ledger reconciliation by the GM.

The archive is statically checked and its pure engine and host workflows are unit-tested. A runtime smoke test inside the target Foundry installation is still required before important campaign currency is used.

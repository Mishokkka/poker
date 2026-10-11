# Known Limitations

Version 1.7.10 provides a complete cash-game No-Limit Texas Hold'em loop with table administration, top-ups, automated NPC opponents, sounds, automatic continuation, and public hand history. It does not include:

- tournaments, blind schedules, re-entry, bounties, or table balancing
- Pot-Limit Omaha, draw poker, or limit betting
- statistical HUDs, player notes, or long-term aggregate statistics
- run-it-twice, rabbit hunting, straddles, or bomb pots
- a separate disconnected-player time bank beyond the table action timer
- cryptographic proof of shuffle fairness

The active GM host can inspect hands because it runs the authoritative engine. Foundry's client module environment does not provide a server-side trusted execution boundary.

Private poker traffic relies on Foundry VTT v13 targeted user queries. Players whose role has the `QUERY_USER` permission disabled cannot use remote poker actions until that permission is restored. Local-network HTTP access is supported and does not require Web Crypto.

If deleting a table cannot return chips to one or more missing or invalid Actors, every seat whose payout succeeds is removed immediately. Seats whose payout fails remain at the retained table, and each failed payout is recorded in the transaction ledger. After repairing or restoring the affected Actors, the GM can retry deletion without paying the already removed seats twice.

Actor wallet updates and poker-table settings remain separate Foundry writes. The durable journal and Actor marker prevent automatic repeat payouts, but a missing marker after an ambiguous response requires explicit GM reconciliation. Independent wallet editors/modules are not covered by the poker host queue: a pre-write balance check detects changes visible before the Actor write, but it is not a cross-client compare-and-swap lock. Do not treat this as a database transaction across unrelated writers.

Completed financial receipts are retained in the durable journal for replay protection; it currently has no automatic pruning. The separate display ledger retains its latest 500 entries. Protocol version 2 requires all clients to reload after upgrading.

New histories include per-hand conversion settings; missing values in old archives remain unknown. Countdown displays correct local clock skew but do not remove network-delivery latency.

The archive is statically checked and its pure engine and host workflows are unit-tested. A runtime smoke test inside the target Foundry installation is still required before important campaign currency is used.

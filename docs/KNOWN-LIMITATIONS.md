# Known Limitations

Version 1.7.3 provides a complete cash-game No-Limit Texas Hold'em loop with table administration, top-ups, automated NPC opponents, sounds, automatic continuation, and public hand history. It does not include:

- tournaments, blind schedules, re-entry, bounties, or table balancing
- Pot-Limit Omaha, draw poker, or limit betting
- statistical HUDs, player notes, or long-term aggregate statistics
- run-it-twice, rabbit hunting, straddles, or bomb pots
- a separate disconnected-player time bank beyond the table action timer
- cryptographic proof of shuffle fairness

The active GM host can inspect hands because it runs the authoritative engine. Foundry's client module environment does not provide a server-side trusted execution boundary.

Private payload encryption requires Web Crypto. Remote browsers opened through plain HTTP commonly lack that API, so the module falls back to recipient-targeted plain socket payloads instead of refusing the connection. This prevents accidental UI disclosure, not inspection by a hostile client.

If deleting a table cannot return chips to one or more missing or invalid Actors, the table is still cleaned up and the failed payouts are recorded in the transaction ledger. The GM must resolve those payouts manually.

The archive is statically checked and its pure engine and host workflows are unit-tested. A runtime smoke test inside the target Foundry installation is still required before important campaign currency is used.

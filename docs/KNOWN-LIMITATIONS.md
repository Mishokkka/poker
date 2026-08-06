# Known Limitations

Version 1.2.0 provides a complete cash-game Texas Hold'em loop with table administration, top-ups and public hand history. It does not yet include:

- tournaments, blind schedules, re-entry, bounty, or table balancing
- Pot-Limit Omaha, draw poker, or limit betting
- automated poker bots
- statistical HUD, player notes, or long-term aggregate statistics
- bundled sound effects or card/chip movement audio
- run-it-twice, rabbit hunting, straddles, or bomb pots
- a separate disconnected-player time bank beyond the table action timer
- cryptographic proof of shuffle fairness

The GM host can technically inspect hands because it runs the authoritative engine. Foundry's client module environment does not provide a server-side trusted execution boundary.

Private payload encryption requires Web Crypto. Remote browsers opened through plain HTTP commonly lack that API, so version 1.2.0 falls back to recipient-targeted plain socket payloads instead of refusing the connection. This prevents accidental UI disclosure, not inspection by a hostile client.

The archive is statically checked and its pure engine is unit-tested. It still requires a runtime smoke test inside the target Foundry installations before important campaign currency is used.

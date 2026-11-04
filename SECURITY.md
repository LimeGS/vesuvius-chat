# Security

Do not post keys, invitation codes, Discord messages, access files, volume backups
or screenshots containing credentials in public issues. Report sensitive findings
through the repository host's private vulnerability reporting facility when enabled.
If no private reporting channel is available, ask for one without including details.

Keep `.env` files and exported access files private. Removing an invitation from
the persisted access configuration and restarting the app revokes that code.
Never put bearer tokens in URLs or disable TLS verification globally.

Only the HTTPS proxy should be exposed. RAG stays private; MCP is authenticated and
read-only. Quotas are admission controls, not edge DDoS protection. The operator is
responsible for permissions, backups, certificate renewal and provider policies.

Run `npm run check:publication`, tests and `npm audit` before publishing changes.
Do not publish generated bundles, private deployment material, logs or Docker volumes.

# Docker self-hosting

Run your own chat, hybrid Discord RAG, authenticated MCP endpoint and half-hour
refresh without production snapshots, owner-specific repositories or systemd.
Docker Compose v2 and a Linux container engine are required. CPU is the default;
expect several GB of model downloads, substantial index storage and RAM for both
the query service and incremental builder. Initial history collection may take
hours. No fixed minimum RAM or GPU speedup is claimed without hardware measurement.

## Configure and start

```sh
cp docker/.env.example docker/.env
chmod 600 docker/.env
```

Edit `docker/.env` privately:
- `DISCORD_TOKEN`: an official **bot token**, not an account token, app ID or public
  key. Invite your bot with View Channel + Read Message History and enable Message
  Content Intent in the Discord Developer Portal. Use only channels you may index.
- `DISCORD_GUILD_ID`: the server's numeric ID.
- `DISCORD_CHANNEL_IDS`: comma-separated IDs of explicit text/announcement channels
  or individual threads. Forum **parent** IDs are not supported: select thread IDs.
  No all-server discovery occurs, and the bot does not send or modify messages.
- `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`: your own key and exact model ID.
  Chat uses your paid/free model under its provider's terms. MCP retrieval itself
  makes no OpenRouter requests. No automatic model substitution occurs.
- Defaults: `APP_HOST=localhost:8443`, `CHAT_TIME_ZONE=UTC`.

```sh
docker compose --env-file docker/.env up --build -d
```

Open **https://localhost:8443**. Only loopback port 8443 is published; RAG is private.
The generated localhost certificate is self-signed. Export and trust it only for
this local installation (using your OS/browser certificate manager):

```sh
docker compose --env-file docker/.env cp proxy:/tls/tls.crt docker/localhost.crt
docker compose --env-file docker/.env cp app:/state/access.json docker/access.local.json
chmod 600 docker/access.local.json
```

Open `docker/access.local.json` privately for the invitation code. Do not post this
file; it also contains the signing secret. The same invitation is your MCP bearer
token. Use `NODE_EXTRA_CA_CERTS` for Node clients or your client's documented custom
CA mechanism; do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

The app initializes invitation/session secrets and the quota database **once**.
It can start before ingestion completes, but retrieval reports unavailable until
the first complete index is published. Follow metadata-only worker logs:

```sh
docker compose --env-file docker/.env logs --tail=30 refresh
docker compose --env-file docker/.env exec refresh python -c 'from pathlib import Path; print(Path("/data/bundle/refresh-status.json").read_text())'
```

The initial run downloads four pinned public Hugging Face model revisions, keeping
their license/model cards. Subsequent queries load models offline. The worker
collects permitted history, caches embeddings and atomically publishes metadata,
SQLite FTS5 and vector files. Thereafter it refreshes on UTC half-hour boundaries,
without overlap. Processing takes additional time; no-new-message runs still verify
selected channels. A failed build keeps the last complete index. The collector
re-reads the newest 100 known messages for edits; it is **not** full deletion/history
reconciliation, and a snapshot is not proof of everything currently on Discord.

## Optional NVIDIA acceleration

Install the NVIDIA Container Toolkit and a compatible CUDA 12.8 driver, then:

```sh
docker compose --env-file docker/.env -f compose.yaml -f compose.gpu.yaml up --build -d
```

This selects CUDA PyTorch and exposes one GPU to RAG and the refresh worker.
NVIDIA-container execution must be verified on your hardware; Docker Desktop on
macOS does not provide this CUDA path. The CPU configuration requires no GPU.

## Storage, privacy and upgrades

Named volumes retain `access` (credentials/quotas), `raw` (Discord messages), `index`
(published indices/embedding cache), `models`, and `tls`. These are private data, not
image contents. Chat conversations and MCP queries are not written to a database or
content logs. Your connecting agent and chosen OpenRouter provider have their own
retention policies. Restrict host/Docker access: anyone who controls Docker can read
container environments and volumes. Runtime keys are not passed as build arguments.

Use `docker compose --env-file docker/.env down` to stop without deleting volumes.
**Do not use `down -v`** unless deliberately destroying credentials, corpus, quotas
and certificates. Back up volumes privately before updating; failed image builds do
not replace the active index. Old published versions are retained for rollback;
monitor disk usage and prune only versions you have explicitly decided to discard.

Rebuild/recreate after source updates with the same command and volumes. If changing
guild/channel scope, use a **new Compose project name and fresh volumes** so old
messages cannot remain readable accidentally; do not reuse an old scope's raw data.
Removing an invitation from `/state/access.json` and restarting `app` revokes it.
Do not delete quota storage to bypass limits.

## Hosting beyond localhost

Do not publish app/RAG ports. Configure a deliberate public HTTPS hostname and
`APP_HOST` matching its external host/port, bind only the proxy to your intended
interface and supply your own certificate/key at `/tls/tls.crt` and `/tls/tls.key`.
The generated certificate covers localhost only. The proxy replaces forwarding/IP
headers; never bypass it or globally disable the application's HTTPS validation.
Firewall, backups, TLS renewal and abuse controls remain the operator's duty.
See [agent connection examples](mcp.md).

# Connect your agent to Vesuvius RAG

Use your own HTTPS host, for example `https://rag.example/mcp`.
Authentication: your existing invitation code as `Authorization: Bearer <code>`.
It is a secret, reusable credential: keep it in an environment variable, never in
the URL, a public config, a screenshot or a shell command containing the literal.
Removing that invitation revokes MCP access after the operator applies the updated
server configuration. Browser sign-out does not revoke the invitation.

This is read-only retrieval; it does not use the server's OpenRouter key or generate
answers. Your agent supplies its own model. Available tools: `search_discord`,
`corpus_status`, `corpus_info`, `search_messages`, `list_messages`, `get_message`,
`get_thread`. Exact filters and original-message citations remain available.
Search samples cannot establish absence. Continue pagination with its opaque cursor
and identical arguments; a restart/snapshot change can require a fresh listing.

MCP has independent persistent limits: 30 tool calls/IP/minute, 60 globally/minute,
1,000 globally/UTC day and two concurrent calls. Protocol setup does not consume
tool quotas. HTTP 429 includes Retry-After. Chat generation quotas are unchanged.
The tool deadline is 180 seconds; no automatic tool replay after dispatch.

## Claude Code

Set `VESUVIUS_MCP_TOKEN` privately in the environment where Claude Code runs. Add
this entry to `.mcp.json` (merge it with existing servers):

```json
{
  "mcpServers": {
    "vesuvius": {
      "type": "http",
      "url": "https://rag.example/mcp",
      "headers": { "Authorization": "Bearer ${VESUVIUS_MCP_TOKEN}" },
      "timeout": 180000
    }
  }
}
```

Approve the project server when prompted; use `/mcp` to check its connection.

## Codex

In `~/.codex/config.toml`, with `VESUVIUS_MCP_TOKEN` available to Codex:

```toml
[mcp_servers.vesuvius]
url = "https://rag.example/mcp"
bearer_token_env_var = "VESUVIUS_MCP_TOKEN"
tool_timeout_sec = 180
```

## OpenCode V2

Merge this into `opencode.jsonc`; environment references remain literal in the file:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "vesuvius": {
        "type": "remote",
        "url": "https://rag.example/mcp",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:VESUVIUS_MCP_TOKEN}" },
        "timeout": { "execution": 180000 }
      }
    }
  }
}
```

Use `opencode mcp list` or `/mcps` to check connection. No OAuth login is needed.

## Local Docker and GUI clients

Replace the URL with `https://localhost:8443/mcp` and trust the local certificate
as described in [self-hosting](self-hosting.md). Never disable TLS verification
globally. This header-token endpoint does **not** implement OAuth: a GUI connector
that accepts only a URL and browser sign-in may not support it. The configurations
above target Claude Code, Codex and OpenCode, not every hosted Claude/ChatGPT GUI.

Configuration syntax checked against official manuals on 2026-11-03:
[Claude Code](https://code.claude.com/docs/en/mcp),
[Codex](https://developers.openai.com/codex/mcp),
[OpenCode V2](https://opencode.ai/v2/docs/mcp-servers).
Protocol interoperability tests are not end-to-end GUI acceptance tests.

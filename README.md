# @customclaw/composio

Composio Tool Router plugin for OpenClaw. Provides access to 1000+ third-party integrations (Gmail, Sentry, Slack, GitHub, Notion, etc.) via three tools:

- **composio_search_tools** — search for tools by describing what you want to do
- **composio_execute_tool** — execute a tool with auto-injected default arguments
- **composio_manage_connections** — check/initiate OAuth connections with auto-discovery

## Install

```bash
openclaw plugins install @customclaw/composio
```

## Client Setup

### 1. Create a Composio account for the client

Go to [platform.composio.dev](https://platform.composio.dev) and create an account. Copy the API key from Settings.

### 2. Install the plugin

```bash
openclaw plugins install @customclaw/composio
```

### 3. Configure per-client settings

Add to the client's `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "composio": {
        "enabled": true,
        "config": {
          "apiKey": "COMPOSIO_API_KEY_HERE",
          "defaultUserId": "client-companyname-uuid",
          "allowedToolkits": ["gmail", "sentry"]
        }
      }
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `apiKey` | Yes | Client's Composio API key |
| `defaultUserId` | Yes | Unique ID scoping OAuth connections to this client |
| `allowedToolkits` | Recommended | Restrict which integrations are available |
| `blockedTools` | No | Map of toolkit → blocked tool slugs for safety |
| `defaultArgs` | No | Pre-configured args per toolkit (usually auto-discovered) |

### 4. Connect toolkits

The agent will prompt the user to connect each toolkit on first use via `composio_manage_connections`. The user clicks the auth URL to complete OAuth.

### 5. Restart the gateway

```bash
openclaw gateway restart
```

## Updating

```bash
openclaw plugins update @customclaw/composio
openclaw gateway restart
```

Gateway restart is required after updates — plugin code is loaded at startup.

## Architecture

```
Composio API Key (per client)
└── defaultUserId (unique per client)
    ├── Gmail OAuth connection
    ├── Sentry OAuth connection
    └── ...
```

- Each client gets their own Composio account + API key for full isolation
- OAuth connections are scoped to `defaultUserId` — clients can't see each other's data
- Auto-discovery (e.g. Sentry org slug) runs on first connection check and caches results
- Curated tool catalogs ensure the agent sees useful tools first (Composio search returns alphabetically)

## Development

```bash
npm install
npm run build
npm pack  # creates .tgz for local testing
```

Test locally:
```bash
openclaw plugins install ./customclaw-composio-1.0.0.tgz
```

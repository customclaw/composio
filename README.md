# @customclaw/composio

OpenClaw plugin that connects your agent to Gmail, Sentry, and other services through [Composio](https://composio.dev)'s Tool Router.

## Install

```bash
openclaw plugins install @customclaw/composio
```

## Setup

1. Get an API key from [platform.composio.dev/settings](https://platform.composio.dev/settings)

2. Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "composio": {
        "enabled": true,
        "config": {
          "apiKey": "your-api-key",
          "allowedToolkits": ["gmail", "sentry"]
        }
      }
    }
  }
}
```

Or set `COMPOSIO_API_KEY` as an environment variable.

3. Restart the gateway.

## What it does

The plugin gives your agent two tools:

- `composio_execute_tool` — runs a Composio action (e.g. `GMAIL_FETCH_EMAILS`, `SENTRY_LIST_ISSUES`)
- `composio_manage_connections` — checks connection status and generates OAuth links when a toolkit isn't connected yet

The agent handles the rest. Ask it to "check my latest emails" and it will call the right tool, prompt you to connect Gmail if needed, and fetch the results.

## CLI

```bash
openclaw composio list                          # list available toolkits
openclaw composio status                        # check what's connected
openclaw composio connect gmail                 # open OAuth link
openclaw composio disconnect gmail              # remove a connection
openclaw composio search "send email"           # find tool slugs
```

## Config options

| Key | Description |
|-----|-------------|
| `apiKey` | Composio API key (required) |
| `allowedToolkits` | Only allow these toolkits (e.g. `["gmail", "sentry"]`) |
| `blockedToolkits` | Block specific toolkits |

## Updating

```bash
openclaw plugins update @customclaw/composio
openclaw gateway restart
```

## Development

```bash
git clone https://github.com/customclaw/composio.git
cd composio
npm install
npm run build
npm test
```

## Acknowledgments

Based on the Composio plugin from [openclaw-composio](https://github.com/ComposioHQ/openclaw-composio) by ComposioHQ. See [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES).

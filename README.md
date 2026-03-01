# Multi-Account Composio Plugin for OpenClaw

OpenClaw plugin for [Composio](https://composio.dev)'s Tool Router. Unlike the [official plugin](https://github.com/ComposioHQ/openclaw-composio-plugin), this one supports multiple accounts (e.g. connecting several Gmail accounts under different user IDs).

Both plugins use plugin id `composio`, so only run one at a time.

## Install

```bash
openclaw plugins install @customclaw/composio
```

## Setup

1. Get an API key from [platform.composio.dev/settings](https://platform.composio.dev/settings)

2. Run the guided setup:

```bash
openclaw composio setup
```

Or add manually to `~/.openclaw/openclaw.json`:

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

You can also set `COMPOSIO_API_KEY` as an environment variable.

3. Restart the gateway.

## What it does

The plugin gives your agent three tools:

- `composio_search_tools` — finds relevant Composio actions from natural-language queries
- `composio_execute_tool` — runs a Composio action (e.g. `GMAIL_FETCH_EMAILS`, `SENTRY_LIST_ISSUES`)
- `composio_manage_connections` — checks connection status and generates OAuth links for unconnected toolkits

Both `composio_search_tools` and `composio_execute_tool` require a `user_id` so actions are always scoped to a specific user. `composio_execute_tool` also accepts an optional `connected_account_id` when multiple accounts exist for the same toolkit.

## Config options

| Key | Description |
|-----|-------------|
| `apiKey` | Composio API key (required) |
| `allowedToolkits` | Only allow these toolkits (e.g. `["gmail", "sentry"]`) |
| `blockedToolkits` | Block specific toolkits |
| `readOnlyMode` | Blocks destructive actions by token matching (delete/update/create/send/etc.); use `allowedToolSlugs` to override safe exceptions |
| `sessionTags` | Tool Router tags (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) |
| `allowedToolSlugs` | Explicit allowlist of UPPERCASE tool slugs |
| `blockedToolSlugs` | Explicit denylist of UPPERCASE tool slugs |

## CLI

```bash
openclaw composio setup                                 # interactive setup
openclaw composio list --user-id user-123               # list available toolkits
openclaw composio status [toolkit] --user-id user-123   # check connection status
openclaw composio connect gmail --user-id user-123      # open OAuth link
openclaw composio disconnect gmail --user-id user-123   # remove a connection
openclaw composio accounts [toolkit]                    # inspect connected accounts
```

## Updating

```bash
openclaw plugins update composio
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

Set `COMPOSIO_LIVE_TEST=1` and `COMPOSIO_API_KEY` to run live integration tests with `npm run test:live`.

## Acknowledgments

Based on [openclaw-composio](https://github.com/ComposioHQ/openclaw-composio) by ComposioHQ. See [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES).

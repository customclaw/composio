# @customclaw/composio

OpenClaw plugin that connects your agent to Gmail, Sentry, and other services through [Composio](https://composio.dev)'s Tool Router.

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
          "defaultUserId": "my-app-user-123",
          "allowedToolkits": ["gmail", "sentry"]
        }
      }
    }
  }
}
```

You can also set `COMPOSIO_API_KEY` as an environment variable.

3. Restart the gateway.

If you upgraded from an older config shape where keys like `defaultUserId` or `allowedToolkits`
were placed directly under `plugins.entries.composio`, rerun:

```bash
openclaw composio setup
```

Legacy mixed entry-level config keys are now rejected at runtime.

## What it does

The plugin gives your agent three tools:

- `composio_search_tools` — discovers relevant Composio actions from natural-language intent
- `composio_execute_tool` — runs a Composio action (e.g. `GMAIL_FETCH_EMAILS`, `SENTRY_LIST_ISSUES`)
- `composio_manage_connections` — checks connection status and generates OAuth links when a toolkit isn't connected yet

`composio_execute_tool` also accepts optional `user_id` and `connected_account_id` fields for deterministic account selection when multiple accounts exist.

The agent handles the rest. Ask it to "check my latest emails" and it will call the right tool, prompt you to connect Gmail if needed, and fetch the results.

## CLI

```bash
openclaw composio setup                                 # interactive setup for ~/.openclaw/openclaw.json
openclaw composio list --user-id user-123               # list available toolkits for a user scope
openclaw composio status [toolkit] --user-id user-123   # check connection status in a user scope
openclaw composio accounts [toolkit]                    # inspect connected accounts (id/user_id/status)
openclaw composio connect gmail --user-id user-123      # open OAuth link for a specific user scope
openclaw composio disconnect gmail --user-id user-123   # remove a connection in that user scope
openclaw composio search "send email" --user-id user-123
```

## Config options

| Key | Description |
|-----|-------------|
| `apiKey` | Composio API key (required) |
| `defaultUserId` | Default Composio `user_id` scope when `--user-id` is not provided |
| `allowedToolkits` | Only allow these toolkits (e.g. `["gmail", "sentry"]`) |
| `blockedToolkits` | Block specific toolkits |
| `readOnlyMode` | Blocks likely-destructive actions by token matching (delete/update/create/send/etc.); use `allowedToolSlugs` to override safe exceptions |
| `sessionTags` | Optional Tool Router tags (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) |
| `allowedToolSlugs` | Optional explicit allowlist of UPPERCASE tool slugs |
| `blockedToolSlugs` | Explicit denylist of UPPERCASE tool slugs |

## User ID Scope (Important)

Composio connections are scoped by `user_id`. If a toolkit is connected in the dashboard
under one user ID but OpenClaw checks another (for example `default`), status and execution
may look disconnected.

Tips:

- Set `defaultUserId` in plugin config for your app's primary identity.
- Use `--user-id` explicitly when checking status/connect/disconnect.
- Use `openclaw composio accounts <toolkit>` to discover which `user_id` owns active connections.

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

### Live Integration Tests (Optional)

```bash
COMPOSIO_LIVE_TEST=1 \
COMPOSIO_API_KEY=your_key \
npm run test:live
```

Optional env vars for execution/disconnect paths:

- `COMPOSIO_LIVE_USER_ID`
- `COMPOSIO_LIVE_TOOLKIT` (default: `gmail`)
- `COMPOSIO_LIVE_TOOL_SLUG`
- `COMPOSIO_LIVE_TOOL_ARGS` (JSON)
- `COMPOSIO_LIVE_CONNECTED_ACCOUNT_ID`
- `COMPOSIO_LIVE_EXPECT_EXECUTE_SUCCESS=1`
- `COMPOSIO_LIVE_ALLOW_DISCONNECT=1` (destructive, opt-in)

## Acknowledgments

Based on the Composio plugin from [openclaw-composio](https://github.com/ComposioHQ/openclaw-composio) by ComposioHQ. See [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES).

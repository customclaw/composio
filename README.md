# Composio Tool Router Plugin for OpenClaw

Access 1000+ third-party tools through Composio's unified Tool Router interface.

## Features

- **Search Tools**: Find tools by describing what you want to accomplish
- **Execute Tools**: Run any tool with authenticated connections
- **Multi-Execute**: Run up to 50 tools in parallel
- **Connection Management**: Connect to toolkits via OAuth or API keys

## Supported Integrations

Gmail, Slack, GitHub, Notion, Linear, Jira, HubSpot, Salesforce, Google Drive, Asana, Trello, and 1000+ more.

## Install

```bash
openclaw plugins install @customclaw/composio
```

## Configuration

### Option 1: Environment Variable

```bash
export COMPOSIO_API_KEY=your-api-key
```

### Option 2: OpenClaw Config

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "composio": {
        "enabled": true,
        "config": {
          "apiKey": "your-api-key",
          "defaultUserId": "client-companyname-uuid",
          "allowedToolkits": ["gmail", "sentry"]
        }
      }
    }
  }
}
```

Get your API key from [platform.composio.dev/settings](https://platform.composio.dev/settings).

## CLI Commands

```bash
# List available toolkits
openclaw composio list

# Check connection status
openclaw composio status
openclaw composio status github

# Connect to a toolkit (opens auth URL)
openclaw composio connect github
openclaw composio connect gmail

# Disconnect from a toolkit
openclaw composio disconnect github

# Search for tools
openclaw composio search "send email"
openclaw composio search "create issue" --toolkit github
```

## Agent Tools

The plugin provides six tools for agents:

### `composio_search_tools`

Search for tools matching a task description.

```json
{
  "query": "send an email with attachment",
  "toolkits": ["gmail"],
  "limit": 5
}
```

### `composio_execute_tool`

Execute a single tool.

```json
{
  "tool_slug": "GMAIL_SEND_EMAIL",
  "arguments": {
    "to": "user@example.com",
    "subject": "Hello",
    "body": "Message content"
  }
}
```

### `composio_multi_execute`

Execute multiple tools in parallel (up to 50).

```json
{
  "executions": [
    { "tool_slug": "GITHUB_CREATE_ISSUE", "arguments": { "title": "Bug", "repo": "org/repo" } },
    { "tool_slug": "SLACK_SEND_MESSAGE", "arguments": { "channel": "#dev", "text": "Issue created" } }
  ]
}
```

### `composio_manage_connections`

Manage toolkit connections.

```json
{
  "action": "status",
  "toolkits": ["github", "gmail"]
}
```

### `composio_workbench`

Execute Python code in a remote Jupyter sandbox.

### `composio_bash`

Execute bash commands in a remote sandbox.

## Advanced Configuration

```json
{
  "plugins": {
    "entries": {
      "composio": {
        "enabled": true,
        "config": {
          "apiKey": "your-api-key",
          "defaultUserId": "user_123",
          "allowedToolkits": ["github", "gmail", "slack"],
          "blockedToolkits": ["dangerous-toolkit"]
        }
      }
    }
  }
}
```

## Updating

```bash
openclaw plugins update @customclaw/composio
openclaw gateway restart
```

Gateway restart is required after updates.

## Development

```bash
npm install
npm run build
npm pack  # creates .tgz for local testing
openclaw plugins install ./customclaw-composio-0.0.1.tgz
```

## Acknowledgments

This project is based on the Composio plugin from [openclaw-composio](https://github.com/ComposioHQ/openclaw-composio) by ComposioHQ. See [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES) for details.

## Links

- [Composio Documentation](https://docs.composio.dev)
- [Tool Router Overview](https://docs.composio.dev/tool-router/overview)
- [Composio Platform](https://platform.composio.dev)

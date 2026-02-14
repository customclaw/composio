import { Composio } from "@composio/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PluginConfig {
  enabled: boolean;
  apiKey: string;
  defaultUserId: string;
  allowedToolkits?: string[];
  blockedTools: Record<string, string[]>;
  defaultArgs: Record<string, Record<string, unknown>>;
}

function parseConfig(raw: any): PluginConfig {
  const outer = raw && typeof raw === "object" ? raw : {};
  // Config may be nested under a "config" key or at top level
  const cfg = outer.config && typeof outer.config === "object" ? outer.config : outer;
  return {
    enabled: outer.enabled !== false,
    apiKey: cfg.apiKey || process.env.COMPOSIO_API_KEY || "",
    defaultUserId: cfg.defaultUserId || "openclaw-personal",
    allowedToolkits: Array.isArray(cfg.allowedToolkits) ? cfg.allowedToolkits : undefined,
    blockedTools: cfg.blockedTools || {},
    defaultArgs: cfg.defaultArgs || {},
  };
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

interface SessionHandle {
  sessionId: string;
  toolkits: (opts?: any) => Promise<any>;
  authorize: (toolkit: string) => Promise<any>;
}

// Map of toolkit → discovery tool slug + how to extract default args from result
const TOOLKIT_DISCOVERY: Record<string, {
  tool: string;
  args?: Record<string, unknown>;
  extract: (data: any) => Record<string, unknown> | null;
}> = {
  sentry: {
    tool: "SENTRY_GET_ORGANIZATION_DETAILS",
    extract: (data: any) => {
      // Response: { details: [{ slug, name, id, ... }] } or { slug, ... }
      const details = data?.details ?? data;
      const org = Array.isArray(details) ? details[0] : details;
      const slug = org?.slug ?? org?.organization_slug;
      if (slug) return { organization_id_or_slug: slug };
      return null;
    },
  },
};

// Curated common tools per toolkit — prepended to search results so the agent
// always sees useful read/list tools even when the API returns alphabetically.
const CURATED_TOOLS: Record<string, Array<{ slug: string; name: string; description: string }>> = {
  sentry: [
    { slug: "SENTRY_LIST_AN_ORGANIZATIONS_ISSUES", name: "List organization issues", description: "List issues for the org. Supports 'query' param (e.g. 'is:unresolved')." },
    { slug: "SENTRY_GET_ORGANIZATION_ISSUE_DETAILS", name: "Get issue details", description: "Get details for a specific issue. Requires 'issue_id'." },
    { slug: "SENTRY_LIST_AN_ISSUES_EVENTS", name: "List issue events", description: "List events for a specific issue." },
    { slug: "SENTRY_GET_PROJECT_LIST", name: "List projects", description: "List all projects in the organization." },
    { slug: "SENTRY_RETRIEVE_ORGANIZATION_PROJECTS", name: "List projects (detailed)", description: "List projects with full details." },
    { slug: "SENTRY_FETCH_ORGANIZATION_ALERT_RULES", name: "List alert rules", description: "List alert rules for the organization." },
    { slug: "SENTRY_GET_ORGANIZATION_DETAILS", name: "Get org info", description: "Get organization details and settings." },
    { slug: "SENTRY_LIST_ORGANIZATION_MEMBERS", name: "List org members", description: "List members of the organization." },
  ],
  gmail: [
    { slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails", description: "List emails (metadata only). Use 'query' and 'max_results' params." },
    { slug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", name: "Read email", description: "Read full email body. Requires 'message_id' from FETCH_EMAILS." },
    { slug: "GMAIL_GET_PROFILE", name: "Get profile", description: "Get the user's email address and profile info." },
  ],
};

class ComposioClient {
  private composio: Composio;
  private config: PluginConfig;
  private session: SessionHandle | null = null;
  // Runtime cache for auto-discovered default args (supplements config.defaultArgs)
  private discoveredArgs: Record<string, Record<string, unknown>> = {};

  constructor(config: PluginConfig) {
    this.config = config;
    this.composio = new Composio({ apiKey: config.apiKey });
  }

  private async getSession(): Promise<SessionHandle> {
    if (this.session) return this.session;

    const toolsConfig: Record<string, { disable: string[] }> = {};
    for (const [toolkit, disabled] of Object.entries(this.config.blockedTools)) {
      if (disabled.length > 0) {
        toolsConfig[toolkit] = { disable: disabled };
      }
    }

    this.session = (await this.composio.create(this.config.defaultUserId, {
      toolkits: this.config.allowedToolkits || [],
      manageConnections: true,
      ...(Object.keys(toolsConfig).length > 0 ? { tools: toolsConfig } : {}),
      tags: ["readOnlyHint"],
    })) as any;

    return this.session!;
  }

  async checkConnection(toolkit: string): Promise<any> {
    const session = await this.getSession();
    const result = await session.toolkits({ toolkits: [toolkit] });
    const items = result?.items ?? [];

    if (items.length === 0) {
      return { connected: false, toolkit };
    }

    const tk = items[0];
    if (tk.connection?.isActive === true) {
      // Auto-discover default args for this toolkit if we haven't already
      const discovered = await this.discoverDefaults(toolkit);
      return {
        connected: true,
        toolkit,
        ...(discovered ? { discoveredDefaults: discovered } : {}),
      };
    }

    // Not connected — get auth URL
    try {
      const connReq = await session.authorize(toolkit);
      return {
        connected: false,
        toolkit,
        needsAuth: true,
        authUrl: connReq.redirectUrl ?? connReq.url ?? undefined,
      };
    } catch (err: any) {
      return {
        connected: false,
        toolkit,
        needsAuth: true,
        error: `Could not initiate auth: ${err.message}`,
      };
    }
  }

  private async discoverDefaults(toolkit: string): Promise<Record<string, unknown> | null> {
    // Already discovered or configured
    if (this.discoveredArgs[toolkit] || this.config.defaultArgs[toolkit]) {
      return this.discoveredArgs[toolkit] ?? this.config.defaultArgs[toolkit];
    }

    const discovery = TOOLKIT_DISCOVERY[toolkit];
    if (!discovery) return null;

    try {
      const result = await this.composio.tools.execute(discovery.tool, {
        userId: this.config.defaultUserId,
        arguments: discovery.args ?? {},
        dangerouslySkipVersionCheck: true,
      });

      const data = result?.data ?? result;
      const extracted = discovery.extract(data);
      if (extracted) {
        this.discoveredArgs[toolkit] = extracted;
        return extracted;
      }
    } catch {
      // Discovery is best-effort — don't block on failure
    }

    return null;
  }

  async searchTools(query: string, toolkit?: string): Promise<any[]> {
    const toolkits = toolkit
      ? [toolkit]
      : this.config.allowedToolkits || [];
    const tools = await this.composio.tools.getRawComposioTools({
      search: query,
      toolkits,
      limit: 15,
    });

    const items = ((tools as any)?.items ?? tools ?? []) as any[];
    const apiResults = items.map((t: any) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      toolkit: t.toolkit?.slug ?? t.toolkitSlug,
      parameters: t.inputParameters,
    }));

    // Prepend curated common tools so the agent always sees useful read/list tools.
    // Works whether or not a toolkit filter was passed.
    const targetToolkits = toolkit ? [toolkit] : (this.config.allowedToolkits || []);
    const allCurated: any[] = [];
    for (const tk of targetToolkits) {
      if (CURATED_TOOLS[tk]) {
        for (const t of CURATED_TOOLS[tk]) {
          allCurated.push({ ...t, toolkit: tk, curated: true });
        }
      }
    }
    if (allCurated.length > 0) {
      const curatedSlugs = new Set(allCurated.map(t => t.slug));
      const deduped = apiResults.filter((t: any) => !curatedSlugs.has(t.slug));
      return [...allCurated, ...deduped];
    }

    return apiResults;
  }

  async executeTool(toolSlug: string, args: Record<string, unknown>): Promise<any> {
    // Check blocked tools
    const toolkit = toolSlug.split("_")[0]?.toLowerCase();
    const blocked = this.config.blockedTools[toolkit] ?? [];
    if (blocked.includes(toolSlug)) {
      return {
        success: false,
        error: `Action "${toolSlug}" is disabled. Disabled actions for ${toolkit}: ${blocked.join(", ")}`,
      };
    }

    // Merge default args: discovered (runtime) < configured < explicit args
    const discovered = this.discoveredArgs[toolkit] ?? {};
    const configured = this.config.defaultArgs[toolkit] ?? {};
    const mergedArgs = { ...discovered, ...configured, ...args };

    const result = await this.composio.tools.execute(toolSlug, {
      userId: this.config.defaultUserId,
      arguments: mergedArgs,
      dangerouslySkipVersionCheck: true,
    });

    if (result?.error) {
      return { success: false, error: result.error };
    }

    // Normalize Gmail FETCH_EMAILS response
    let data = result?.data ?? result;
    if (toolSlug === "GMAIL_FETCH_EMAILS") {
      const messages =
        (data as any)?.messages ?? (data as any)?.response_data?.messages ?? (data as any)?.data?.messages ?? [];
      const trimmed = Array.isArray(messages)
        ? messages.map(({ messageText, ...rest }: any) => rest)
        : [];
      data = { messages: trimmed };
    }

    return { success: true, data };
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function jsonResponse(obj: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    details: obj,
  };
}

function createSearchTool(client: ComposioClient) {
  return {
    name: "composio_search_tools",
    label: "Composio Search Tools",
    description:
      "Search for tools across 1000+ integrations (Gmail, Slack, GitHub, Notion, etc.) " +
      "by describing what you want to accomplish. Returns matching tools with their parameter schemas.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Task description to find matching tools (e.g., 'send an email', 'fetch unread emails')",
        },
        toolkit: {
          type: "string",
          description: "Filter results to a specific toolkit (e.g., 'gmail', 'sentry', 'slack'). Recommended when the user's request clearly targets one integration.",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const query = String(params.query || "").trim();
      if (!query) return jsonResponse({ error: "query is required" });
      const toolkit = params.toolkit ? String(params.toolkit).trim().toLowerCase() : undefined;

      try {
        const tools = await client.searchTools(query, toolkit);
        return jsonResponse({ version: "v2", query, toolkit: toolkit || "all", count: tools.length, tools });
      } catch (err: any) {
        return jsonResponse({ error: err.message });
      }
    },
  };
}

function createExecuteTool(client: ComposioClient) {
  return {
    name: "composio_execute_tool",
    label: "Composio Execute Tool",
    description:
      "Execute a Composio tool. Use composio_search_tools first to find the tool slug " +
      "and parameter schema. The toolkit must be connected (use composio_manage_connections to check).",
    parameters: {
      type: "object",
      properties: {
        tool_slug: {
          type: "string",
          description: "Tool slug from composio_search_tools results (e.g., 'GMAIL_FETCH_EMAILS')",
        },
        arguments: {
          type: "object",
          description: "Tool arguments matching the tool's parameter schema",
        },
      },
      required: ["tool_slug"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const toolSlug = String(params.tool_slug || "").trim();
      if (!toolSlug) return jsonResponse({ error: "tool_slug is required" });

      const args =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};

      try {
        const result = await client.executeTool(toolSlug, args);
        return jsonResponse({ tool_slug: toolSlug, ...result });
      } catch (err: any) {
        return jsonResponse({ tool_slug: toolSlug, success: false, error: err.message });
      }
    },
  };
}

function createConnectionsTool(client: ComposioClient) {
  return {
    name: "composio_manage_connections",
    label: "Composio Manage Connections",
    description:
      "Check if a Composio toolkit is connected and get an auth URL if not. " +
      "Use this before executing tools to ensure the user has authorized the toolkit.",
    parameters: {
      type: "object",
      properties: {
        toolkit: {
          type: "string",
          description: "Toolkit name to check (e.g., 'gmail', 'github', 'slack')",
        },
      },
      required: ["toolkit"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const toolkit = String(params.toolkit || "").trim().toLowerCase();
      if (!toolkit) return jsonResponse({ error: "toolkit is required" });

      try {
        const status = await client.checkConnection(toolkit);
        return jsonResponse(status);
      } catch (err: any) {
        return jsonResponse({ toolkit, error: err.message });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

const composioPlugin = {
  id: "composio",
  name: "Composio Tool Router",
  description: "Access 1000+ third-party tools via Composio (Gmail, Slack, GitHub, etc.)",

  register(api: any) {
    const config = parseConfig(api.pluginConfig);

    if (!config.enabled) {
      api.logger.debug?.("[composio] Plugin disabled in config");
      return;
    }

    if (!config.apiKey) {
      api.logger.warn(
        "[composio] No API key configured. Set apiKey in plugins.composio config or COMPOSIO_API_KEY env var.",
      );
      return;
    }

    const client = new ComposioClient(config);

    api.registerTool(createSearchTool(client));
    api.registerTool(createExecuteTool(client));
    api.registerTool(createConnectionsTool(client));

    // Inject agent instructions
    api.on("before_agent_start", () => {
      return {
        prependContext: `<composio-tools>
You have access to Composio Tool Router, which provides 1000+ third-party integrations (Gmail, Slack, GitHub, Notion, etc.).

## How to use Composio tools

1. **Check connections first**: Use \`composio_manage_connections\` with the toolkit name to verify it's connected. If not connected, share the authUrl with the user and ask them to open it. When connected, the response may include \`discoveredDefaults\` — these are auto-injected into all tool executions for that toolkit, so you do NOT need to ask the user for them.

2. **Search for tools**: Use \`composio_search_tools\` to find tools matching the user's task. Search by describing what you want to do (e.g., "fetch unread emails", "create github issue"). **Always set the \`toolkit\` parameter** when the user's request targets a specific integration (e.g., toolkit="sentry" for Sentry issues, toolkit="gmail" for email).

3. **Execute tools**: Use \`composio_execute_tool\` with the tool_slug from search results and arguments matching the tool's schema.

## Available toolkits
${(config.allowedToolkits || []).map((t: string) => "- " + t).join("\n") || "- (none configured)"}

## Default arguments
Some toolkits have pre-configured default arguments that are automatically injected when executing tools. You do NOT need to ask the user for these values — they are filled in automatically. Just omit them from your arguments.
${Object.keys(config.defaultArgs).length > 0 ? Object.entries(config.defaultArgs).map(([tk, args]: [string, any]) => "- **" + tk + "**: " + Object.keys(args).join(", ") + " (auto-injected)").join("\n") : "- (none configured)"}

## Common tool slugs (use these directly — no search needed)

### Gmail
- GMAIL_FETCH_EMAILS — list emails (returns metadata only: subject, sender, date, snippet)
- GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID — read full email body (use message_id from FETCH_EMAILS)
- GMAIL_GET_PROFILE — get email address and profile info

### Sentry
- SENTRY_LIST_AN_ORGANIZATIONS_ISSUES — list issues (supports \`query\` param, e.g. "is:unresolved")
- SENTRY_GET_ORGANIZATION_ISSUE_DETAILS — get details for a specific issue (needs \`issue_id\`)
- SENTRY_LIST_AN_ISSUES_EVENTS — list events for a specific issue
- SENTRY_GET_PROJECT_LIST — list projects in the org
- SENTRY_RETRIEVE_ORGANIZATION_PROJECTS — list projects with details
- SENTRY_FETCH_ORGANIZATION_ALERT_RULES — list alert rules
- SENTRY_GET_ORGANIZATION_DETAILS — get org info
- SENTRY_LIST_ORGANIZATION_MEMBERS — list org members

Use \`composio_search_tools\` only when you need a tool not listed above.

## Important notes
- Tool slugs are uppercase — use exact slugs from the list above or from search results
- Do NOT invent tool slugs; if unsure, search first
- When searching, always set the \`toolkit\` parameter to the relevant toolkit name
- Default arguments (like organization_id_or_slug) are auto-injected — do NOT ask the user for them
- If a tool fails with auth errors, prompt the user to connect the toolkit
</composio-tools>`,
      };
    });

    api.logger.info("[composio] Plugin v2 registered with 3 tools (curated catalog enabled)");
  },
};

export default composioPlugin;

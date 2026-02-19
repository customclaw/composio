import { Composio } from "@composio/core";
import type { ToolRouterCreateSessionConfig } from "@composio/core";
import type {
  ComposioConfig,
  ComposioSessionTag,
  ToolSearchResult,
  ToolExecutionResult,
  ConnectionStatus,
  ConnectedAccountSummary,
} from "./types.js";
import {
  normalizeSessionTags,
  normalizeToolkitList,
  normalizeToolkitSlug,
  normalizeToolSlug,
  normalizeToolSlugList,
} from "./utils.js";

type ToolRouterSession = Awaited<ReturnType<Composio["create"]>>;
type SessionConnectedAccountsOverride = Record<string, string>;
type ConnectedAccountStatusFilter =
  | "INITIALIZING"
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED"
  | "INACTIVE";

// Heuristic only: token matching may block some benign tools.
// Use `allowedToolSlugs` to explicitly override specific slugs.
const DESTRUCTIVE_TOOL_VERBS = new Set([
  "CREATE",
  "DELETE",
  "DESTROY",
  "DISABLE",
  "DISCONNECT",
  "ERASE",
  "MODIFY",
  "PATCH",
  "POST",
  "PUT",
  "REMOVE",
  "RENAME",
  "REPLACE",
  "REVOKE",
  "SEND",
  "SET",
  "TRUNCATE",
  "UNSUBSCRIBE",
  "UPDATE",
  "UPSERT",
  "WRITE",
]);

function isConnectedAccountStatusFilter(value: string): value is ConnectedAccountStatusFilter {
  return [
    "INITIALIZING",
    "INITIATED",
    "ACTIVE",
    "FAILED",
    "EXPIRED",
    "INACTIVE",
  ].includes(value);
}

/**
 * Composio client wrapper using Tool Router pattern
 */
export class ComposioClient {
  private client: Composio;
  private config: ComposioConfig;
  private sessionCache: Map<string, ToolRouterSession> = new Map();

  constructor(config: ComposioConfig) {
    if (!config.apiKey) {
      throw new Error(
        "Composio API key required. Set COMPOSIO_API_KEY env var or plugins.composio.apiKey in config."
      );
    }
    this.config = {
      ...config,
      allowedToolkits: normalizeToolkitList(config.allowedToolkits),
      blockedToolkits: normalizeToolkitList(config.blockedToolkits),
      sessionTags: normalizeSessionTags(config.sessionTags),
      allowedToolSlugs: normalizeToolSlugList(config.allowedToolSlugs),
      blockedToolSlugs: normalizeToolSlugList(config.blockedToolSlugs),
      readOnlyMode: Boolean(config.readOnlyMode),
    };
    this.client = new Composio({ apiKey: config.apiKey });
  }

  /**
   * Get the user ID to use for API calls
   */
  private getUserId(overrideUserId?: string): string {
    return overrideUserId || this.config.defaultUserId || "default";
  }

  /**
   * Get or create a Tool Router session for a user
   */
  private makeSessionCacheKey(userId: string, connectedAccounts?: SessionConnectedAccountsOverride): string {
    if (!connectedAccounts || Object.keys(connectedAccounts).length === 0) {
      return `uid:${userId}`;
    }
    const normalized = Object.entries(connectedAccounts)
      .map(([toolkit, accountId]) => `${normalizeToolkitSlug(toolkit)}=${accountId}`)
      .sort()
      .join(",");
    return `uid:${userId}::ca:${normalized}`;
  }

  private normalizeConnectedAccountsOverride(
    connectedAccounts?: SessionConnectedAccountsOverride
  ): SessionConnectedAccountsOverride | undefined {
    if (!connectedAccounts) return undefined;
    const normalized = Object.entries(connectedAccounts)
      .map(([toolkit, accountId]) => [normalizeToolkitSlug(toolkit), String(accountId || "").trim()] as const)
      .filter(([toolkit, accountId]) => toolkit.length > 0 && accountId.length > 0);
    if (normalized.length === 0) return undefined;
    return Object.fromEntries(normalized);
  }

  private buildToolRouterBlockedToolsConfig():
    | NonNullable<ToolRouterCreateSessionConfig["tools"]>
    | undefined {
    const blocked = this.config.blockedToolSlugs;
    if (!blocked || blocked.length === 0) return undefined;

    const byToolkit = new Map<string, Set<string>>();
    for (const slug of blocked) {
      const normalizedSlug = normalizeToolSlug(slug);
      const toolkit = normalizeToolkitSlug(normalizedSlug.split("_")[0] || "");
      if (!toolkit) continue;
      if (!this.isToolkitAllowed(toolkit)) continue;
      if (!byToolkit.has(toolkit)) byToolkit.set(toolkit, new Set());
      byToolkit.get(toolkit)!.add(normalizedSlug);
    }

    if (byToolkit.size === 0) return undefined;
    const tools: Record<string, { disable: string[] }> = {};
    for (const [toolkit, slugs] of byToolkit.entries()) {
      tools[toolkit] = { disable: Array.from(slugs) };
    }
    return tools as NonNullable<ToolRouterCreateSessionConfig["tools"]>;
  }

  private buildSessionConfig(
    connectedAccounts?: SessionConnectedAccountsOverride
  ): ToolRouterCreateSessionConfig | undefined {
    const sessionConfig: ToolRouterCreateSessionConfig = {};

    const normalizedConnectedAccounts = this.normalizeConnectedAccountsOverride(connectedAccounts);
    if (normalizedConnectedAccounts) {
      sessionConfig.connectedAccounts = normalizedConnectedAccounts;
    }

    if (this.config.allowedToolkits && this.config.allowedToolkits.length > 0) {
      sessionConfig.toolkits = { enable: this.config.allowedToolkits };
    } else if (this.config.blockedToolkits && this.config.blockedToolkits.length > 0) {
      sessionConfig.toolkits = { disable: this.config.blockedToolkits };
    }

    const tags = new Set<ComposioSessionTag>(this.config.sessionTags || []);
    if (this.config.readOnlyMode) tags.add("readOnlyHint");
    if (tags.size > 0) {
      sessionConfig.tags = Array.from(tags) as NonNullable<ToolRouterCreateSessionConfig["tags"]>;
    }

    const blockedToolsConfig = this.buildToolRouterBlockedToolsConfig();
    if (blockedToolsConfig) {
      sessionConfig.tools = blockedToolsConfig;
    }

    return Object.keys(sessionConfig).length > 0 ? sessionConfig : undefined;
  }

  private async getSession(
    userId: string,
    connectedAccounts?: SessionConnectedAccountsOverride
  ): Promise<ToolRouterSession> {
    const normalizedConnectedAccounts = this.normalizeConnectedAccountsOverride(connectedAccounts);
    const key = this.makeSessionCacheKey(userId, normalizedConnectedAccounts);
    if (this.sessionCache.has(key)) {
      return this.sessionCache.get(key)!;
    }
    const sessionConfig = this.buildSessionConfig(normalizedConnectedAccounts);
    let session: ToolRouterSession;
    try {
      session = await this.client.toolRouter.create(userId, sessionConfig);
    } catch (err) {
      if (!this.shouldRetrySessionWithoutToolkitFilters(err, sessionConfig)) {
        throw err;
      }

      const { toolkits: _removedToolkits, ...retryWithoutToolkits } = sessionConfig ?? {};
      const retryConfig = Object.keys(retryWithoutToolkits).length > 0
        ? (retryWithoutToolkits as ToolRouterCreateSessionConfig)
        : undefined;
      session = await this.client.toolRouter.create(userId, retryConfig);
    }

    this.sessionCache.set(key, session);
    return session;
  }

  private shouldRetrySessionWithoutToolkitFilters(
    err: unknown,
    sessionConfig?: ToolRouterCreateSessionConfig
  ): boolean {
    const enabledToolkits = (sessionConfig?.toolkits as { enable?: unknown } | undefined)?.enable;
    if (!Array.isArray(enabledToolkits) || enabledToolkits.length === 0) {
      return false;
    }
    const message = String(err instanceof Error ? err.message : err || "").toLowerCase();
    return (
      message.includes("require auth configs but none exist") &&
      message.includes("please specify them in auth_configs")
    );
  }

  private clearUserSessionCache(userId: string) {
    const prefix = `uid:${userId}`;
    for (const key of this.sessionCache.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.sessionCache.delete(key);
    }
  }

  /**
   * Check if a toolkit is allowed based on config
   */
  private isToolkitAllowed(toolkit: string): boolean {
    const normalizedToolkit = normalizeToolkitSlug(toolkit);
    if (!normalizedToolkit) return false;
    const { allowedToolkits, blockedToolkits } = this.config;

    if (blockedToolkits?.includes(normalizedToolkit)) {
      return false;
    }

    if (allowedToolkits && allowedToolkits.length > 0) {
      return allowedToolkits.includes(normalizedToolkit);
    }

    return true;
  }

  private isLikelyDestructiveToolSlug(toolSlug: string): boolean {
    const tokens = normalizeToolSlug(toolSlug)
      .split("_")
      .filter(Boolean);
    return tokens.some((token) => DESTRUCTIVE_TOOL_VERBS.has(token));
  }

  private getToolSlugRestrictionError(toolSlug: string): string | undefined {
    const normalizedToolSlug = normalizeToolSlug(toolSlug);
    if (!normalizedToolSlug) return "tool_slug is required";
    const isExplicitlyAllowed = this.config.allowedToolSlugs?.includes(normalizedToolSlug) ?? false;

    if (this.config.allowedToolSlugs && this.config.allowedToolSlugs.length > 0) {
      if (!isExplicitlyAllowed) {
        return `Tool '${normalizedToolSlug}' is not in allowedToolSlugs`;
      }
    }

    if (this.config.blockedToolSlugs?.includes(normalizedToolSlug)) {
      return `Tool '${normalizedToolSlug}' is blocked by plugin configuration`;
    }

    if (this.config.readOnlyMode && !isExplicitlyAllowed && this.isLikelyDestructiveToolSlug(normalizedToolSlug)) {
      return (
        `Tool '${normalizedToolSlug}' was blocked by readOnlyMode because it appears to modify data. ` +
        "Disable readOnlyMode or add this slug to allowedToolSlugs if execution is intentional."
      );
    }

    return undefined;
  }

  /**
   * Execute a Tool Router meta-tool
   */
  private async executeMetaTool(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ data?: Record<string, unknown>; successful: boolean; error?: string }> {
    const response = await this.client.tools.executeMetaTool(toolName, {
      sessionId,
      arguments: args,
    });
    return {
      successful: Boolean(response.successful),
      data: response.data as Record<string, unknown> | undefined,
      error: response.error ?? undefined,
    };
  }

  /**
   * Search for tools matching a query using COMPOSIO_SEARCH_TOOLS
   */
  async searchTools(
    query: string,
    options?: {
      toolkits?: string[];
      limit?: number;
      userId?: string;
    }
  ): Promise<ToolSearchResult[]> {
    const userId = this.getUserId(options?.userId);
    const session = await this.getSession(userId);
    const requestedToolkits = normalizeToolkitList(options?.toolkits);

    try {
      const response = await this.executeMetaTool(session.sessionId, "COMPOSIO_SEARCH_TOOLS", {
        queries: [{ use_case: query }],
      });

      if (!response.successful || !response.data) {
        throw new Error(response.error || "Search failed");
      }

      const data = response.data;
      const searchResults = (data.results as Array<{
        primary_tool_slugs?: string[];
        related_tool_slugs?: string[];
      }>) || [];

      const toolSchemas = (data.tool_schemas as Record<string, {
        toolkit?: string;
        description?: string;
        input_schema?: Record<string, unknown>;
      }>) || {};

      const results: ToolSearchResult[] = [];
      const seenSlugs = new Set<string>();

      for (const result of searchResults) {
        const allSlugs = [
          ...(result.primary_tool_slugs || []),
          ...(result.related_tool_slugs || []),
        ];

        for (const slug of allSlugs) {
          if (seenSlugs.has(slug)) continue;
          seenSlugs.add(slug);

          const schema = toolSchemas[slug];
          const toolkit = normalizeToolkitSlug(schema?.toolkit || slug.split("_")[0] || "");

          if (!this.isToolkitAllowed(toolkit)) continue;

          if (requestedToolkits && requestedToolkits.length > 0) {
            if (!requestedToolkits.includes(toolkit)) {
              continue;
            }
          }

          results.push({
            name: slug,
            slug: slug,
            description: schema?.description || "",
            toolkit: toolkit,
            parameters: schema?.input_schema || {},
          });

          if (options?.limit && results.length >= options.limit) break;
        }

        if (options?.limit && results.length >= options.limit) break;
      }

      return results;
    } catch (err) {
      throw new Error(
        `Failed to search tools: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Execute a single tool using COMPOSIO_MULTI_EXECUTE_TOOL
   */
  async executeTool(
    toolSlug: string,
    args: Record<string, unknown>,
    userId?: string,
    connectedAccountId?: string
  ): Promise<ToolExecutionResult> {
    const uid = this.getUserId(userId);
    const normalizedToolSlug = normalizeToolSlug(toolSlug);
    const toolRestrictionError = this.getToolSlugRestrictionError(normalizedToolSlug);
    if (toolRestrictionError) {
      return { success: false, error: toolRestrictionError };
    }

    const toolkit = normalizeToolkitSlug(normalizedToolSlug.split("_")[0] || "");
    if (!this.isToolkitAllowed(toolkit)) {
      return {
        success: false,
        error: `Toolkit '${toolkit}' is not allowed by plugin configuration`,
      };
    }

    const accountResolution = await this.resolveConnectedAccountForExecution({
      toolkit,
      userId: uid,
      connectedAccountId,
    });
    if ("error" in accountResolution) {
      return { success: false, error: accountResolution.error };
    }

    const session = await this.getSession(
      uid,
      accountResolution.connectedAccountId
        ? { [toolkit]: accountResolution.connectedAccountId }
        : undefined
    );

    try {
      const response = await this.executeMetaTool(session.sessionId, "COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: normalizedToolSlug, arguments: args }],
        sync_response_to_workbench: false,
      });

      if (!response.successful) {
        const recovered = await this.tryExecutionRecovery({
          uid,
          toolSlug: normalizedToolSlug,
          args,
          connectedAccountId: accountResolution.connectedAccountId,
          metaError: response.error,
          metaData: response.data,
        });
        if (recovered) return recovered;
        return { success: false, error: response.error || "Execution failed" };
      }

      const results = (response.data?.results as Array<{
        tool_slug: string;
        index: number;
        response: {
          successful: boolean;
          data?: unknown;
          error?: string | null;
        };
      }>) || [];

      const result = results[0];
      if (!result) {
        return { success: false, error: "No result returned" };
      }

      // Response data is nested under result.response
      const toolResponse = result.response;
      if (!toolResponse.successful) {
        const recovered = await this.tryExecutionRecovery({
          uid,
          toolSlug: normalizedToolSlug,
          args,
          connectedAccountId: accountResolution.connectedAccountId,
          metaError: toolResponse.error ?? undefined,
          metaData: response.data,
        });
        if (recovered) return recovered;
      }

      return {
        success: toolResponse.successful,
        data: toolResponse.data,
        error: toolResponse.error ?? undefined,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async tryExecutionRecovery(params: {
    uid: string;
    toolSlug: string;
    args: Record<string, unknown>;
    connectedAccountId?: string;
    metaError?: string;
    metaData?: Record<string, unknown>;
  }): Promise<ToolExecutionResult | null> {
    const directFallback = await this.tryDirectExecutionFallback(params);
    if (directFallback?.success) return directFallback;

    const hintedRetry = await this.tryHintedIdentifierRetry({
      ...params,
      additionalError: directFallback?.error,
    });
    if (hintedRetry) return hintedRetry;

    return directFallback;
  }

  private async tryDirectExecutionFallback(params: {
    uid: string;
    toolSlug: string;
    args: Record<string, unknown>;
    connectedAccountId?: string;
    metaError?: string;
    metaData?: Record<string, unknown>;
  }): Promise<ToolExecutionResult | null> {
    if (!this.shouldFallbackToDirectExecution(params.uid, params.metaError, params.metaData)) {
      return null;
    }

    return this.executeDirectTool(
      params.toolSlug,
      params.uid,
      params.args,
      params.connectedAccountId
    );
  }

  private async executeDirectTool(
    toolSlug: string,
    userId: string,
    args: Record<string, unknown>,
    connectedAccountId?: string
  ): Promise<ToolExecutionResult> {
    try {
      const response = await this.client.tools.execute(toolSlug, {
        userId,
        connectedAccountId,
        arguments: args,
        dangerouslySkipVersionCheck: true,
      });

      return {
        success: Boolean(response?.successful),
        data: response?.data,
        error: response?.error ?? undefined,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async tryHintedIdentifierRetry(params: {
    uid: string;
    toolSlug: string;
    args: Record<string, unknown>;
    connectedAccountId?: string;
    metaError?: string;
    metaData?: Record<string, unknown>;
    additionalError?: string;
  }): Promise<ToolExecutionResult | null> {
    const combined = this.buildCombinedErrorText(params.metaError, params.metaData, params.additionalError);
    if (!this.shouldRetryFromServerHint(combined)) return null;

    const hint = this.extractServerHintLiteral(combined);
    if (!hint) return null;

    const retryArgs = this.buildRetryArgsFromHint(params.args, combined, hint);
    if (!retryArgs) return null;

    return this.executeDirectTool(
      params.toolSlug,
      params.uid,
      retryArgs,
      params.connectedAccountId
    );
  }

  private shouldFallbackToDirectExecution(
    uid: string,
    metaError?: string,
    metaData?: Record<string, unknown>
  ): boolean {
    if (uid === "default") return false;
    const combined = this.buildCombinedErrorText(metaError, metaData).toLowerCase();
    return combined.includes("no connected account found for entity id default");
  }

  private shouldRetryFromServerHint(errorText: string): boolean {
    const lower = errorText.toLowerCase();
    return (
      lower.includes("only allowed to access") ||
      lower.includes("allowed to access the")
    );
  }

  private extractServerHintLiteral(errorText: string): string | undefined {
    const matches = errorText.match(/`([^`]+)`/);
    if (!matches?.[1]) return undefined;
    const literal = matches[1].trim();
    if (!literal) return undefined;
    if (literal.length > 64) return undefined;
    if (/\s/.test(literal)) return undefined;
    return literal;
  }

  private buildRetryArgsFromHint(
    args: Record<string, unknown>,
    errorText: string,
    hint: string
  ): Record<string, unknown> | null {
    const stringEntries = Object.entries(args).filter(
      ([, value]) => typeof value === "string"
    ) as Array<[string, string]>;

    if (stringEntries.length === 1) {
      const [field, current] = stringEntries[0];
      if (current === hint) return null;
      return { ...args, [field]: hint };
    }

    if (stringEntries.length === 0) {
      const missing = this.extractSingleMissingField(errorText);
      if (!missing) return null;
      return { ...args, [missing]: hint };
    }

    return null;
  }

  private extractSingleMissingField(errorText: string): string | undefined {
    const match = errorText.match(/following fields are missing:\s*\{([^}]+)\}/i);
    const raw = match?.[1];
    if (!raw) return undefined;

    const fields = raw
      .split(",")
      .map(part => part.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);

    return fields.length === 1 ? fields[0] : undefined;
  }

  private buildCombinedErrorText(
    metaError?: string,
    metaData?: Record<string, unknown>,
    additionalError?: string
  ): string {
    return [metaError, this.extractNestedMetaError(metaData), additionalError]
      .map(v => String(v || "").trim())
      .filter(Boolean)
      .join("\n");
  }

  private extractNestedMetaError(metaData?: Record<string, unknown>): string {
    const results = (metaData?.results as Array<{ error?: string }> | undefined) || [];
    const first = results[0];
    return String(first?.error || "");
  }

  private async resolveConnectedAccountForExecution(params: {
    toolkit: string;
    userId: string;
    connectedAccountId?: string;
  }): Promise<{ connectedAccountId?: string } | { error: string }> {
    const toolkit = normalizeToolkitSlug(params.toolkit);
    const { userId } = params;
    const explicitId = params.connectedAccountId?.trim();

    if (explicitId) {
      try {
        const account = await this.client.connectedAccounts.get(explicitId) as {
          status?: string;
          toolkit?: { slug?: string };
        };
        const accountToolkit = normalizeToolkitSlug(String(account?.toolkit?.slug || ""));
        const accountStatus = String(account?.status || "").toUpperCase();

        if (accountToolkit && accountToolkit !== toolkit) {
          return {
            error: `Connected account '${explicitId}' belongs to toolkit '${accountToolkit}', but tool '${toolkit}' was requested.`,
          };
        }
        if (accountStatus && accountStatus !== "ACTIVE") {
          return {
            error: `Connected account '${explicitId}' is '${accountStatus}', not ACTIVE.`,
          };
        }
        return { connectedAccountId: explicitId };
      } catch (err) {
        return {
          error: `Invalid connected_account_id '${explicitId}': ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const activeAccounts = await this.listConnectedAccounts({
      toolkits: [toolkit],
      userIds: [userId],
      statuses: ["ACTIVE"],
    });

    if (activeAccounts.length <= 1) {
      return { connectedAccountId: activeAccounts[0]?.id };
    }

    const ids = activeAccounts.map(a => a.id).join(", ");
    return {
      error:
        `Multiple ACTIVE '${toolkit}' accounts found for user_id '${userId}': ${ids}. ` +
        "Please provide connected_account_id to choose one explicitly.",
    };
  }

  /**
   * Get connection status for toolkits using session.toolkits()
   */
  async getConnectionStatus(
    toolkits?: string[],
    userId?: string
  ): Promise<ConnectionStatus[]> {
    const uid = this.getUserId(userId);
    const session = await this.getSession(uid);

    try {
      const normalizedToolkits = normalizeToolkitList(toolkits);
      if (normalizedToolkits && normalizedToolkits.length > 0) {
        const requestedToolkits = normalizedToolkits.filter((t) => this.isToolkitAllowed(t));
        if (requestedToolkits.length === 0) return [];
        const toolkitStateMap = await this.getToolkitStateMap(session, requestedToolkits);
        const activeAccountToolkits = await this.getActiveConnectedAccountToolkits(uid, requestedToolkits);

        return requestedToolkits.map((toolkit) => {
          const key = normalizeToolkitSlug(toolkit);
          return {
            toolkit,
            connected: (toolkitStateMap.get(key) ?? false) || activeAccountToolkits.has(key),
            userId: uid,
          };
        });
      }

      const toolkitStateMap = await this.getToolkitStateMap(session);
      const activeAccountToolkits = await this.getActiveConnectedAccountToolkits(uid);
      const connected = new Set<string>();

      for (const [slug, isActive] of toolkitStateMap.entries()) {
        if (!isActive) continue;
        if (!this.isToolkitAllowed(slug)) continue;
        connected.add(slug);
      }
      for (const slug of activeAccountToolkits) {
        if (!this.isToolkitAllowed(slug)) continue;
        connected.add(slug);
      }

      return Array.from(connected).map((toolkit) => ({
        toolkit,
        connected: true,
        userId: uid,
      }));
    } catch (err) {
      throw new Error(
        `Failed to get connection status: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async getToolkitStateMap(
    session: ToolRouterSession,
    toolkits?: string[]
  ): Promise<Map<string, boolean>> {
    const map = new Map<string, boolean>();
    let nextCursor: string | undefined;
    const seenCursors = new Set<string>();

    do {
      const response = await session.toolkits({
        nextCursor,
        limit: 100,
        ...(toolkits && toolkits.length > 0 ? { toolkits } : { isConnected: true }),
      });

      const items = response.items || [];
      for (const tk of items) {
        const key = normalizeToolkitSlug(tk.slug);
        const isActive = tk.connection?.isActive ?? false;
        map.set(key, (map.get(key) ?? false) || isActive);
      }

      nextCursor = response.nextCursor;
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
    } while (true);

    return map;
  }

  private async getActiveConnectedAccountToolkits(
    userId: string,
    toolkits?: string[]
  ): Promise<Set<string>> {
    const connected = new Set<string>();
    const normalizedToolkits = normalizeToolkitList(toolkits);
    let cursor: string | null | undefined;
    const seenCursors = new Set<string>();

    try {
      do {
        const response = await this.client.connectedAccounts.list({
          userIds: [userId],
          statuses: ["ACTIVE"],
          ...(normalizedToolkits && normalizedToolkits.length > 0 ? { toolkitSlugs: normalizedToolkits } : {}),
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });

        const items = (
          Array.isArray(response)
            ? response
            : (response as { items?: unknown[] })?.items || []
        ) as Array<{ toolkit?: { slug?: string }; status?: string }>;

        for (const item of items) {
          const slug = normalizeToolkitSlug(item.toolkit?.slug || "");
          if (!slug) continue;
          if (item.status && String(item.status).toUpperCase() !== "ACTIVE") continue;
          connected.add(slug);
        }

        cursor = Array.isArray(response)
          ? null
          : ((response as { nextCursor?: string | null })?.nextCursor ?? null);
        if (!cursor) break;
        if (seenCursors.has(cursor)) break;
        seenCursors.add(cursor);
      } while (true);

      return connected;
    } catch {
      // Best-effort fallback: preserve status checks based on session.toolkits only.
      return connected;
    }
  }

  private normalizeStatuses(statuses?: string[]): ConnectedAccountStatusFilter[] | undefined {
    if (!statuses || statuses.length === 0) return undefined;
    const normalized = statuses
      .map(s => String(s || "").trim().toUpperCase())
      .filter(isConnectedAccountStatusFilter);
    return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
  }

  /**
   * List connected accounts with optional filters.
   * Uses raw API first to preserve user_id in responses, then falls back to SDK-normalized output.
   */
  async listConnectedAccounts(options?: {
    toolkits?: string[];
    userIds?: string[];
    statuses?: string[];
  }): Promise<ConnectedAccountSummary[]> {
    const toolkits = normalizeToolkitList(options?.toolkits)?.filter((t) => this.isToolkitAllowed(t));
    const userIds = options?.userIds
      ?.map(u => String(u || "").trim())
      .filter(Boolean);
    const statuses = this.normalizeStatuses(options?.statuses);

    if (options?.toolkits && (!toolkits || toolkits.length === 0)) return [];

    try {
      return await this.listConnectedAccountsRaw({
        toolkits,
        userIds,
        statuses,
      });
    } catch {
      return this.listConnectedAccountsFallback({
        toolkits,
        userIds,
        statuses,
      });
    }
  }

  /**
   * Find user IDs that have an active connected account for a toolkit.
   */
  async findActiveUserIdsForToolkit(toolkit: string): Promise<string[]> {
    const normalizedToolkit = normalizeToolkitSlug(toolkit);
    if (!this.isToolkitAllowed(normalizedToolkit)) return [];

    const accounts = await this.listConnectedAccounts({
      toolkits: [normalizedToolkit],
      statuses: ["ACTIVE"],
    });

    const userIds = new Set<string>();
    for (const account of accounts) {
      if (account.userId) userIds.add(account.userId);
    }
    return Array.from(userIds).sort();
  }

  private async listConnectedAccountsRaw(options?: {
    toolkits?: string[];
    userIds?: string[];
    statuses?: ConnectedAccountStatusFilter[];
  }): Promise<ConnectedAccountSummary[]> {
    const accounts: ConnectedAccountSummary[] = [];
    let cursor: string | null | undefined;
    const seenCursors = new Set<string>();

    do {
      const response = await (this.client as any).client.connectedAccounts.list({
        ...(options?.toolkits && options.toolkits.length > 0 ? { toolkit_slugs: options.toolkits } : {}),
        ...(options?.userIds && options.userIds.length > 0 ? { user_ids: options.userIds } : {}),
        ...(options?.statuses && options.statuses.length > 0 ? { statuses: options.statuses } : {}),
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });

      const items = (
        Array.isArray(response)
          ? response
          : (response as { items?: unknown[] })?.items || []
      ) as Array<Record<string, unknown>>;

      for (const item of items) {
        const toolkitSlug = normalizeToolkitSlug(
          ((item.toolkit as { slug?: string } | undefined)?.slug || "").toString()
        );
        if (!toolkitSlug) continue;
        if (!this.isToolkitAllowed(toolkitSlug)) continue;

        accounts.push({
          id: String(item.id || ""),
          toolkit: toolkitSlug,
          userId: typeof item.user_id === "string" ? item.user_id : undefined,
          status: typeof item.status === "string" ? item.status : undefined,
          authConfigId: typeof (item.auth_config as { id?: string } | undefined)?.id === "string"
            ? (item.auth_config as { id?: string }).id
            : undefined,
          isDisabled: typeof item.is_disabled === "boolean" ? item.is_disabled : undefined,
          createdAt: typeof item.created_at === "string" ? item.created_at : undefined,
          updatedAt: typeof item.updated_at === "string" ? item.updated_at : undefined,
        });
      }

      cursor = Array.isArray(response)
        ? null
        : ((response as { next_cursor?: string | null })?.next_cursor ?? null);
      if (!cursor) break;
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    } while (true);

    return accounts;
  }

  private async listConnectedAccountsFallback(options?: {
    toolkits?: string[];
    userIds?: string[];
    statuses?: ConnectedAccountStatusFilter[];
  }): Promise<ConnectedAccountSummary[]> {
    const accounts: ConnectedAccountSummary[] = [];
    let cursor: string | null | undefined;
    const seenCursors = new Set<string>();

    do {
      const response = await this.client.connectedAccounts.list({
        ...(options?.toolkits && options.toolkits.length > 0 ? { toolkitSlugs: options.toolkits } : {}),
        ...(options?.userIds && options.userIds.length > 0 ? { userIds: options.userIds } : {}),
        ...(options?.statuses && options.statuses.length > 0 ? { statuses: options.statuses } : {}),
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });

      const items = (
        Array.isArray(response)
          ? response
          : (response as { items?: unknown[] })?.items || []
      ) as Array<Record<string, unknown>>;

      for (const item of items) {
        const toolkitSlug = normalizeToolkitSlug(
          ((item.toolkit as { slug?: string } | undefined)?.slug || "").toString()
        );
        if (!toolkitSlug) continue;
        if (!this.isToolkitAllowed(toolkitSlug)) continue;

        accounts.push({
          id: String(item.id || ""),
          toolkit: toolkitSlug,
          status: typeof item.status === "string" ? item.status : undefined,
          authConfigId: typeof (item.authConfig as { id?: string } | undefined)?.id === "string"
            ? (item.authConfig as { id?: string }).id
            : undefined,
          isDisabled: typeof item.isDisabled === "boolean" ? item.isDisabled : undefined,
          createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
        });
      }

      cursor = Array.isArray(response)
        ? null
        : ((response as { nextCursor?: string | null })?.nextCursor ?? null);
      if (!cursor) break;
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    } while (true);

    return accounts;
  }

  /**
   * Create an auth connection for a toolkit using session.authorize()
   */
  async createConnection(
    toolkit: string,
    userId?: string
  ): Promise<{ authUrl: string } | { error: string }> {
    const uid = this.getUserId(userId);
    const toolkitSlug = normalizeToolkitSlug(toolkit);

    if (!toolkitSlug) {
      return { error: "Toolkit is required" };
    }

    if (!this.isToolkitAllowed(toolkitSlug)) {
      return { error: `Toolkit '${toolkitSlug}' is not allowed by plugin configuration` };
    }

    try {
      const session = await this.getSession(uid);
      const result = await session.authorize(toolkitSlug) as { redirectUrl?: string; url?: string };
      return { authUrl: result.redirectUrl || result.url || "" };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * List available toolkits
   */
  async listToolkits(userId?: string): Promise<string[]> {
    const uid = this.getUserId(userId);

    try {
      const session = await this.getSession(uid);
      const seen = new Set<string>();
      let nextCursor: string | undefined;
      const seenCursors = new Set<string>();

      do {
        const response = await session.toolkits({
          nextCursor,
          limit: 100,
        });

        const allToolkits = response.items || [];
        for (const tk of allToolkits) {
          const slug = normalizeToolkitSlug(tk.slug);
          if (!this.isToolkitAllowed(slug)) continue;
          seen.add(slug);
        }

        nextCursor = response.nextCursor;
        if (!nextCursor) break;
        if (seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
      } while (true);

      return Array.from(seen);
    } catch (err: unknown) {
      const errObj = err as { status?: number; error?: { error?: { message?: string } } };
      if (errObj?.status === 401) {
        throw new Error("Invalid Composio API key. Get a valid key from platform.composio.dev/settings");
      }
      const apiMsg = errObj?.error?.error?.message;
      throw new Error(
        `Failed to list toolkits: ${apiMsg || (err instanceof Error ? err.message : String(err))}`
      );
    }
  }

  /**
   * Disconnect a toolkit
   */
  async disconnectToolkit(
    toolkit: string,
    userId?: string
  ): Promise<{ success: boolean; error?: string }> {
    const uid = this.getUserId(userId);
    const toolkitSlug = normalizeToolkitSlug(toolkit);

    if (!toolkitSlug) {
      return { success: false, error: "Toolkit is required" };
    }

    if (this.config.readOnlyMode) {
      return {
        success: false,
        error: "Disconnect is blocked by readOnlyMode.",
      };
    }

    try {
      const activeAccounts = await this.listConnectedAccounts({
        toolkits: [toolkitSlug],
        userIds: [uid],
        statuses: ["ACTIVE"],
      });

      if (activeAccounts.length === 0) {
        return { success: false, error: `No connection found for toolkit '${toolkitSlug}'` };
      }

      if (activeAccounts.length > 1) {
        const ids = activeAccounts.map(a => a.id).join(", ");
        return {
          success: false,
          error:
            `Multiple ACTIVE '${toolkitSlug}' accounts found for user_id '${uid}': ${ids}. ` +
            "Use the dashboard to disconnect a specific account.",
        };
      }

      await this.client.connectedAccounts.delete(activeAccounts[0]!.id);

      // Clear session cache to refresh connection status
      this.clearUserSessionCache(uid);

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

}

/**
 * Create a Composio client instance
 */
export function createComposioClient(config: ComposioConfig): ComposioClient {
  return new ComposioClient(config);
}

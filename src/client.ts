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
   * Resolve user ID for API calls.
   * This plugin requires explicit user_id scoping to avoid accidental cross-user access.
   */
  private getUserId(overrideUserId?: string): string {
    const userId = String(overrideUserId || "").trim();
    if (!userId) {
      throw new Error("user_id is required. Pass user_id explicitly.");
    }
    return userId;
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
    const session = await this.client.toolRouter.create(userId, sessionConfig);
    this.sessionCache.set(key, session);
    return session;
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
    const requestedUid = this.getUserId(userId);
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
      userId: requestedUid,
      connectedAccountId,
      userIdWasExplicit: typeof userId === "string" && userId.trim().length > 0,
    });
    if ("error" in accountResolution) {
      return { success: false, error: accountResolution.error };
    }

    const effectiveUid = accountResolution.userId || requestedUid;

    const session = await this.getSession(
      effectiveUid,
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
        return { success: false, error: response.error || "Execution failed" };
      }

      const results = (response.data?.results as Array<{
        tool_slug: string;
        index: number;
        response: {
          successful: boolean;
          data?: unknown;
          data_preview?: unknown;
          error?: string | null;
        };
      }>) || [];

      const result = results[0];
      if (!result) {
        return { success: false, error: "No result returned" };
      }

      // Response data is nested under result.response
      const toolResponse = result.response;
      const toolData = toolResponse.data ?? toolResponse.data_preview;
      return {
        success: toolResponse.successful,
        data: toolData,
        error: toolResponse.error ?? undefined,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async resolveConnectedAccountForExecution(params: {
    toolkit: string;
    userId: string;
    connectedAccountId?: string;
    userIdWasExplicit?: boolean;
  }): Promise<{ connectedAccountId?: string; userId?: string } | { error: string }> {
    const toolkit = normalizeToolkitSlug(params.toolkit);
    const { userId } = params;
    const explicitId = params.connectedAccountId?.trim();

    if (explicitId) {
      try {
        const account = await this.client.connectedAccounts.get(explicitId) as {
          status?: string;
          toolkit?: { slug?: string };
          userId?: string;
          user_id?: string;
        };
        const accountToolkit = normalizeToolkitSlug(String(account?.toolkit?.slug || ""));
        const accountStatus = String(account?.status || "").toUpperCase();
        const accountUserId = String(account?.user_id || account?.userId || "").trim();

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
        if (params.userIdWasExplicit && accountUserId && accountUserId !== userId) {
          return {
            error:
              `Connected account '${explicitId}' belongs to user_id '${accountUserId}', ` +
              `but '${userId}' was requested. Use matching user_id or omit user_id when providing connected_account_id.`,
          };
        }
        if (!accountUserId) {
          // Fail closed: when owner is omitted by API, verify this account is ACTIVE in requested user scope.
          const accountMatchesRequestedUser = await this.isConnectedAccountActiveForUser(
            toolkit,
            userId,
            explicitId
          );
          if (!accountMatchesRequestedUser) {
            return {
              error:
                `Connected account '${explicitId}' ownership could not be verified for user_id '${userId}'. ` +
                "Use a connected_account_id that belongs to this user_id and is ACTIVE.",
            };
          }
          return { connectedAccountId: explicitId, userId };
        }

        return { connectedAccountId: explicitId, userId: accountUserId };
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

  private async isConnectedAccountActiveForUser(
    toolkit: string,
    userId: string,
    connectedAccountId: string
  ): Promise<boolean> {
    const activeAccounts = await this.listConnectedAccounts({
      toolkits: [toolkit],
      userIds: [userId],
      statuses: ["ACTIVE"],
    });
    return activeAccounts.some((account) => account.id === connectedAccountId);
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
    const rawList = (this.client as any)?.client?.connectedAccounts?.list;
    if (typeof rawList !== "function") {
      throw new Error("Raw connected accounts list API unavailable");
    }

    const accounts: ConnectedAccountSummary[] = [];
    let cursor: string | null | undefined;
    const seenCursors = new Set<string>();

    do {
      const response = await rawList.call((this.client as any).client.connectedAccounts, {
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
          userId: typeof item.user_id === "string"
            ? item.user_id
            : (typeof item.userId === "string" ? item.userId : undefined),
          status: typeof item.status === "string" ? item.status : undefined,
          authConfigId: typeof (item.auth_config as { id?: string } | undefined)?.id === "string"
            ? (item.auth_config as { id?: string }).id
            : (typeof (item.authConfig as { id?: string } | undefined)?.id === "string"
              ? (item.authConfig as { id?: string }).id
              : undefined),
          isDisabled: typeof item.is_disabled === "boolean"
            ? item.is_disabled
            : (typeof item.isDisabled === "boolean" ? item.isDisabled : undefined),
          createdAt: typeof item.created_at === "string"
            ? item.created_at
            : (typeof item.createdAt === "string" ? item.createdAt : undefined),
          updatedAt: typeof item.updated_at === "string"
            ? item.updated_at
            : (typeof item.updatedAt === "string" ? item.updatedAt : undefined),
        });
      }

      cursor = Array.isArray(response)
        ? null
        : (((response as { next_cursor?: string | null })?.next_cursor)
          ?? ((response as { nextCursor?: string | null })?.nextCursor)
          ?? null);
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
          userId: typeof item.userId === "string"
            ? item.userId
            : (typeof item.user_id === "string" ? item.user_id : undefined),
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
      const authUrl = String(result.redirectUrl || result.url || "").trim();
      if (!authUrl) {
        return { error: "Auth URL was not returned by provider" };
      }
      return { authUrl };
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

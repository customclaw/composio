import { Composio } from "@composio/core";
import type {
  ComposioConfig,
  ToolSearchResult,
  ToolExecutionResult,
  ConnectionStatus,
  ConnectedAccountSummary,
} from "./types.js";

/**
 * Tool Router session type from SDK
 */
interface ToolRouterSession {
  sessionId: string;
  tools: () => Promise<unknown[]>;
  authorize: (toolkit: string) => Promise<{ url: string }>;
  toolkits: (options?: {
    nextCursor?: string;
    toolkits?: string[];
    limit?: number;
    isConnected?: boolean;
    search?: string;
  }) => Promise<{
    items: Array<{
      slug: string;
      name: string;
      connection?: {
        isActive: boolean;
        connectedAccount?: { id: string; status: string };
      };
    }>;
    nextCursor?: string;
    totalPages?: number;
  }>;
  experimental: { assistivePrompt: string };
}

type SessionConnectedAccountsOverride = Record<string, string>;

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
    this.config = config;
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
      .map(([toolkit, accountId]) => `${toolkit.toLowerCase()}=${accountId}`)
      .sort()
      .join(",");
    return `uid:${userId}::ca:${normalized}`;
  }

  private async getSession(
    userId: string,
    connectedAccounts?: SessionConnectedAccountsOverride
  ): Promise<ToolRouterSession> {
    const key = this.makeSessionCacheKey(userId, connectedAccounts);
    if (this.sessionCache.has(key)) {
      return this.sessionCache.get(key)!;
    }
    const session = await (this.client as any).toolRouter.create(
      userId,
      connectedAccounts ? { connectedAccounts } : undefined
    ) as ToolRouterSession;
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
    const { allowedToolkits, blockedToolkits } = this.config;

    if (blockedToolkits?.includes(toolkit.toLowerCase())) {
      return false;
    }

    if (allowedToolkits && allowedToolkits.length > 0) {
      return allowedToolkits.includes(toolkit.toLowerCase());
    }

    return true;
  }

  /**
   * Execute a Tool Router meta-tool
   */
  private async executeMetaTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ data?: Record<string, unknown>; successful: boolean; error?: string }> {
    const response = await (this.client as any).client.tools.execute(toolName, {
      arguments: args,
    } as Record<string, unknown>);
    return response as { data?: Record<string, unknown>; successful: boolean; error?: string };
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

    try {
      const response = await this.executeMetaTool("COMPOSIO_SEARCH_TOOLS", {
        queries: [{ use_case: query }],
        session: { id: session.sessionId },
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
          const toolkit = schema?.toolkit || slug.split("_")[0] || "";

          if (!this.isToolkitAllowed(toolkit)) continue;

          if (options?.toolkits && options.toolkits.length > 0) {
            if (!options.toolkits.some(t => t.toLowerCase() === toolkit.toLowerCase())) {
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

    const toolkit = toolSlug.split("_")[0]?.toLowerCase() || "";
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
      const response = await this.executeMetaTool("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: toolSlug, arguments: args }],
        session: { id: session.sessionId },
        sync_response_to_workbench: false,
      });

      if (!response.successful) {
        const fallback = await this.tryDirectExecutionFallback({
          uid,
          toolSlug,
          args,
          connectedAccountId: accountResolution.connectedAccountId,
          metaError: response.error,
          metaData: response.data,
        });
        if (fallback) return fallback;
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
        const fallback = await this.tryDirectExecutionFallback({
          uid,
          toolSlug,
          args,
          connectedAccountId: accountResolution.connectedAccountId,
          metaError: toolResponse.error ?? undefined,
          metaData: response.data,
        });
        if (fallback) return fallback;
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

    try {
      const response = await (this.client as any).tools.execute(params.toolSlug, {
        userId: params.uid,
        connectedAccountId: params.connectedAccountId,
        arguments: params.args,
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

  private shouldFallbackToDirectExecution(
    uid: string,
    metaError?: string,
    metaData?: Record<string, unknown>
  ): boolean {
    if (uid === "default") return false;
    const base = String(metaError || "");
    const nested = this.extractNestedMetaError(metaData);
    const combined = `${base}\n${nested}`.toLowerCase();
    return combined.includes("no connected account found for entity id default");
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
    const { toolkit, userId } = params;
    const explicitId = params.connectedAccountId?.trim();

    if (explicitId) {
      try {
        const account = await (this.client as any).connectedAccounts.get(explicitId) as {
          status?: string;
          toolkit?: { slug?: string };
        };
        const accountToolkit = String(account?.toolkit?.slug || "").toLowerCase();
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
      if (toolkits && toolkits.length > 0) {
        const requestedToolkits = toolkits.filter(t => this.isToolkitAllowed(t));
        if (requestedToolkits.length === 0) return [];
        const toolkitStateMap = await this.getToolkitStateMap(session, requestedToolkits);
        const activeAccountToolkits = await this.getActiveConnectedAccountToolkits(uid, requestedToolkits);

        return requestedToolkits.map((toolkit) => {
          const key = toolkit.toLowerCase();
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
        const key = tk.slug.toLowerCase();
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
    let cursor: string | null | undefined;
    const seenCursors = new Set<string>();

    try {
      do {
        const response = await (this.client as any).connectedAccounts.list({
          userIds: [userId],
          statuses: ["ACTIVE"],
          ...(toolkits && toolkits.length > 0 ? { toolkitSlugs: toolkits } : {}),
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });

        const items = (
          Array.isArray(response)
            ? response
            : (response as { items?: unknown[] })?.items || []
        ) as Array<{ toolkit?: { slug?: string }; status?: string }>;

        for (const item of items) {
          const slug = item.toolkit?.slug;
          if (!slug) continue;
          if (item.status && String(item.status).toUpperCase() !== "ACTIVE") continue;
          connected.add(slug.toLowerCase());
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

  private normalizeStatuses(statuses?: string[]): string[] | undefined {
    if (!statuses || statuses.length === 0) return undefined;
    const allowed = new Set(["INITIALIZING", "INITIATED", "ACTIVE", "FAILED", "EXPIRED", "INACTIVE"]);
    const normalized = statuses
      .map(s => String(s || "").trim().toUpperCase())
      .filter(s => allowed.has(s));
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
    const toolkits = options?.toolkits
      ?.map(t => String(t || "").trim())
      .filter(t => t.length > 0 && this.isToolkitAllowed(t));
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
    if (!this.isToolkitAllowed(toolkit)) return [];

    const accounts = await this.listConnectedAccounts({
      toolkits: [toolkit],
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
    statuses?: string[];
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
        const toolkitSlug =
          ((item.toolkit as { slug?: string } | undefined)?.slug || "").toString().toLowerCase();
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
    statuses?: string[];
  }): Promise<ConnectedAccountSummary[]> {
    const accounts: ConnectedAccountSummary[] = [];
    let cursor: string | null | undefined;
    const seenCursors = new Set<string>();

    do {
      const response = await (this.client as any).connectedAccounts.list({
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
        const toolkitSlug =
          ((item.toolkit as { slug?: string } | undefined)?.slug || "").toString().toLowerCase();
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

    if (!this.isToolkitAllowed(toolkit)) {
      return { error: `Toolkit '${toolkit}' is not allowed by plugin configuration` };
    }

    try {
      const session = await this.getSession(uid);
      const result = await session.authorize(toolkit) as { redirectUrl?: string; url?: string };
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
          const slug = tk.slug.toLowerCase();
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

    try {
      const response = await (this.client as any).connectedAccounts.list({ userIds: [uid] });
      const connections = (
        Array.isArray(response)
          ? response
          : (response as { items?: unknown[] })?.items || []
      ) as Array<{ toolkit?: { slug?: string }; id: string }>;

      const conn = connections.find(
        c => c.toolkit?.slug?.toLowerCase() === toolkit.toLowerCase()
      );

      if (!conn) {
        return { success: false, error: `No connection found for toolkit '${toolkit}'` };
      }

      await (this.client as any).connectedAccounts.delete({ connectedAccountId: conn.id });

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

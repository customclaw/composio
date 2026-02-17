import { Composio } from "@composio/core";
import type {
  ComposioConfig,
  ToolSearchResult,
  ToolExecutionResult,
  ConnectionStatus,
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
  private async getSession(userId: string): Promise<ToolRouterSession> {
    if (this.sessionCache.has(userId)) {
      return this.sessionCache.get(userId)!;
    }
    const session = await (this.client as any).toolRouter.create(userId) as ToolRouterSession;
    this.sessionCache.set(userId, session);
    return session;
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
    userId?: string
  ): Promise<ToolExecutionResult> {
    const uid = this.getUserId(userId);
    const session = await this.getSession(uid);

    const toolkit = toolSlug.split("_")[0]?.toLowerCase() || "";
    if (!this.isToolkitAllowed(toolkit)) {
      return {
        success: false,
        error: `Toolkit '${toolkit}' is not allowed by plugin configuration`,
      };
    }

    try {
      const response = await this.executeMetaTool("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: toolSlug, arguments: args }],
        session: { id: session.sessionId },
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
          error?: string | null;
        };
      }>) || [];

      const result = results[0];
      if (!result) {
        return { success: false, error: "No result returned" };
      }

      // Response data is nested under result.response
      const toolResponse = result.response;
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
      const response = await session.toolkits();
      const allToolkits = response.items || [];

      return allToolkits
        .map(tk => tk.slug)
        .filter(slug => this.isToolkitAllowed(slug));
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
      this.sessionCache.delete(uid);

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

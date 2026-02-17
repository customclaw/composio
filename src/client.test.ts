import { describe, it, expect, vi } from "vitest";
import { ComposioClient } from "./client.js";
import { parseComposioConfig } from "./config.js";
import { createComposioExecuteTool } from "./tools/execute.js";
import { createComposioConnectionsTool } from "./tools/connections.js";

// Mock the Composio SDK
vi.mock("@composio/core", () => ({
  Composio: vi.fn().mockImplementation(() => ({
    toolRouter: {
      create: vi.fn().mockResolvedValue({
        sessionId: "test-session-123",
        tools: vi.fn().mockResolvedValue([]),
        authorize: vi.fn().mockResolvedValue({ url: "https://connect.composio.dev/test" }),
        toolkits: vi.fn().mockResolvedValue({
          items: [
            { slug: "gmail", name: "Gmail", connection: { isActive: true } },
            { slug: "sentry", name: "Sentry", connection: { isActive: false } },
            { slug: "github", name: "GitHub", connection: { isActive: true } },
            { slug: "affinity", name: "Affinity", connection: { isActive: false } },
          ],
        }),
        experimental: { assistivePrompt: "" },
      }),
    },
    client: {
      tools: {
        execute: vi.fn().mockResolvedValue({
          successful: true,
          data: { results: [{ tool_slug: "GMAIL_FETCH_EMAILS", index: 0, response: { successful: true, data: { messages: [] } } }] },
        }),
      },
      connectedAccounts: {
        list: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      },
    },
    connectedAccounts: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      get: vi.fn().mockResolvedValue({ toolkit: { slug: "gmail" }, status: "ACTIVE" }),
      delete: vi.fn().mockResolvedValue({}),
    },
  })),
}));

function makeClient(overrides?: Partial<ReturnType<typeof parseComposioConfig>>) {
  return new ComposioClient({
    enabled: true,
    apiKey: "test-key",
    ...overrides,
  });
}

async function getLatestComposioInstance() {
  const { Composio } = await import("@composio/core");
  const mockResults = (Composio as any).mock.results;
  return mockResults[mockResults.length - 1].value;
}

describe("config parsing", () => {
  it("reads apiKey from config object", () => {
    const config = parseComposioConfig({ config: { apiKey: "from-config" } });
    expect(config.apiKey).toBe("from-config");
  });

  it("reads apiKey from top-level", () => {
    const config = parseComposioConfig({ apiKey: "from-top" });
    expect(config.apiKey).toBe("from-top");
  });

  it("falls back to env var", () => {
    process.env.COMPOSIO_API_KEY = "from-env";
    const config = parseComposioConfig({});
    expect(config.apiKey).toBe("from-env");
    delete process.env.COMPOSIO_API_KEY;
  });

  it("defaults enabled to true", () => {
    const config = parseComposioConfig({});
    expect(config.enabled).toBe(true);
  });
});

describe("toolkit filtering", () => {
  it("allows all toolkits when no filter set", async () => {
    const client = makeClient();
    const statuses = await client.getConnectionStatus(["gmail", "sentry", "github"]);
    expect(statuses).toHaveLength(3);
  });

  it("filters by allowedToolkits", async () => {
    const client = makeClient({ allowedToolkits: ["gmail", "sentry"] });
    const statuses = await client.getConnectionStatus(["gmail", "sentry", "github"]);
    expect(statuses).toHaveLength(2);
    expect(statuses.map(s => s.toolkit)).toEqual(["gmail", "sentry"]);
  });

  it("filters by blockedToolkits", async () => {
    const client = makeClient({ blockedToolkits: ["github"] });
    const statuses = await client.getConnectionStatus(["gmail", "sentry", "github"]);
    expect(statuses).toHaveLength(2);
    expect(statuses.find(s => s.toolkit === "github")).toBeUndefined();
  });

  it("blocked takes priority over allowed", async () => {
    const client = makeClient({ allowedToolkits: ["gmail", "github"], blockedToolkits: ["github"] });
    const statuses = await client.getConnectionStatus(["gmail", "github"]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].toolkit).toBe("gmail");
  });
});

describe("connection status", () => {
  it("reports gmail as connected", async () => {
    const client = makeClient();
    const statuses = await client.getConnectionStatus(["gmail"]);
    expect(statuses[0].connected).toBe(true);
  });

  it("reports sentry as not connected", async () => {
    const client = makeClient();
    const statuses = await client.getConnectionStatus(["sentry"]);
    expect(statuses[0].connected).toBe(false);
  });

  it("reports toolkit as connected when active connected account exists", async () => {
    const client = makeClient();
    const instance = await getLatestComposioInstance();
    instance.connectedAccounts.list.mockResolvedValueOnce({
      items: [{ toolkit: { slug: "affinity" }, status: "ACTIVE" }],
      nextCursor: null,
    });

    const statuses = await client.getConnectionStatus(["affinity"]);
    expect(statuses[0].connected).toBe(true);
  });

  it("returns only connected toolkits when no filter", async () => {
    const client = makeClient();
    const statuses = await client.getConnectionStatus();
    expect(statuses.every(s => s.connected)).toBe(true);
    expect(statuses.map(s => s.toolkit)).toEqual(["gmail", "github"]);
  });
});

describe("execute tool", () => {
  it("executes and returns result", async () => {
    const client = makeClient();
    const result = await client.executeTool("GMAIL_FETCH_EMAILS", {});
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ messages: [] });
  });

  it("rejects blocked toolkit", async () => {
    const client = makeClient({ allowedToolkits: ["sentry"] });
    const result = await client.executeTool("GMAIL_FETCH_EMAILS", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
  });

  it("pins execution to explicit connected_account_id", async () => {
    const client = makeClient();
    const instance = await getLatestComposioInstance();
    instance.connectedAccounts.get.mockResolvedValueOnce({
      toolkit: { slug: "gmail" },
      status: "ACTIVE",
    });

    const result = await client.executeTool("GMAIL_FETCH_EMAILS", {}, "default", "ca_explicit");
    expect(result.success).toBe(true);
    expect(instance.toolRouter.create).toHaveBeenCalledWith("default", {
      connectedAccounts: { gmail: "ca_explicit" },
    });
  });

  it("auto-pins execution when one active account exists", async () => {
    const client = makeClient();
    const instance = await getLatestComposioInstance();
    instance.client.connectedAccounts.list.mockResolvedValueOnce({
      items: [
        { id: "ca_single", user_id: "default", status: "ACTIVE", toolkit: { slug: "gmail" } },
      ],
      next_cursor: null,
    });

    const result = await client.executeTool("GMAIL_FETCH_EMAILS", {}, "default");
    expect(result.success).toBe(true);
    expect(instance.toolRouter.create).toHaveBeenCalledWith("default", {
      connectedAccounts: { gmail: "ca_single" },
    });
  });

  it("fails with clear error when multiple active accounts exist and none selected", async () => {
    const client = makeClient();
    const instance = await getLatestComposioInstance();
    instance.client.connectedAccounts.list.mockResolvedValueOnce({
      items: [
        { id: "ca_1", user_id: "default", status: "ACTIVE", toolkit: { slug: "gmail" } },
        { id: "ca_2", user_id: "default", status: "ACTIVE", toolkit: { slug: "gmail" } },
      ],
      next_cursor: null,
    });

    const result = await client.executeTool("GMAIL_FETCH_EMAILS", {}, "default");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Multiple ACTIVE 'gmail' accounts");
    expect(result.error).toContain("ca_1");
    expect(result.error).toContain("ca_2");
  });
});

describe("create connection", () => {
  it("returns auth URL", async () => {
    const client = makeClient();
    const result = await client.createConnection("gmail");
    expect("authUrl" in result).toBe(true);
    if ("authUrl" in result) {
      expect(result.authUrl).toContain("connect.composio.dev");
    }
  });

  it("rejects blocked toolkit", async () => {
    const client = makeClient({ blockedToolkits: ["gmail"] });
    const result = await client.createConnection("gmail");
    expect("error" in result).toBe(true);
  });
});

describe("connected accounts discovery", () => {
  it("lists connected accounts with user IDs from raw API", async () => {
    const client = makeClient();
    const instance = await getLatestComposioInstance();
    instance.client.connectedAccounts.list.mockResolvedValueOnce({
      items: [
        {
          id: "ca_1",
          user_id: "user-a",
          status: "ACTIVE",
          toolkit: { slug: "sentry" },
          auth_config: { id: "ac_1" },
        },
      ],
      next_cursor: null,
    });

    const accounts = await client.listConnectedAccounts({ toolkits: ["sentry"], statuses: ["ACTIVE"] });
    expect(accounts).toEqual([
      {
        id: "ca_1",
        toolkit: "sentry",
        userId: "user-a",
        status: "ACTIVE",
        authConfigId: "ac_1",
        isDisabled: undefined,
        createdAt: undefined,
        updatedAt: undefined,
      },
    ]);
  });

  it("falls back to SDK-normalized account list when raw API errors", async () => {
    const client = makeClient();
    const instance = await getLatestComposioInstance();
    instance.client.connectedAccounts.list.mockRejectedValueOnce(new Error("raw unavailable"));
    instance.connectedAccounts.list.mockResolvedValueOnce({
      items: [
        {
          id: "ca_2",
          status: "ACTIVE",
          toolkit: { slug: "gmail" },
          authConfig: { id: "ac_2" },
          isDisabled: false,
        },
      ],
      nextCursor: null,
    });

    const accounts = await client.listConnectedAccounts({ toolkits: ["gmail"], statuses: ["ACTIVE"] });
    expect(accounts[0]).toMatchObject({
      id: "ca_2",
      toolkit: "gmail",
      status: "ACTIVE",
      authConfigId: "ac_2",
      isDisabled: false,
    });
  });

  it("finds active user IDs for toolkit", async () => {
    const client = makeClient();
    const instance = await getLatestComposioInstance();
    instance.client.connectedAccounts.list.mockResolvedValueOnce({
      items: [
        { id: "ca_1", user_id: "default", status: "ACTIVE", toolkit: { slug: "sentry" } },
        { id: "ca_2", user_id: "user-b", status: "ACTIVE", toolkit: { slug: "sentry" } },
        { id: "ca_3", user_id: "default", status: "ACTIVE", toolkit: { slug: "sentry" } },
      ],
      next_cursor: null,
    });

    const userIds = await client.findActiveUserIdsForToolkit("sentry");
    expect(userIds).toEqual(["default", "user-b"]);
  });
});

describe("session caching", () => {
  it("reuses session for same user", async () => {
    const client = makeClient();
    await client.getConnectionStatus(["gmail"]);
    await client.getConnectionStatus(["gmail"]);
    // toolRouter.create should only be called once
    const { Composio } = await import("@composio/core");
    const instance = (Composio as any).mock.results[0].value;
    expect(instance.toolRouter.create).toHaveBeenCalledTimes(1);
  });
});

describe("execute tool string arguments (GLM-5 workaround)", () => {
  function makeTool() {
    const client = makeClient();
    const config = parseComposioConfig({ config: { apiKey: "test-key" } });
    return createComposioExecuteTool(client, config);
  }

  it("parses string arguments as JSON", async () => {
    const tool = makeTool();
    const result = await tool.execute("test", {
      tool_slug: "GMAIL_FETCH_EMAILS",
      arguments: '{"user_id": "me", "max_results": 5}',
    });
    expect(result.details).toHaveProperty("success", true);
  });

  it("handles object arguments normally", async () => {
    const tool = makeTool();
    const result = await tool.execute("test", {
      tool_slug: "GMAIL_FETCH_EMAILS",
      arguments: { user_id: "me", max_results: 5 },
    });
    expect(result.details).toHaveProperty("success", true);
  });

  it("falls back to empty args on invalid JSON string", async () => {
    const tool = makeTool();
    const result = await tool.execute("test", {
      tool_slug: "GMAIL_FETCH_EMAILS",
      arguments: "not valid json",
    });
    expect(result.details).toHaveProperty("success", true);
  });

  it("falls back to empty args when arguments is missing", async () => {
    const tool = makeTool();
    const result = await tool.execute("test", {
      tool_slug: "GMAIL_FETCH_EMAILS",
    });
    expect(result.details).toHaveProperty("success", true);
  });
});

describe("connections tool", () => {
  function makeConnectionsTool() {
    const client = makeClient();
    const config = parseComposioConfig({ config: { apiKey: "test-key" } });
    return createComposioConnectionsTool(client, config);
  }

  it("list action passes user_id to client", async () => {
    const tool = makeConnectionsTool();
    await tool.execute("test", { action: "list", user_id: "custom-user" });
    const instance = await getLatestComposioInstance();
    expect(instance.toolRouter.create).toHaveBeenCalledWith("custom-user", undefined);
  });

  it("status uses active connected accounts as fallback", async () => {
    const tool = makeConnectionsTool();
    const instance = await getLatestComposioInstance();
    instance.connectedAccounts.list.mockResolvedValueOnce({
      items: [{ toolkit: { slug: "affinity" }, status: "ACTIVE" }],
      nextCursor: null,
    });

    const result = await tool.execute("test", { action: "status", toolkit: "affinity" });
    const details = result.details as any;
    const conn = details.connections.find((c: any) => c.toolkit === "affinity");
    expect(conn.connected).toBe(true);
    expect(instance.client.tools.execute).not.toHaveBeenCalledWith(
      "AFFINITY_GET_METADATA_ON_ALL_LISTS",
      expect.anything()
    );
  });

  it("status keeps disconnected when no active account exists", async () => {
    const tool = makeConnectionsTool();
    const result = await tool.execute("test", { action: "status", toolkit: "sentry" });
    const details = result.details as any;
    const conn = details.connections.find((c: any) => c.toolkit === "sentry");
    expect(conn.connected).toBe(false);
  });

  it("accounts action returns connected accounts", async () => {
    const tool = makeConnectionsTool();
    const instance = await getLatestComposioInstance();
    instance.client.connectedAccounts.list.mockResolvedValueOnce({
      items: [
        {
          id: "ca_1",
          user_id: "user-a",
          status: "ACTIVE",
          toolkit: { slug: "sentry" },
          auth_config: { id: "ac_1" },
        },
      ],
      next_cursor: null,
    });

    const result = await tool.execute("test", { action: "accounts", toolkit: "sentry" });
    const details = result.details as any;
    expect(details.action).toBe("accounts");
    expect(details.count).toBe(1);
    expect(details.accounts[0]).toMatchObject({
      id: "ca_1",
      toolkit: "sentry",
      user_id: "user-a",
      status: "ACTIVE",
      auth_config_id: "ac_1",
    });
  });
});

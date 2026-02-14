import { describe, it, expect, vi } from "vitest";
import { ComposioClient } from "./client.js";
import { parseComposioConfig } from "./config.js";
import { createComposioExecuteTool } from "./tools/execute.js";

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
    },
    connectedAccounts: {
      list: vi.fn().mockResolvedValue({ items: [] }),
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

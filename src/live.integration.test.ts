import { describe, it, expect } from "vitest";
import { ComposioClient } from "./client.js";

const RUN_LIVE = process.env.COMPOSIO_LIVE_TEST === "1";
const API_KEY = process.env.COMPOSIO_API_KEY;
const LIVE_USER_ID = process.env.COMPOSIO_LIVE_USER_ID || `openclaw-live-${Date.now()}`;
const LIVE_TOOLKIT = String(process.env.COMPOSIO_LIVE_TOOLKIT || "gmail").trim().toLowerCase();
const LIVE_TOOL_SLUG = String(process.env.COMPOSIO_LIVE_TOOL_SLUG || "").trim();
const LIVE_CONNECTED_ACCOUNT_ID = String(process.env.COMPOSIO_LIVE_CONNECTED_ACCOUNT_ID || "").trim();
const LIVE_EXPECT_EXECUTE_SUCCESS = process.env.COMPOSIO_LIVE_EXPECT_EXECUTE_SUCCESS === "1";

function parseLiveArgs(): Record<string, unknown> {
  const raw = process.env.COMPOSIO_LIVE_TOOL_ARGS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore invalid JSON and fall back to empty args.
  }
  return {};
}

const describeLive = RUN_LIVE && API_KEY ? describe : describe.skip;
let liveClient: ComposioClient | null = null;

function getLiveClient(): ComposioClient {
  if (!API_KEY) {
    throw new Error("COMPOSIO_API_KEY is required for live tests.");
  }
  if (!liveClient) {
    liveClient = new ComposioClient({
      enabled: true,
      apiKey: API_KEY,
      readOnlyMode: false,
    });
  }
  return liveClient;
}

describeLive("live composio integration", () => {
  it("lists toolkits", async () => {
    const client = getLiveClient();
    const toolkits = await client.listToolkits(LIVE_USER_ID);
    expect(Array.isArray(toolkits)).toBe(true);
    expect(toolkits.length).toBeGreaterThan(0);
  });

  it("checks status and generates connect URL", async () => {
    const client = getLiveClient();
    const statuses = await client.getConnectionStatus([LIVE_TOOLKIT], LIVE_USER_ID);
    expect(statuses.length).toBe(1);
    expect(statuses[0]?.toolkit).toBe(LIVE_TOOLKIT);

    const connect = await client.createConnection(LIVE_TOOLKIT, LIVE_USER_ID);
    if ("error" in connect) {
      throw new Error(`Live createConnection failed: ${connect.error}`);
    }
    expect(connect.authUrl).toMatch(/^https?:\/\//);
  });

  it.skipIf(!LIVE_TOOL_SLUG || !LIVE_CONNECTED_ACCOUNT_ID)(
    "executes a configured live tool",
    async () => {
      const client = getLiveClient();
      const result = await client.executeTool(
        LIVE_TOOL_SLUG,
        parseLiveArgs(),
        LIVE_USER_ID,
        LIVE_CONNECTED_ACCOUNT_ID
      );

      if (LIVE_EXPECT_EXECUTE_SUCCESS) {
        expect(result.success).toBe(true);
      } else {
        expect(typeof result.success).toBe("boolean");
      }
    }
  );

  it.skipIf(process.env.COMPOSIO_LIVE_ALLOW_DISCONNECT !== "1")(
    "disconnects toolkit when explicitly enabled",
    async () => {
      const client = getLiveClient();
      const active = await client.listConnectedAccounts({
        toolkits: [LIVE_TOOLKIT],
        userIds: [LIVE_USER_ID],
        statuses: ["ACTIVE"],
      });

      // Skip destructive operation unless the environment has an unambiguous single target.
      if (active.length !== 1) {
        return;
      }

      const result = await client.disconnectToolkit(LIVE_TOOLKIT, LIVE_USER_ID);
      expect(result.success).toBe(true);
    }
  );
});

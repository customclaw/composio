import { describe, expect, it, vi, beforeEach } from "vitest";

const createComposioClientMock = vi.fn(() => ({ __client: true }));
const createComposioSearchToolMock = vi.fn(() => ({
  name: "composio_search_tools",
  execute: vi.fn(async () => ({ content: [], details: {} })),
}));
const createComposioExecuteToolMock = vi.fn(() => ({
  name: "composio_execute_tool",
  execute: vi.fn(async () => ({ content: [], details: {} })),
}));
const createComposioConnectionsToolMock = vi.fn(() => ({
  name: "composio_manage_connections",
  execute: vi.fn(async () => ({ content: [], details: {} })),
}));
const registerComposioCliMock = vi.fn();

vi.mock("./client.js", () => ({
  createComposioClient: createComposioClientMock,
}));

vi.mock("./tools/search.js", () => ({
  createComposioSearchTool: createComposioSearchToolMock,
}));

vi.mock("./tools/execute.js", () => ({
  createComposioExecuteTool: createComposioExecuteToolMock,
}));

vi.mock("./tools/connections.js", () => ({
  createComposioConnectionsTool: createComposioConnectionsToolMock,
}));

vi.mock("./cli.js", () => ({
  registerComposioCli: registerComposioCliMock,
}));

type TestApi = {
  pluginConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  registerCli: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
};

function makeApi(pluginConfig?: Record<string, unknown>, config?: Record<string, unknown>): TestApi {
  return {
    pluginConfig,
    config,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    registerCli: vi.fn(),
    registerTool: vi.fn(),
  };
}

beforeEach(() => {
  createComposioClientMock.mockClear();
  createComposioSearchToolMock.mockClear();
  createComposioExecuteToolMock.mockClear();
  createComposioConnectionsToolMock.mockClear();
  registerComposioCliMock.mockClear();
});

describe("composio plugin registration", () => {
  it("always registers CLI hooks even when plugin is disabled", async () => {
    const { default: composioPlugin } = await import("./index.js");
    const api = makeApi({ enabled: false, apiKey: "test-key" });

    composioPlugin.register(api as any);

    expect(api.registerCli).toHaveBeenCalledTimes(1);
    expect(api.registerCli).toHaveBeenCalledWith(expect.any(Function), { commands: ["composio"] });
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.logger.debug).toHaveBeenCalledWith("[composio] Plugin disabled in config");
  });

  it("does not register tools without api key, but keeps CLI setup path available", async () => {
    const { default: composioPlugin } = await import("./index.js");
    const api = makeApi({ enabled: true });

    composioPlugin.register(api as any);

    expect(api.registerCli).toHaveBeenCalledTimes(1);
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(createComposioClientMock).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      "[composio] No API key configured. Set COMPOSIO_API_KEY env var or plugins.composio.apiKey in config."
    );
  });

  it("registers all tools and lazily initializes a single client instance when configured", async () => {
    const { default: composioPlugin } = await import("./index.js");
    const api = makeApi({ enabled: true, apiKey: "test-key" });

    composioPlugin.register(api as any);

    expect(api.registerCli).toHaveBeenCalledTimes(1);
    expect(api.registerTool).toHaveBeenCalledTimes(3);
    expect(createComposioClientMock).toHaveBeenCalledTimes(1);
    expect(createComposioSearchToolMock).toHaveBeenCalled();
    expect(createComposioExecuteToolMock).toHaveBeenCalled();
    expect(createComposioConnectionsToolMock).toHaveBeenCalled();
    expect(api.logger.info).toHaveBeenCalledWith("[composio] Plugin registered with 3 tools and CLI commands");
  });
});

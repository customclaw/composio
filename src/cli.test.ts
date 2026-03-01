import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerComposioCli } from "./cli.js";

type LoggerEntry = { level: "info" | "warn" | "error"; message: string };

class MockCommand {
  public readonly name: string;
  private readonly children: MockCommand[] = [];
  private actionHandler?: (...args: any[]) => Promise<void> | void;

  constructor(name: string) {
    this.name = name;
  }

  command(name: string) {
    const child = new MockCommand(name);
    this.children.push(child);
    return child;
  }

  description(_text: string) {
    return this;
  }

  option(_flags: string, _description: string, _defaultValue?: string) {
    return this;
  }

  action(handler: (...args: any[]) => Promise<void> | void) {
    this.actionHandler = handler;
    return this;
  }

  findCommand(prefix: string): MockCommand | undefined {
    return this.children.find((child) => child.name.startsWith(prefix));
  }

  async runAction(...args: any[]) {
    if (!this.actionHandler) throw new Error(`No action registered for command '${this.name}'`);
    await this.actionHandler(...args);
  }
}

function buildCliFixture(config: { enabled: boolean }, getClient?: () => any) {
  const root = new MockCommand("root");
  const logs: LoggerEntry[] = [];

  registerComposioCli({
    program: root,
    getClient: getClient as any,
    config,
    logger: {
      info: (message: string) => logs.push({ level: "info", message }),
      warn: (message: string) => logs.push({ level: "warn", message }),
      error: (message: string) => logs.push({ level: "error", message }),
    },
  });

  const composio = root.findCommand("composio");
  if (!composio) throw new Error("composio command was not registered");
  const setup = composio.findCommand("setup");
  if (!setup) throw new Error("setup command was not registered");

  return { composio, setup, logs };
}

describe("composio setup cli", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "composio-cli-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("enables plugin loading when plugins are blocked by global/allow/deny settings", async () => {
    const { setup } = buildCliFixture({ enabled: true });
    const configPath = path.join(tmpDir, "openclaw.json");

    await writeFile(
      configPath,
      JSON.stringify(
        {
          plugins: {
            enabled: false,
            allow: ["telegram"],
            deny: ["composio", "legacy-plugin"],
            entries: {
              composio: {
                enabled: false,
                config: {},
              },
            },
          },
        },
        null,
        2
      )
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await setup.runAction({
      configPath,
      apiKey: "test-api-key",
      yes: true,
    });

    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    expect(parsed.plugins.enabled).toBe(true);
    expect(parsed.plugins.allow).toEqual(["telegram", "composio"]);
    expect(parsed.plugins.deny).toEqual(["legacy-plugin"]);
    expect(parsed.plugins.entries.composio.enabled).toBe(true);
    expect(parsed.plugins.entries.composio.config.apiKey).toBe("test-api-key");
    expect(consoleSpy).toHaveBeenCalledWith("plugins.enabled: set to true");
    expect(consoleSpy).toHaveBeenCalledWith("plugins.allow: added 'composio'");
    expect(consoleSpy).toHaveBeenCalledWith("plugins.deny: removed 'composio'");
  });

  it("returns an error when setup is run without an api key", async () => {
    const { setup, logs } = buildCliFixture({ enabled: true });
    const configPath = path.join(tmpDir, "openclaw.json");

    await setup.runAction({
      configPath,
      yes: true,
    });

    expect(logs.some((entry) => entry.message.includes("Composio API key is required"))).toBe(true);
  });

  it("normalizes allowlist entry to exact lowercase composio id", async () => {
    const { setup } = buildCliFixture({ enabled: true });
    const configPath = path.join(tmpDir, "openclaw.json");

    await writeFile(
      configPath,
      JSON.stringify(
        {
          plugins: {
            allow: ["Composio", "telegram"],
          },
        },
        null,
        2
      )
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await setup.runAction({
      configPath,
      apiKey: "test-api-key",
      yes: true,
    });

    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    expect(parsed.plugins.allow).toEqual(["telegram", "composio"]);
    expect(consoleSpy).toHaveBeenCalledWith("plugins.allow: added 'composio'");
  });

  it("requires --user-id for list command", async () => {
    const client = {
      listToolkits: vi.fn().mockResolvedValue(["gmail"]),
    };
    const { composio, logs } = buildCliFixture({ enabled: true }, () => client);
    const list = composio.findCommand("list");
    if (!list) throw new Error("list command was not registered");

    await list.runAction({});

    expect(logs.some((entry) => entry.message.includes("--user-id is required"))).toBe(true);
    expect(client.listToolkits).not.toHaveBeenCalled();
  });
});

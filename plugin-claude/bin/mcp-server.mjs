#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { request } from "./lib.mjs";
import { ensureDaemonRunning } from "./ensure-daemon.mjs";
import {
  daemonLockStatus,
  describeDaemonBuild,
  readPackagedBuild,
} from "../generated/daemon-startup.mjs";

const PLUGIN_VERSION = "0.2.0";
const REQUIRED_NODE = { major: 22, minor: 13 };
const defaultPluginRoot = fileURLToPath(new URL("../", import.meta.url));

const isNodeCompatible = (version = process.versions.node) => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > REQUIRED_NODE.major ||
    (major === REQUIRED_NODE.major && minor >= REQUIRED_NODE.minor);
};

const resolveConfigSource = (environment = process.env) => {
  const home = environment.HOME ?? homedir();
  const primary = join(home, ".config", "premind", "premind.jsonc");
  const legacy = join(home, ".config", "opencode", "premind.jsonc");
  if (existsSync(primary)) return primary;
  if (existsSync(legacy)) return `${legacy} (legacy fallback)`;
  return "schema defaults";
};

// This plain-JS runtime cannot import TypeScript, so it mirrors shared text:
// - descriptions mirror `toolGuidance` in src/shared/command-capabilities.ts
//   (compared by src/test/command-capability-contract.test.ts);
// - confirmation, refusal, and result strings mirror src/shared/global-control.ts
//   and src/shared/session-pause.ts (compared by plugin-claude/test/mcp-server.test.mjs).
export const GLOBAL_CONFIRMATION_DESCRIPTION =
  "Must be true. Set it only after the user explicitly asked to change premind polling globally for every session and project.";
export const globalControlRefusal = (action) =>
  `premind refused to ${action} polling globally: this affects every session and project. Ask the user to confirm the global ${action}, then call again with confirmGlobal: true. To change only this session, use the session ${action === "disable" ? "pause" : "resume"} tool.`;
export const globalControlResult = (disabled) =>
  `premind polling is ${disabled ? "disabled" : "enabled"} globally, across all sessions and projects.`;
export const SESSION_PAUSED_MESSAGE =
  "premind paused reminders for this session only. Subscriptions are unchanged and PR updates keep accumulating until you resume.";
export const SESSION_RESUMED_MESSAGE =
  "premind resumed reminders for this session. Subscriptions are unchanged; queued PR updates arrive at the next safe point.";

const globalControlSchema = {
  type: "object",
  properties: {
    confirmGlobal: {
      type: "boolean",
      description: GLOBAL_CONFIRMATION_DESCRIPTION,
    },
  },
  required: ["confirmGlobal"],
  additionalProperties: false,
};

const tools = [
  {
    name: "status",
    description: "Return redacted Premind aggregate status. Inspect Premind status, including pending reminder counts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "probe",
    description:
      "Diagnose Premind adapter, configuration, and daemon health. Reports Claude plugin, Node runtime, configuration, daemon, and delivery health without exposing session data.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "enable",
    description:
      "Enable Premind polling. This enables Premind GitHub polling globally, for every session and project. Call it only when the user explicitly asks for the global enable, and pass confirmGlobal: true. To resume only this session, use the session resume tool instead.",
    inputSchema: globalControlSchema,
  },
  {
    name: "disable",
    description:
      "Disable Premind polling. This disables Premind GitHub polling globally, for every session and project. Call it only when the user explicitly asks for the global disable, and pass confirmGlobal: true. To pause, mute, or quiet only this session, use the session pause tool instead.",
    inputSchema: globalControlSchema,
  },
  {
    name: "pause",
    description:
      "Pause Premind reminders for this session only. Subscriptions, watchers, and queued PR updates are kept, and the pause lasts until the session resume tool is called. Use this, not the global disable tool, to pause, mute, or quiet Premind.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "resume",
    description:
      "Resume Premind reminders for this session without changing subscriptions. Queued PR updates arrive at the next safe boundary. Use this, not the global enable tool, to undo a session pause.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "set_active_checkout",
    description:
      "Set the active Git checkout for this Claude session. Call this at the start of any PR work, including when already in the startup checkout, and again after switching branches or worktrees before creating or following a PR.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "subscribe",
    description:
      "Mandatory PR tracking: Immediately call this tool after creating, opening, discovering, or beginning work on a pull request. Do this before reporting the PR URL or status to the user. Applies after gh pr create, gh stack submit, gh stack link, or any equivalent GitHub operation.",
    inputSchema: {
      type: "object",
      properties: {
        prNumber: { type: "integer", minimum: 1 },
        repo: { type: "string" },
        writePolicy: {
          type: "string",
          enum: ["user-authorized", "observe-only"],
          description:
            "Optional; omission lets Premind verify ownership for the active checkout. Use user-authorized only for explicit user authorization, or observe-only to prevent automatic escalation.",
        },
      },
      required: ["prNumber"],
      additionalProperties: false,
    },
  },
  {
    name: "unsubscribe",
    description: "Unsubscribe the current Claude session from a pull request. Use this only when the user asks to stop tracking a pull request.",
    inputSchema: {
      type: "object",
      properties: {
        prNumber: { type: "integer", minimum: 1 },
        repo: { type: "string" },
      },
      required: ["prNumber"],
      additionalProperties: false,
    },
  },
];

const text = (value) => ({ content: [{ type: "text", text: value }] });
const getBoundClaudeSessionId = (environment = process.env) => {
  const sessionId = environment.CLAUDE_CODE_SESSION_ID;
  return typeof sessionId === "string" && sessionId ? sessionId : undefined;
};
const bindingError = () =>
  text(
    "Premind cannot verify this Claude session. Reload or restart the plugin, then try again.",
  );

export const handleMcpRequest = async (
  message,
  ipc = request,
  environment = process.env,
) => {
  if (message.method === "initialize")
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "premind", version: "0.2.0" },
    };
  if (message.method === "tools/list") return { tools };
  if (message.method !== "tools/call") throw new Error("method not found");

  const { name, arguments: args = {} } = message.params ?? {};
  if (name === "status") {
    const [disabled, status] = await Promise.all([
      ipc("getGlobalDisabled", {}),
      ipc("debugStatus", {}),
    ]);
    return text(
      JSON.stringify({
        globallyDisabled: Boolean(disabled.disabled),
        activeSessions: Number(status.activeSessions ?? 0),
        activeWatchers: Number(status.activeWatchers ?? 0),
      }),
    );
  }
  if (name === "probe") {
    const [disabledResult, statusResult] = await Promise.allSettled([
      ipc("getGlobalDisabled", {}),
      ipc("debugStatus", {}),
    ]);
    const reachable =
      disabledResult.status === "fulfilled" && statusResult.status === "fulfilled";
    const disabled =
      disabledResult.status === "fulfilled" ? disabledResult.value : undefined;
    const status =
      statusResult.status === "fulfilled" ? statusResult.value : undefined;
    return text(
      JSON.stringify({
        plugin: {
          version: PLUGIN_VERSION,
          root: environment.CLAUDE_PLUGIN_ROOT ?? defaultPluginRoot,
        },
        runtime: {
          node: process.versions.node,
          requiredNode: ">=22.13.0",
          compatible: isNodeCompatible(),
        },
        daemon: {
          reachable,
          protocolVersion: status?.daemon?.protocolVersion ?? null,
          globallyDisabled: disabled ? Boolean(disabled.disabled) : null,
          ...(reachable ? {} : { error: "Premind daemon is unavailable." }),
          lock: daemonLockStatus(environment.PREMIND_STATE_DIR),
          build: await describeDaemonBuild({
            host: "claude",
            build: readPackagedBuild(),
            ...(environment.PREMIND_SOCKET_PATH
              ? { socketPath: environment.PREMIND_SOCKET_PATH }
              : {}),
            ...(environment.PREMIND_STATE_DIR
              ? { stateDir: environment.PREMIND_STATE_DIR }
              : {}),
          }),
        },
        configSource: resolveConfigSource(environment),
        delivery:
          "Stop-boundary only; inactive Claude sessions are not woken in v0.2",
      }),
    );
  }
  if (name === "enable" || name === "disable") {
    if (args.confirmGlobal !== true) {
      return { ...text(globalControlRefusal(name)), isError: true };
    }
    const result = await ipc("setGlobalDisabled", {
      disabled: name === "disable",
    });
    return text(globalControlResult(Boolean(result.disabled)));
  }

  const sessionId = getBoundClaudeSessionId(environment);
  if (!sessionId) return bindingError();
  if (name === "pause" || name === "resume") {
    await ipc(name === "pause" ? "pauseSession" : "resumeSession", { sessionId });
    return text(name === "pause" ? SESSION_PAUSED_MESSAGE : SESSION_RESUMED_MESSAGE);
  }
  if (name === "set_active_checkout") {
    const result = await ipc("activateWorktree", {
      sessionId,
      path: args.path,
    });
    return text(
      `Premind set the active checkout for this Claude session to ${result.binding.repo}.`,
    );
  }
  if (name === "subscribe" || name === "unsubscribe") {
    const result = await ipc(
      name === "subscribe" ? "subscribe" : "unsubscribe",
      {
        sessionId,
        prNumber: args.prNumber,
        ...(typeof args.repo === "string" ? { repo: args.repo } : {}),
        ...(name === "subscribe" && typeof args.writePolicy === "string"
          ? { writePolicy: args.writePolicy }
          : {}),
      },
    );
    return text(
      name === "subscribe"
        ? `Premind subscribed this Claude session to ${result.subscription.repo}#${result.subscription.prNumber} with write policy ${result.subscription.writePolicy ?? "observe-only"}.`
        : `Premind unsubscribed this Claude session: ${result.unsubscribed ? "done" : "no active subscription"}.`,
    );
  }
  throw new Error("tool not found");
};

const reply = (id, result, error) =>
  process.stdout.write(
    `${JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result })}\n`,
  );

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await ensureDaemonRunning();
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  input.on("line", async (line) => {
    try {
      const message = JSON.parse(line);
      const result = await handleMcpRequest(message);
      if (message.id !== undefined) reply(message.id, result);
    } catch (error) {
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined)
          reply(message.id, undefined, {
            code: -32000,
            message:
              error instanceof Error ? error.message : "Premind request failed",
          });
      } catch {}
    }
  });
}

#!/usr/bin/env node
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { request } from "./lib.mjs";
import { ensureDaemonRunning } from "./ensure-daemon.mjs";

const tools = [
  {
    name: "status",
    description: "Return redacted Premind aggregate status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "probe",
    description: "Check whether the Premind daemon is reachable without exposing session data.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "enable",
    description: "Enable Premind polling globally across every active Premind session and project.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "disable",
    description: "Disable Premind polling globally across every active Premind session and project.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "activate_worktree",
    description: "Bind the current Claude session to a worktree path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "subscribe",
    description: "Subscribe the current Claude session to a pull request.",
    inputSchema: {
      type: "object",
      properties: { prNumber: { type: "integer", minimum: 1 }, repo: { type: "string" } },
      required: ["prNumber"],
      additionalProperties: false,
    },
  },
  {
    name: "unsubscribe",
    description: "Unsubscribe the current Claude session from a pull request.",
    inputSchema: {
      type: "object",
      properties: { prNumber: { type: "integer", minimum: 1 }, repo: { type: "string" } },
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
  text("Premind cannot verify this Claude session. Reload or restart the plugin, then try again.");

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
    const disabled = await ipc("getGlobalDisabled", {});
    return text(
      JSON.stringify({
        reachable: true,
        globallyDisabled: Boolean(disabled.disabled),
        delivery: "Stop-boundary only; inactive Claude sessions are not woken in v0.2",
      }),
    );
  }
  if (name === "enable" || name === "disable") {
    const result = await ipc("setGlobalDisabled", { disabled: name === "disable" });
    return text(`Premind polling is ${result.disabled ? "disabled" : "enabled"} globally.`);
  }

  const sessionId = getBoundClaudeSessionId(environment);
  if (!sessionId) return bindingError();
  if (name === "activate_worktree") {
    const result = await ipc("activateWorktree", { sessionId, path: args.path });
    return text(`Premind is watching ${result.binding.repo} from this Claude session.`);
  }
  if (name === "subscribe" || name === "unsubscribe") {
    const result = await ipc(name === "subscribe" ? "subscribe" : "unsubscribe", {
      sessionId,
      prNumber: args.prNumber,
      ...(typeof args.repo === "string" ? { repo: args.repo } : {}),
    });
    return text(
      name === "subscribe"
        ? `Premind subscribed this Claude session to ${result.subscription.repo}#${result.subscription.prNumber}.`
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
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
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
            message: error instanceof Error ? error.message : "Premind request failed",
          });
      } catch {}
    }
  });
}

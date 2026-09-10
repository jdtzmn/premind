import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const socketPath =
  process.env.PREMIND_SOCKET_PATH ?? path.join(os.tmpdir(), "premind.sock");
const protocolVersion = 1;
const firstReminderPrefix =
  "[premind] Claude Code reminders arrive after a turn completes; Premind cannot wake an otherwise inactive session in v0.2.\n\n";

export const readHookEvent = async (input = process.stdin) => {
  let body = "";
  for await (const chunk of input) body += chunk;
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

export const IPC_REQUEST_TIMEOUT_MS = 2_000;

export const request = (
  type,
  payload,
  socket = socketPath,
  timeoutMs = IPC_REQUEST_TIMEOUT_MS,
) =>
  new Promise((resolve, reject) => {
    const connection = net.createConnection(socket);
    let buffer = "";
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      connection.setTimeout(0);
      if (error) {
        connection.destroy();
        reject(error);
      } else {
        resolve(result);
      }
    };

    connection.setEncoding("utf8");
    connection.setTimeout(timeoutMs);
    connection.once("error", (error) => finish(error));
    connection.once("timeout", () =>
      finish(new Error(`premind daemon request timed out after ${timeoutMs}ms`)),
    );
    connection.once("end", () =>
      finish(new Error("premind daemon closed the connection without responding")),
    );
    connection.once("close", () =>
      finish(new Error("premind daemon closed the connection without responding")),
    );
    connection.once("connect", () =>
      connection.write(
        `${JSON.stringify({ type, protocolVersion, payload })}\n`,
      ),
    );
    connection.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      connection.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok)
          throw new Error(
            `${response.error?.code ?? "IPC_ERROR"}: ${response.error?.message ?? "request failed"}`,
          );
        finish(undefined, response.result);
      } catch (error) {
        finish(error);
      }
    });
  });
const repositoryFromRemote = (remote) => {
  const match = remote
    .trim()
    .match(/(?:github\.com[/:])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
};

export const getGitContext = (cwd) => {
  if (typeof cwd !== "string" || !cwd) return undefined;
  const run = (args) =>
    spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 1_000,
    });
  const branch = run(["branch", "--show-current"]);
  const remote = run(["config", "--get", "remote.origin.url"]);
  const repo = repositoryFromRemote(remote.stdout ?? "");
  const name = branch.stdout?.trim();
  return repo && name ? { repo, branch: name } : undefined;
};

export const hookOutput = (text) => ({
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext: text,
  },
});

export const getBoundClaudeSessionId = (event, environment = process.env) => {
  const sessionId = event?.session_id;
  const environmentSessionId = environment.CLAUDE_CODE_SESSION_ID;
  if (typeof sessionId !== "string" || !sessionId) return undefined;
  if (
    typeof environmentSessionId === "string" &&
    environmentSessionId &&
    environmentSessionId !== sessionId
  )
    return undefined;
  return sessionId;
};

export const handleHook = async (
  eventName,
  event,
  ipc = request,
  environment = process.env,
) => {
  const sessionId = getBoundClaudeSessionId(event, environment);
  if (!sessionId) return undefined;

  if (eventName === "SessionEnd") {
    await ipc("suspendClaudeSession", { sessionId });
    return undefined;
  }

  if (eventName === "Stop") {
    await ipc("touchClaudeSession", { sessionId, busyState: "idle" });
    if (event?.stop_hook_active) {
      await ipc("confirmClaudeHandoff", { sessionId });
      return undefined;
    }
    const claimed = await ipc("claimClaudeReminder", { sessionId });
    if (!claimed?.batch?.reminderText) return undefined;
    return hookOutput(`${firstReminderPrefix}${claimed.batch.reminderText}`);
  }

  if (eventName === "UserPromptSubmit") {
    await ipc("touchClaudeSession", { sessionId, busyState: "busy" });
    return undefined;
  }

  const git = getGitContext(event?.cwd);
  if (!git) return undefined;
  await ipc("registerClaudeSession", {
    sessionId,
    hostSessionId: sessionId,
    ...git,
    busyState: "idle",
  });
  return undefined;
};

export const runHook = async (eventName, ensureDaemon) => {
  try {
    if (ensureDaemon) await ensureDaemon();
    const output = await handleHook(eventName, await readHookEvent());
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    // Hooks fail open: a temporary daemon or Git failure must never block Claude.
  }
};

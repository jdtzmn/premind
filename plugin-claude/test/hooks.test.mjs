import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createClaudeHandoffStore,
  getBoundClaudeSessionId,
  handleHook,
  request,
} from "../bin/lib.mjs";

const createMemoryHandoffs = () => {
  const bySession = new Map();
  return {
    async replace(sessionId, entry) {
      bySession.set(sessionId, entry);
    },
    async peek(sessionId) {
      return bySession.get(sessionId);
    },
    async remove(sessionId, handoffId) {
      if (bySession.get(sessionId)?.handoffId === handoffId) {
        bySession.delete(sessionId);
      }
    },
    async clear(sessionId) {
      bySession.delete(sessionId);
    },
  };
};

test("Claude handoff generations persist across hook processes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "premind-handoffs-"));
  try {
    const environment = { PREMIND_CLAUDE_HANDOFF_DIR: directory };
    const firstProcess = createClaudeHandoffStore(environment);
    await firstProcess.replace("claude-1", {
      handoffId: "00000000-0000-4000-8000-000000000001",
      mode: "bundle",
    });

    const nextProcess = createClaudeHandoffStore(environment);
    assert.deepEqual(await nextProcess.peek("claude-1"), {
      handoffId: "00000000-0000-4000-8000-000000000001",
      mode: "bundle",
    });
    await nextProcess.remove(
      "claude-1",
      "00000000-0000-4000-8000-000000000001",
    );
    assert.equal(await firstProcess.peek("claude-1"), undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("request rejects when a connected daemon does not respond", async () => {
  const socket = path.join(os.tmpdir(), `p-${process.pid}-${Date.now()}.sock`);
  const server = net.createServer((connection) => connection.resume());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });

  try {
    await assert.rejects(
      request("debugStatus", {}, socket, 20),
      /timed out after 20ms/,
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("request deadline is not extended by an incomplete response", async () => {
  const socket = path.join(os.tmpdir(), `d-${process.pid}-${Date.now()}.sock`);
  const server = net.createServer((connection) => {
    connection.resume();
    const stopDripping = () => clearInterval(drip);
    const drip = setInterval(() => {
      if (!connection.destroyed && connection.writable) connection.write("{");
    }, 5);
    connection.once("error", stopDripping);
    connection.once("close", stopDripping);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });

  try {
    await assert.rejects(
      request("debugStatus", {}, socket, 30),
      /timed out after 30ms/,
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});


test("Stop atomically claims one reminder bundle and returns it without confirming", async () => {
  const calls = [];
  const handoffs = createMemoryHandoffs();
  const output = await handleHook(
    "Stop",
    { session_id: "claude-1" },
    async (type, payload) => {
      calls.push({ type, payload });
      if (type === "claimReminderBundle")
        return {
          bundle: {
            handoffId: "00000000-0000-4000-8000-000000000001",
            batches: [
              { reminderText: "First review changed" },
              { reminderText: "Second review changed" },
            ],
          },
        };
      return { updated: true };
    },
    {},
    handoffs,
  );
  assert.deepEqual(
    calls.map(({ type }) => type),
    ["touchClaudeSession", "claimReminderBundle"],
  );
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /cannot wake an otherwise inactive session/i,
  );
  assert.match(output.hookSpecificOutput.additionalContext, /First review changed/);
  assert.match(output.hookSpecificOutput.additionalContext, /Second review changed/);
});

test("post-continuation Stop confirms only the prior handoff", async () => {
  const calls = [];
  const handoffs = createMemoryHandoffs();
  await handoffs.replace("claude-1", {
    handoffId: "00000000-0000-4000-8000-000000000001",
    mode: "bundle",
  });
  const output = await handleHook(
    "Stop",
    { session_id: "claude-1", stop_hook_active: true },
    async (type, payload) => {
      calls.push({ type, payload });
      return { confirmed: true };
    },
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
    handoffs,
  );
  assert.equal(output, undefined);
  assert.deepEqual(calls, [
    {
      type: "touchClaudeSession",
      payload: { sessionId: "claude-1", busyState: "idle" },
    },
    {
      type: "ackReminderBundle",
      payload: {
        sessionId: "claude-1",
        handoffId: "00000000-0000-4000-8000-000000000001",
        state: "confirmed",
      },
    },
  ]);
});

test("a new claim replaces an abandoned Claude handoff generation", async () => {
  const calls = [];
  const handoffs = createMemoryHandoffs();
  await handoffs.replace("claude-1", {
    handoffId: "00000000-0000-4000-8000-000000000001",
    mode: "bundle",
  });
  await handoffs.replace("claude-1", {
    handoffId: "00000000-0000-4000-8000-000000000002",
    mode: "bundle",
  });

  await handleHook(
    "Stop",
    { session_id: "claude-1", stop_hook_active: true },
    async (type, payload) => {
      calls.push({ type, payload });
      return { acknowledged: 1 };
    },
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
    handoffs,
  );

  assert.deepEqual(calls.at(-1), {
    type: "ackReminderBundle",
    payload: {
      sessionId: "claude-1",
      handoffId: "00000000-0000-4000-8000-000000000002",
      state: "confirmed",
    },
  });
  assert.equal(await handoffs.peek("claude-1"), undefined);
});

test("Claude falls back to legacy claim and confirmation against an older daemon", async () => {
  const calls = [];
  const handoffs = createMemoryHandoffs();
  const ipc = async (type, payload) => {
    calls.push({ type, payload });
    if (type === "claimReminderBundle") {
      throw new Error("BAD_REQUEST: unsupported request type");
    }
    if (type === "claimClaudeReminder") {
      return { batch: { reminderText: "Legacy reminder" } };
    }
    return { confirmed: true };
  };

  const output = await handleHook(
    "Stop",
    { session_id: "claude-1" },
    ipc,
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
    handoffs,
  );
  assert.match(output.hookSpecificOutput.additionalContext, /Legacy reminder/);

  await handleHook(
    "Stop",
    { session_id: "claude-1", stop_hook_active: true },
    ipc,
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
    handoffs,
  );
  assert.deepEqual(
    calls.map(({ type }) => type),
    [
      "touchClaudeSession",
      "claimReminderBundle",
      "claimClaudeReminder",
      "touchClaudeSession",
      "confirmClaudeHandoff",
    ],
  );
});

test("Claude adapts the previous protocol-v1 bundle response", async () => {
  const calls = [];
  const handoffs = createMemoryHandoffs();
  const ipc = async (type, payload) => {
    calls.push({ type, payload });
    if (type === "claimReminderBundle") {
      return {
        batches: [
          { reminderText: "First legacy bundle reminder" },
          { reminderText: "Second legacy bundle reminder" },
        ],
      };
    }
    return { acknowledged: 2 };
  };

  const output = await handleHook(
    "Stop",
    { session_id: "claude-1" },
    ipc,
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
    handoffs,
  );
  assert.match(output.hookSpecificOutput.additionalContext, /First legacy bundle/);
  assert.match(output.hookSpecificOutput.additionalContext, /Second legacy bundle/);

  await handleHook(
    "Stop",
    { session_id: "claude-1", stop_hook_active: true },
    ipc,
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
    handoffs,
  );
  assert.deepEqual(calls.at(-1), {
    type: "ackReminderBundle",
    payload: { sessionId: "claude-1", state: "confirmed" },
  });
});

test("a pre-token continuation confirms the previous bundle shape", async () => {
  const calls = [];
  await handleHook(
    "Stop",
    { session_id: "claude-1", stop_hook_active: true },
    async (type, payload) => {
      calls.push({ type, payload });
      return { acknowledged: 2 };
    },
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
    createMemoryHandoffs(),
  );
  assert.deepEqual(calls.at(-1), {
    type: "ackReminderBundle",
    payload: { sessionId: "claude-1", state: "confirmed" },
  });
});

test("UserPromptSubmit marks the environment-bound Claude session busy", async () => {
  const calls = [];
  await handleHook(
    "UserPromptSubmit",
    { session_id: "claude-1" },
    async (type, payload) => {
      calls.push({ type, payload });
      return { updated: true };
    },
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
  );
  assert.deepEqual(calls, [
    {
      type: "touchClaudeSession",
      payload: { sessionId: "claude-1", busyState: "busy" },
    },
  ]);
});

test("hook binding fails closed when CLAUDE_CODE_SESSION_ID mismatches event.session_id", async () => {
  const calls = [];
  const output = await handleHook(
    "Stop",
    { session_id: "claude-hook" },
    async (type, payload) => calls.push({ type, payload }),
    { CLAUDE_CODE_SESSION_ID: "claude-mcp" },
  );
  assert.equal(output, undefined);
  assert.deepEqual(calls, []);
  assert.equal(
    getBoundClaudeSessionId(
      { session_id: "claude-hook" },
      { CLAUDE_CODE_SESSION_ID: "claude-mcp" },
    ),
    undefined,
  );
});

test("SessionEnd suspends the durable environment-bound Claude session", async () => {
  const calls = [];
  await handleHook(
    "SessionEnd",
    { session_id: "claude-1" },
    async (type, payload) => {
      calls.push({ type, payload });
      return {};
    },
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
  );
  assert.deepEqual(calls, [
    { type: "suspendClaudeSession", payload: { sessionId: "claude-1" } },
  ]);
});

test("SessionEnd clears its handoff when daemon suspension fails", async () => {
  const handoffs = createMemoryHandoffs();
  await handoffs.replace("claude-1", {
    handoffId: "00000000-0000-4000-8000-000000000001",
    mode: "bundle",
  });

  await assert.rejects(
    handleHook(
      "SessionEnd",
      { session_id: "claude-1" },
      async () => {
        throw new Error("daemon unavailable");
      },
      { CLAUDE_CODE_SESSION_ID: "claude-1" },
      handoffs,
    ),
    /daemon unavailable/,
  );
  assert.equal(await handoffs.peek("claude-1"), undefined);
});

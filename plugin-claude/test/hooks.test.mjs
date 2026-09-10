import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { getBoundClaudeSessionId, handleHook, request } from "../bin/lib.mjs";

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
    const drip = setInterval(() => connection.write("{"), 5);
    connection.once("close", () => clearInterval(drip));
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


test("Stop atomically claims a reminder and returns additionalContext without confirming it", async () => {
  const calls = [];
  const output = await handleHook(
    "Stop",
    { session_id: "claude-1" },
    async (type, payload) => {
      calls.push({ type, payload });
      if (type === "claimClaudeReminder")
        return { batch: { reminderText: "Review changed" } };
      return { updated: true };
    },
    {},
  );
  assert.deepEqual(
    calls.map(({ type }) => type),
    ["touchClaudeSession", "claimClaudeReminder"],
  );
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /cannot wake an otherwise inactive session/i,
  );
  assert.match(output.hookSpecificOutput.additionalContext, /Review changed/);
});

test("post-continuation Stop confirms only the prior handoff", async () => {
  const calls = [];
  const output = await handleHook(
    "Stop",
    { session_id: "claude-1", stop_hook_active: true },
    async (type, payload) => {
      calls.push({ type, payload });
      return { confirmed: true };
    },
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
  );
  assert.equal(output, undefined);
  assert.deepEqual(calls, [
    {
      type: "touchClaudeSession",
      payload: { sessionId: "claude-1", busyState: "idle" },
    },
    { type: "confirmClaudeHandoff", payload: { sessionId: "claude-1" } },
  ]);
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

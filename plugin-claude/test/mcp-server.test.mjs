import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcpRequest } from "../bin/mcp-server.mjs";

test("status redacts session records", async () => {
  const result = await handleMcpRequest(
    { method: "tools/call", params: { name: "status" } },
    async (type) => {
      if (type === "getGlobalDisabled") return { disabled: false };
      return {
        activeSessions: 2,
        activeWatchers: 1,
        sessions: [{ sessionId: "secret", repo: "private/repo" }],
      };
    },
    {},
  );
  const value = result.content[0].text;
  assert.match(value, /activeSessions/);
  assert.doesNotMatch(value, /secret|private\/repo/);
});

test("global controls are model-callable and describe their daemon-wide effect", async () => {
  const calls = [];
  const result = await handleMcpRequest(
    { method: "tools/call", params: { name: "disable", arguments: {} } },
    async (type, payload) => {
      calls.push({ type, payload });
      return { disabled: true };
    },
    {},
  );
  assert.match(result.content[0].text, /disabled globally/i);
  assert.deepEqual(calls, [
    { type: "setGlobalDisabled", payload: { disabled: true } },
  ]);
});

test("session-scoped tools derive the Claude ID from the environment", async () => {
  const calls = [];
  const result = await handleMcpRequest(
    {
      method: "tools/call",
      params: {
        name: "subscribe",
        arguments: { prNumber: 42, repo: "acme/repo" },
      },
    },
    async (type, payload) => {
      calls.push({ type, payload });
      return { subscription: { repo: "acme/repo", prNumber: 42 } };
    },
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
  );
  assert.match(result.content[0].text, /acme\/repo#42/);
  assert.deepEqual(calls, [
    {
      type: "subscribe",
      payload: { sessionId: "claude-1", prNumber: 42, repo: "acme/repo" },
    },
  ]);
});

test("session-scoped tools fail closed without CLAUDE_CODE_SESSION_ID", async () => {
  const calls = [];
  const result = await handleMcpRequest(
    {
      method: "tools/call",
      params: { name: "activate_worktree", arguments: { path: "/repo" } },
    },
    async (type, payload) => calls.push({ type, payload }),
    {},
  );
  assert.match(result.content[0].text, /cannot verify/i);
  assert.deepEqual(calls, []);
});

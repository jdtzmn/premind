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

test("lists set_active_checkout without the old worktree tool", async () => {
  const result = await handleMcpRequest({ method: "tools/list" });
  const names = result.tools.map((tool) => tool.name);
  assert.ok(names.includes("set_active_checkout"));
  assert.ok(!names.includes("activate_worktree"));
  const activeCheckout = result.tools.find(
    (tool) => tool.name === "set_active_checkout",
  );
  assert.match(activeCheckout.description, /start of any PR work/i);
  assert.match(activeCheckout.description, /switching branches/i);
});

test("lists subscribe with mandatory PR tracking guidance", async () => {
  const result = await handleMcpRequest({ method: "tools/list" });
  const subscribe = result.tools.find((tool) => tool.name === "subscribe");
  assert.equal(
    subscribe.description,
    "Mandatory PR tracking: Immediately call this tool after creating, opening, discovering, or beginning work on a pull request. Do this before reporting the PR URL or status to the user. Applies after gh pr create, gh stack submit, gh stack link, or any equivalent GitHub operation.",
  );
});

test("set_active_checkout binds the environment-derived Claude session", async () => {
  const calls = [];
  const result = await handleMcpRequest(
    {
      method: "tools/call",
      params: {
        name: "set_active_checkout",
        arguments: { path: "/repo" },
      },
    },
    async (type, payload) => {
      calls.push({ type, payload });
      return { binding: { repo: "acme/repo" } };
    },
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
  );
  assert.match(result.content[0].text, /active checkout/i);
  assert.deepEqual(calls, [
    {
      type: "activateWorktree",
      payload: { sessionId: "claude-1", path: "/repo" },
    },
  ]);
});

test("session-scoped tools fail closed without CLAUDE_CODE_SESSION_ID", async () => {
  const calls = [];
  const result = await handleMcpRequest(
    {
      method: "tools/call",
      params: { name: "set_active_checkout", arguments: { path: "/repo" } },
    },
    async (type, payload) => calls.push({ type, payload }),
    {},
  );
  assert.match(result.content[0].text, /cannot verify/i);
  assert.deepEqual(calls, []);
});

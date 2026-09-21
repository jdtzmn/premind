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
test("probe reports runtime, plugin, config, daemon, and delivery health", async () => {
  const result = await handleMcpRequest(
    { method: "tools/call", params: { name: "probe" } },
    async (type) =>
      type === "getGlobalDisabled"
        ? { disabled: false }
        : { daemon: { protocolVersion: 1 }, sessions: [{ sessionId: "secret" }] },
    {
      HOME: "/definitely-missing-premind-home",
      CLAUDE_PLUGIN_ROOT: "/tmp/premind-plugin",
    },
  );
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(value.plugin, { version: "0.2.0", root: "/tmp/premind-plugin" });
  assert.equal(value.runtime.requiredNode, ">=22.13.0");
  assert.equal(value.runtime.compatible, true);
  assert.deepEqual(value.daemon, {
    reachable: true,
    protocolVersion: 1,
    globallyDisabled: false,
  });
  assert.equal(value.configSource, "schema defaults");
  assert.match(value.delivery, /Stop-boundary only/);
  assert.doesNotMatch(result.content[0].text, /secret/);
});

test("probe reports a redacted diagnostic when the daemon is unavailable", async () => {
  const result = await handleMcpRequest(
    { method: "tools/call", params: { name: "probe" } },
    async () => {
      throw new Error("private/session/path");
    },
    { HOME: "/definitely-missing-premind-home" },
  );
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(value.daemon, {
    reachable: false,
    protocolVersion: null,
    globallyDisabled: null,
    error: "Premind daemon is unavailable.",
  });
  assert.equal(value.runtime.requiredNode, ">=22.13.0");
  assert.equal(value.configSource, "schema defaults");
  assert.doesNotMatch(result.content[0].text, /private\/session\/path/);
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

test("subscribe forwards an explicit write policy from the Claude session", async () => {
  const calls = [];
  const result = await handleMcpRequest(
    {
      method: "tools/call",
      params: {
        name: "subscribe",
        arguments: {
          prNumber: 42,
          repo: "acme/repo",
          writePolicy: "user-authorized",
        },
      },
    },
    async (type, payload) => {
      calls.push({ type, payload });
      return {
        subscription: {
          repo: "acme/repo",
          prNumber: 42,
          writePolicy: "user-authorized",
        },
      };
    },
    { CLAUDE_CODE_SESSION_ID: "claude-1" },
  );
  assert.match(result.content[0].text, /acme\/repo#42/);
  assert.match(result.content[0].text, /write policy user-authorized/);
  assert.deepEqual(calls, [
    {
      type: "subscribe",
      payload: {
        sessionId: "claude-1",
        prNumber: 42,
        repo: "acme/repo",
        writePolicy: "user-authorized",
      },
    },
  ]);
});

test("subscribe omits write policy by default and accepts legacy responses", async () => {
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
  assert.match(result.content[0].text, /write policy observe-only/);
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
  assert.deepEqual(subscribe.inputSchema.properties.writePolicy, {
    type: "string",
    enum: ["user-authorized", "observe-only"],
    description:
      "Optional; omission lets Premind verify ownership for the active checkout. Use user-authorized only for explicit user authorization, or observe-only to prevent automatic escalation.",
  });
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

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DebugStatusResponse } from "./schema.ts";
import { renderCurrentStatus } from "./status-view.ts";

const status: DebugStatusResponse = {
  daemon: { protocolVersion: 1, heartbeatMs: 10_000, leaseTtlMs: 30_000, idleShutdownGraceMs: 15_000 },
  globallyDisabled: false,
  activeClients: 2,
  activeSessions: 2,
  closedSessions: 0,
  activeWatchers: 1,
  lastReapAt: null,
  lastReapCount: 0,
  sessions: [
    {
      sessionId: "this-session", host: "pi", repo: "acme/repo", branch: "feature/status", prNumber: 42,
      status: "active", busyState: "idle", pendingReminderCount: 0,
      subscriptions: [
        { repo: "acme/repo", prNumber: 99, source: "manual", writePolicy: "observe-only", state: "active", pendingEventCount: 0 },
        { repo: "acme/repo", prNumber: 42, source: "automatic", writePolicy: "owned-active", state: "active", pendingEventCount: 0 },
        { repo: "elsewhere/other", prNumber: 5, source: "manual", writePolicy: "observe-only", state: "active", pendingEventCount: 0 },
        { repo: "acme/repo", prNumber: 17, source: "manual", writePolicy: "observe-only", state: "unsubscribed", pendingEventCount: 0 },
      ],
    },
    { sessionId: "other-session", host: "pi", repo: "secret/repo", branch: "private", prNumber: 7,
      status: "active", busyState: "busy", pendingReminderCount: 4,
      subscriptions: [{ repo: "secret/repo", prNumber: 7, source: "automatic", writePolicy: "owned-active", state: "active", pendingEventCount: 4 }],
    },
  ],
};

test("status shows only the current session's active watched PRs with links", () => {
  const rendered = renderCurrentStatus(status, "this-session");
  assert.match(rendered, /premind · running · polling on · 1 watcher/);
  assert.match(rendered, /acme\/repo @ feature\/status · active\/idle · 0 pending/);
  assert.match(rendered, /Watching 3 PRs · branch PR #42/);
  assert.ok(rendered.indexOf("#42") < rendered.indexOf("#99"));
  assert.match(rendered, /#42 · \? status unknown — https:\/\/github.com\/acme\/repo\/pull\/42/);
  assert.match(rendered, /elsewhere\/other#5 · \? status unknown — https:\/\/github.com\/elsewhere\/other\/pull\/5/);
  assert.match(rendered, /1 other session: \/premind:debug-status/);
  assert.doesNotMatch(rendered, /secret|private|#17/);
});

test("missing current session does not guess from another session", () => {
  const rendered = renderCurrentStatus(status, "missing");
  assert.match(rendered, /no premind session attached/);
  assert.match(rendered, /2 other sessions/);
  assert.doesNotMatch(rendered, /secret\/repo|acme\/repo/);
});

test("disabled polling and unsubscribed branch PR remain explicit", () => {
  const rendered = renderCurrentStatus({ ...status, globallyDisabled: true, sessions: [{ ...status.sessions[0]!, subscriptions: [] }] }, "this-session");
  assert.match(rendered, /polling off.*\/premind:enable/);
  assert.match(rendered, /Watching 0 PRs · branch PR #42 \(not watched\)/);
  assert.doesNotMatch(rendered, /\/pull\/42/);
});

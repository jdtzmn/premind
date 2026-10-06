import assert from "node:assert/strict";
import { test } from "node:test";
import type { DebugStatusResponse } from "./schema.ts";
import { getCurrentStatusLines, renderCurrentStatus } from "./status-view.ts";

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

test("status exposes structured PR lines for interactive renderers", () => {
  const lines = getCurrentStatusLines(status, "this-session");
  const prLines = lines.filter((line) => typeof line !== "string");
  assert.deepEqual(prLines.map(({ prefix, signal, link }) => ({ prefix, signal: signal.text, link })), [
    { prefix: "  #42 · ", signal: "? status unknown", link: "https://github.com/acme/repo/pull/42" },
    { prefix: "  #99 · ", signal: "? status unknown", link: "https://github.com/acme/repo/pull/99" },
    { prefix: "  elsewhere/other#5 · ", signal: "? status unknown", link: "https://github.com/elsewhere/other/pull/5" },
  ]);
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

test("cached signals are ordered, styled only through the interactive hook, with safe raw links", () => {
  const fixture = structuredClone(status);
  const [session] = fixture.sessions;
  const [other, branch, foreign] = session!.subscriptions!;
  const now = 1_000_000;
  const base = { state: "OPEN", isDraft: false, reviewDecision: "APPROVED", fetchedAt: now, checks: [{ state: "pass" }] };
  branch!.snapshot = { ...base, title: "Branch\nPR", url: "https://github.com/acme/repo/pull/42", mergeStateStatus: "CLEAN" };
  other!.snapshot = { ...base, title: "Broken", url: "https://github.com/acme/repo/pull/99", mergeStateStatus: "DIRTY", checks: [{ state: "fail" }] };
  foreign!.snapshot = { ...base, title: "Other", url: "https://evil.example/pull/5", mergeStateStatus: "CLEAN" };
  const plain = renderCurrentStatus(fixture, "this-session", { now });
  assert.ok(plain.indexOf("#42 Branch") < plain.indexOf("#99 Broken"));
  assert.match(plain, /#42 Branch PR · ✓ ready to merge — https:\/\/github.com\/acme\/repo\/pull\/42/);
  assert.match(plain, /#99 Broken · ✗ conflicts, CI failing/);
  assert.match(plain, /elsewhere\/other#5 Other · ✓ ready to merge — https:\/\/github.com\/elsewhere\/other\/pull\/5/);
  assert.doesNotMatch(plain, /evil\.example|\u001b/);
  const styled = renderCurrentStatus(fixture, "this-session", { now, style: (text, kind) => `<${kind}>${text}</${kind}>` });
  assert.match(styled, /<error>✗ conflicts, CI failing<\/error>/);
  assert.match(styled, /<success>✓ ready to merge<\/success>/);
  assert.match(styled, /<success>✓ ready to merge<\/success> — https:\/\/github.com\/acme\/repo\/pull\/42/);
});

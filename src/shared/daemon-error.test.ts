import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonResponseError, isDaemonError, normalizeDaemonError } from "./daemon-error.ts";

test("daemon response errors preserve code, raw daemon message, and display compatibility", () => {
  const error = new DaemonResponseError("SESSION_NOT_FOUND", "Unknown session");
  assert.equal(error.domain, "daemon");
  assert.equal(error.code, "SESSION_NOT_FOUND");
  assert.equal(error.daemonMessage, "Unknown session");
  assert.equal(error.message, "SESSION_NOT_FOUND: Unknown session");
  assert.equal(normalizeDaemonError(error), error);
  assert.equal(isDaemonError(error, "SESSION_NOT_FOUND"), true);
  assert.equal(isDaemonError(error, "SESSION_BUSY"), false);
});

test("normalizes anchored legacy errors and the Claude structural shape at one seam", () => {
  assert.equal(isDaemonError(new Error("SESSION_NOT_FOUND: Unknown session"), "SESSION_NOT_FOUND"), true);
  const error = Object.assign(new Error("SESSION_BUSY: Busy"), {
    domain: "daemon", code: "SESSION_BUSY", daemonMessage: "Busy",
  });
  assert.equal(normalizeDaemonError(error)?.daemonMessage, "Busy");
  assert.equal(isDaemonError(error, "SESSION_BUSY"), true);
});

test("never interprets transport, unstructured, or embedded text as daemon errors", () => {
  for (const error of [
    Object.assign(new Error("SESSION_NOT_FOUND: socket failure"), { domain: "transport" }),
    Object.assign(new Error("SESSION_NOT_FOUND: socket failure"), { code: "ENOENT" }),
    new Error("wrapped SESSION_NOT_FOUND: Unknown session"),
    new Error("SESSION_NOT_FOUND:no separator"),
    new Error("session_not_found: lower case"),
    "SESSION_NOT_FOUND: not an Error",
    { domain: "daemon", code: "SESSION_NOT_FOUND" },
    null,
  ]) {
    assert.equal(normalizeDaemonError(error), null);
    assert.equal(isDaemonError(error), false);
  }
});

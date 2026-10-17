import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionRecovery } from "./session-recovery.ts";
import { DaemonResponseError } from "./daemon-error.ts";

const missing = () => new Error("SESSION_NOT_FOUND: Unknown session: test-session");

test("a live session repairs missing registration and replays a control once", async () => {
  let attached = false;
  let attachments = 0;
  let attempts = 0;
  const recovery = createSessionRecovery({
    isCurrent: () => true,
    reattach: async () => { attached = true; attachments++; },
  });
  const value = await recovery.run("subscribe", async () => {
    attempts++;
    if (!attached) throw missing();
    return "subscribed";
  });
  assert.equal(value, "subscribed");
  assert.equal(attempts, 2);
  assert.equal(attachments, 1);
});

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test("concurrent and late missing-registration failures share one repair", async () => {
  const attached = deferred();
  const attaching = deferred();
  const releaseLateFailure = deferred();
  let attachments = 0;
  let current = false;
  const recovery = createSessionRecovery({
    isCurrent: () => true,
    reattach: async () => {
      attachments++;
      attaching.resolve();
      await attached.promise;
      current = true;
    },
  });
  let lateAttempts = 0;
  const late = recovery.run("subscribe", async () => {
    if (lateAttempts++ === 0) {
      await releaseLateFailure.promise;
      throw missing();
    }
    return "late";
  });
  const action = async () => {
    if (!current) throw missing();
    return "ready";
  };
  const first = recovery.run("subscribe", action);
  const second = recovery.run("pauseSession", action);
  await attaching.promise;
  assert.equal(attachments, 1);
  attached.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["ready", "ready"]);
  releaseLateFailure.resolve();
  assert.equal(await late, "late");
  assert.equal(attachments, 1);
});

test("a failed replay terminates without recursive attachment", async () => {
  let attachments = 0;
  let attempts = 0;
  const recovery = createSessionRecovery({
    isCurrent: () => true,
    reattach: async () => { attachments++; },
  });
  await assert.rejects(recovery.run("subscribe", async () => {
    attempts++;
    throw missing();
  }), /SESSION_NOT_FOUND/);
  assert.equal(attempts, 2);
  assert.equal(attachments, 1);
});

test("a failed attachment is released so a later independent call can recover", async () => {
  let attachments = 0;
  let ready = false;
  const failure = new Error("registration denied");
  const recovery = createSessionRecovery({
    isCurrent: () => true,
    reattach: async () => {
      if (++attachments === 1) throw failure;
      ready = true;
    },
  });
  const action = async () => {
    if (!ready) throw missing();
    return "ready";
  };
  await assert.rejects(recovery.run("subscribe", action), (error) => error === failure);
  assert.equal(await recovery.run("subscribe", action), "ready");
  assert.equal(attachments, 2);
});

test("an invalidated incarnation cannot invoke a control or attach", async () => {
  let calls = 0;
  const recovery = createSessionRecovery({
    isCurrent: () => true,
    reattach: async () => { calls++; },
  });
  recovery.invalidate();
  await assert.rejects(recovery.run("subscribe", async () => { calls++; }), /no longer current/);
  assert.equal(calls, 0);
});

test("end during awaited eligibility verification prevents both control and attachment", async () => {
  const checked = deferred();
  const release = deferred<boolean>();
  let calls = 0;
  const recovery = createSessionRecovery({
    isCurrent: async () => { checked.resolve(); return release.promise; },
    reattach: async () => { calls++; },
  });
  const request = recovery.run("subscribe", async () => { calls++; });
  await checked.promise;
  recovery.invalidate();
  release.resolve(true);
  await assert.rejects(request, /no longer current/);
  assert.equal(calls, 0);
});

test("end during attachment prevents replay even if the attachment completes late", async () => {
  const attaching = deferred();
  const release = deferred();
  let attempts = 0;
  const recovery = createSessionRecovery({
    isCurrent: () => true,
    reattach: async () => { attaching.resolve(); await release.promise; },
  });
  const request = recovery.run("subscribe", async () => { attempts++; throw missing(); });
  await attaching.promise;
  recovery.invalidate();
  release.resolve();
  await assert.rejects(request, /no longer current/);
  assert.equal(attempts, 1);
});

test("uncurrent host evidence rejects recovery without reattachment", async () => {
  let current = true;
  let attachments = 0;
  const recovery = createSessionRecovery({
    isCurrent: () => current,
    reattach: async () => { attachments++; },
  });
  await assert.rejects(recovery.run("subscribe", async () => {
    current = false;
    throw missing();
  }), /no longer current/);
  assert.equal(attachments, 0);
});

test("daemon and transport errors other than missing registration are not replayed", async () => {
  let attachments = 0;
  const recovery = createSessionRecovery({
    isCurrent: () => true,
    reattach: async () => { attachments++; },
  });
  for (const error of [
    new Error("SESSION_INACTIVE: inactive"),
    new Error("SESSION_BUSY: busy"),
    new Error("SESSION_MOVED: moved"),
    new Error("authorization denied"),
    Object.assign(new Error("SESSION_NOT_FOUND: misleading socket message"), { domain: "transport", code: "ETIMEDOUT" }),
  ]) {
    let calls = 0;
    await assert.rejects(recovery.run("subscribe", async () => { calls++; throw error; }), (actual) => actual === error);
    assert.equal(calls, 1);
  }
  assert.equal(attachments, 0);
});

test("JavaScript adapters cannot opt delivery or cleanup into automatic replay", async () => {
  let calls = 0;
  const recovery = createSessionRecovery({
    isCurrent: () => true,
    reattach: async () => { calls++; },
  });
  for (const operation of ["claimReminder", "ackReminder", "releaseSessionOwner", "deleteSession"]) {
    await assert.rejects(
      // @ts-expect-error JavaScript adapters need runtime operation validation too.
      recovery.run(operation, async () => { calls++; }),
      /not eligible/,
    );
  }
  assert.equal(calls, 0);
});

test("typed and Claude-structured missing responses use the same policy", async () => {
  for (const error of [
    new DaemonResponseError("SESSION_NOT_FOUND", "Unknown session"),
    Object.assign(new Error("SESSION_NOT_FOUND: Unknown session"), { domain: "daemon", code: "SESSION_NOT_FOUND", daemonMessage: "Unknown session" }),
  ]) {
    let attachments = 0;
    let attempts = 0;
    const recovery = createSessionRecovery({
      isCurrent: () => true,
      reattach: async () => { attachments++; },
    });
    assert.equal(await recovery.run("subscribe", async () => {
      if (attempts++ === 0) throw error;
      return "ready";
    }), "ready");
    assert.equal(attachments, 1);
    assert.equal(attempts, 2);
  }
});

test("a successful control is returned without attachment or replay", async () => {
  let attachments = 0;
  let attempts = 0;
  const recovery = createSessionRecovery({
    isCurrent: () => true,
    reattach: async () => { attachments++; },
  });
  assert.equal(await recovery.run("subscribe", async () => { attempts++; return 188; }), 188);
  assert.equal(attempts, 1);
  assert.equal(attachments, 0);
});

for (const [stage, verification, expectedAttempts, expectedAttachments] of [
  ["initial control", 1, 0, 0],
  ["reattachment", 3, 1, 0],
  ["control replay", 5, 1, 1],
] as const) {
  test(`invalidation after eligibility resolution still prevents ${stage} dispatch`, async () => {
    const verifying = deferred();
    const evidence = deferred<boolean>();
    let verifications = 0;
    let attempts = 0;
    let attachments = 0;
    const recovery = createSessionRecovery({
      isCurrent: () => {
        if (++verifications !== verification) return true;
        verifying.resolve();
        return evidence.promise;
      },
      reattach: async () => { attachments++; },
    });
    const request = recovery.run("subscribe", async () => {
      if (++attempts === 1) throw missing();
      return "ready";
    });
    await verifying.promise;
    // Register after requireCurrent's await. Its final check runs first, but this
    // End reaction runs before the caller resumes to dispatch the next effect.
    evidence.promise.then(() => recovery.invalidate());
    evidence.resolve(true);
    await assert.rejects(request, /no longer current/);
    assert.equal(attempts, expectedAttempts);
    assert.equal(attachments, expectedAttachments);
  });
}

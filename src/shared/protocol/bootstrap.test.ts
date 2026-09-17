import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  bootstrapInitializeRequestSchema,
  bootstrapResponseSchema,
  isSelectableLifecycleState,
} from "./bootstrap.ts";
import {
  instanceDescriptorV1Schema,
  isSelectableDescriptor,
} from "./descriptor.ts";
import {
  PROTOCOL_V2,
  protocolV2ErrorResponseSchema,
  protocolV2SuccessResponseSchema,
} from "./v2.ts";
import { legacyRequestSchema, requestSchema } from "../ipc.ts";

const readFixture = (path: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`./__fixtures__/${path}`, import.meta.url), "utf8"),
  );


describe("permanent bootstrap v1", () => {
  test("parses initialization with additive fields", () => {
    const parsed = bootstrapInitializeRequestSchema.parse({
      type: "initialize",
      bootstrapVersion: 1,
      payload: {
        client: {
          host: "pi",
          version: "0.2.0",
          commit: "def456",
          incarnationNonce: "c2eaab12-ddfe-4685-a44b-3344a902b214",
          futureClientField: true,
        },
        protocols: { min: 1, max: 2 },
        futurePayloadField: true,
      },
      futureEnvelopeField: true,
    });

    assert.equal(parsed.bootstrapVersion, 1);
    assert.equal("futureEnvelopeField" in parsed, false);
    assert.equal("futurePayloadField" in parsed.payload, false);
    assert.equal("futureClientField" in parsed.payload.client, false);
  });

  test("parses success while stripping future fields", () => {
    const fixture = readFixture("bootstrap/v1/success.json");
    const parsed = bootstrapResponseSchema.parse({
      ...(fixture as Record<string, unknown>),
      futureEnvelopeField: true,
    });

    assert.equal(parsed.ok, true);
    if (!parsed.ok) assert.fail("expected bootstrap success");
    assert.equal(parsed.result.protocols.selected, 2);
    assert.equal("futureEnvelopeField" in parsed, false);
  });

  test("parses a no-overlap failure without a selected normal protocol", () => {
    const parsed = bootstrapResponseSchema.parse(
      readFixture("bootstrap/v1/no-overlap.json"),
    );

    assert.equal(parsed.ok, false);
    if (parsed.ok) assert.fail("expected bootstrap failure");
    assert.deepEqual(parsed.error.supported, { min: 7, max: 7 });
    assert.equal("protocolVersion" in parsed, false);
  });

  test("fails closed for unknown lifecycle states", () => {
    assert.equal(isSelectableLifecycleState("ready"), true);
    assert.equal(isSelectableLifecycleState("future-paused"), false);
  });
});

describe("permanent descriptor v1", () => {
  test("parses additive fields but selects only ready descriptors", () => {
    const fixture = readFixture("descriptor/v1/ready.json");
    const ready = instanceDescriptorV1Schema.parse({
      ...(fixture as Record<string, unknown>),
      futureDescriptorField: true,
    });
    const future = instanceDescriptorV1Schema.parse({
      ...ready,
      lifecycleState: "future-paused",
    });

    assert.equal("futureDescriptorField" in ready, false);
    assert.equal(isSelectableDescriptor(ready), true);
    assert.equal(isSelectableDescriptor(future), false);
  });
});

describe("normal protocol v2 base envelopes", () => {
  test("requires protocol v2 on success and stable errors", () => {
    const success = protocolV2SuccessResponseSchema.parse({
      ok: true,
      protocolVersion: PROTOCOL_V2,
      result: { accepted: true },
    });
    const failure = protocolV2ErrorResponseSchema.parse({
      ok: false,
      protocolVersion: PROTOCOL_V2,
      error: { code: "SESSION_MOVED", message: "Rediscover the session owner" },
    });

    assert.equal(success.protocolVersion, 2);
    assert.equal(failure.error.code, "SESSION_MOVED");
    assert.throws(() =>
      protocolV2SuccessResponseSchema.parse({
        ok: true,
        protocolVersion: 1,
        result: {},
      }),
    );
  });

  test("keeps explicit deletion out of the frozen protocol-v1 allowlist", () => {
    const request = {
      type: "deleteSession",
      protocolVersion: 1,
      payload: { sessionId: "session-1" },
    }
    assert.equal(requestSchema.safeParse(request).success, true)
    assert.equal(legacyRequestSchema.safeParse(request).success, false)
    const claimRequest = {
      type: "claimSessionLease",
      protocolVersion: 1,
      payload: {
        sessionId: "session-1",
        ownerInstanceId: "daemon-a",
        clientIncarnationNonce: "client-a-1",
      },
    }
    assert.equal(requestSchema.safeParse(claimRequest).success, true)
    assert.equal(legacyRequestSchema.safeParse(claimRequest).success, false)
  })
});

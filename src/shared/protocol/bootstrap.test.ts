import assert from "node:assert/strict";
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

const daemon = {
  instanceId: "a1aa7407-10d2-4b1e-b58b-ac989b83d8b9",
  pid: 1234,
  version: "0.2.0",
  commit: "abc123",
  socketPath: "/tmp/premind-501/d-a1aa7407.sock",
  lifecycleState: "ready",
};

const protocols = { min: 1, max: 2, selected: 2 };
const storage = { epoch: 2, capabilities: ["base", "session-leases-v1"] };

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
    const parsed = bootstrapResponseSchema.parse({
      ok: true,
      bootstrapVersion: 1,
      result: {
        daemon: { ...daemon, futureDaemonField: true },
        protocols,
        capabilities: {
          operations: ["registerClient", "debugStatus"],
          rollingSessions: true,
          futureCapability: true,
        },
        storage,
        futureResultField: true,
      },
      futureEnvelopeField: true,
    });

    assert.equal(parsed.ok, true);
    if (!parsed.ok) assert.fail("expected bootstrap success");
    assert.equal(parsed.result.protocols.selected, 2);
    assert.equal("futureEnvelopeField" in parsed, false);
    assert.equal("futureResultField" in parsed.result, false);
    assert.equal("futureDaemonField" in parsed.result.daemon, false);
  });

  test("parses a no-overlap failure without a selected normal protocol", () => {
    const parsed = bootstrapResponseSchema.parse({
      ok: false,
      bootstrapVersion: 1,
      error: {
        code: "PROTOCOL_UNSUPPORTED",
        message: "Update the premind plugin to continue",
        supported: { min: 7, max: 7 },
      },
    });

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
    const ready = instanceDescriptorV1Schema.parse({
      descriptorFormat: 1,
      ...daemon,
      protocols: { min: 1, max: 2 },
      storage,
      heartbeatAt: 123456,
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
});

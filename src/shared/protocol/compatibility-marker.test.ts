import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  mergeCompatibilityMarkers,
  parseCompatibilityMarker,
  serializeCompatibilityMarker,
} from "./compatibility-marker.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/compatibility/v1/${name}`, import.meta.url));

describe("compatibility marker v1", () => {
  test("parses and reproduces the frozen canonical bytes", () => {
    const bytes = fixture("valid.json");
    const marker = parseCompatibilityMarker(bytes);
    assert.equal(marker.markerFormat, 1);
    assert.equal(marker.generation, 7);
    assert.deepEqual(serializeCompatibilityMarker(marker), bytes);
  });

  for (const name of ["duplicate-key.json", "trailing-data.json", "bom.json"]) {
    test(`rejects corrupt ${name} bytes`, () => {
      assert.throws(() => parseCompatibilityMarker(fixture(name)));
    });
  }

  test("ignores additive fields while rejecting unsafe values", () => {
    const valid = fixture("valid.json").toString("utf8").trimEnd();
    const additive = Buffer.from(valid.replace(/}$/, ',"futureField":{"enabled":true}}\n'));
    assert.equal(parseCompatibilityMarker(additive).storageEpoch, 1);
    assert.throws(() =>
      parseCompatibilityMarker(
        Buffer.from(valid.replace('"generation":7', '"generation":9007199254740992') + "\n"),
      ),
    );
    assert.throws(() =>
      parseCompatibilityMarker(
        Buffer.from(valid.replace('"highestDaemonVersion":"0.3.0"', '"highestDaemonVersion":"vNext"') + "\n"),
      ),
    );
  });

  test("merges ordered fields monotonically and advances generation", () => {
    const base = parseCompatibilityMarker(fixture("valid.json"));
    const merged = mergeCompatibilityMarkers(base, {
      ...base,
      highestDaemonVersion: "0.4.0",
      minimumDaemonVersion: "0.1.0",
      serviceSupportFloor: "0.3.0",
      serviceSupportNotBefore: base.serviceSupportNotBefore + 1,
      storageEpoch: 2,
      generation: 4,
    });
    assert.deepEqual(merged, {
      markerFormat: 1,
      highestDaemonVersion: "0.4.0",
      minimumDaemonVersion: "0.2.0",
      serviceSupportFloor: "0.3.0",
      serviceSupportNotBefore: base.serviceSupportNotBefore + 1,
      storageEpoch: 2,
      generation: 8,
    });
  });
});

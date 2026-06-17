/**
 * matchSport() fixture-driven tests.
 *
 * Each fixture has:
 *   id              — human-readable name
 *   expectedSport   — the key matchSport should return (or null for unmatched)
 *   configKeysExtra — extra config keys to include alongside the defaults
 *                     (used to test e.g. "tennis" being a first-class sport)
 *   activity        — the Garmin activity shape passed to matchSport
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { matchSport, type Activity } from "../src/index.ts";

const DEFAULT_CONFIG_KEYS = new Set([
  "zone2",
  "bouldering",
  "hiit",
  "volleyball",
  "highIntensity",
  "longAerobic",
  "mobility",
]);

interface Fixture {
  id: string;
  expectedSport: string | null;
  configKeysExtra?: string[];
  activity: Activity;
}

const fixturesPath = path.join(import.meta.dir, "fixtures", "activities.json");
const fixtures: Fixture[] = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));

describe("matchSport — fixtures", () => {
  for (const fx of fixtures) {
    test(fx.id, () => {
      const keys = new Set(DEFAULT_CONFIG_KEYS);
      for (const k of fx.configKeysExtra ?? []) keys.add(k);
      const actual = matchSport(fx.activity, keys);
      expect(actual).toBe(fx.expectedSport);
    });
  }
});

describe("matchSport — config gating", () => {
  test("returns null when matching sport is not in config", () => {
    const fx = fixtures.find((f) => f.id === "boulder-by-type")!;
    const keys = new Set(["zone2", "hiit"]); // no bouldering
    expect(matchSport(fx.activity, keys)).toBeNull();
  });

  test("falls through to next match when primary not configured", () => {
    // A tennis activity with neither "tennis" nor "highIntensity" in config
    // should return null.
    const fx = fixtures.find((f) => f.id === "tennis-fallback-highintensity")!;
    const keys = new Set(["zone2", "longAerobic"]);
    expect(matchSport(fx.activity, keys)).toBeNull();
  });
});

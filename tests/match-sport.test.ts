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

/**
 * Precedence regression tests. These lock down the *order* of checks inside
 * matchSport() — the function is "first-match-wins", and changing the order
 * of branches will silently re-bucket activities. If any of these fail after
 * a matcher refactor, the change has shifted precedence and the user-facing
 * meaning changed.
 */
describe("matchSport — precedence", () => {
  function build(overrides: Partial<Activity>): Activity {
    return {
      activityName: "Test",
      startTimeLocal: "2026-06-15 08:00:00",
      activityType: { typeKey: "running" },
      duration: 3600,
      ...overrides,
    } as Activity;
  }

  test("activity name containing 'boulder' beats strength_training type", () => {
    // A strength_training activity named "Bouldering session" should match
    // bouldering, NOT hiit (which is the strength_training fallback).
    const a = build({
      activityType: { typeKey: "strength_training" },
      activityName: "Bouldering session",
      duration: 3000,
    });
    expect(matchSport(a, new Set(["bouldering", "hiit"]))).toBe("bouldering");
  });

  test("yoga type beats anything else", () => {
    const a = build({
      activityType: { typeKey: "yoga" },
      activityName: "Yoga + stretching",
      duration: 2400,
    });
    expect(matchSport(a, new Set(["mobility", "hiit", "zone2"]))).toBe("mobility");
  });

  test("volleyball type beats hiit even when HR is in Z4", () => {
    const a = build({
      activityType: { typeKey: "volleyball" },
      activityName: "Match",
      duration: 5100,
      hrTimeInZone_4: 1200,
    });
    expect(matchSport(a, new Set(["volleyball", "hiit", "highIntensity"]))).toBe("volleyball");
  });

  test("long swim (>=60min) beats short-swim zone2 match", () => {
    const a = build({
      activityType: { typeKey: "swimming" },
      activityName: "Long pool session",
      duration: 4200, // 70 min
    });
    expect(matchSport(a, new Set(["zone2", "longAerobic"]))).toBe("longAerobic");
  });

  test("short swim falls through to zone2 when longAerobic available but duration short", () => {
    const a = build({
      activityType: { typeKey: "swimming" },
      activityName: "Quick laps",
      duration: 1800, // 30 min
    });
    expect(matchSport(a, new Set(["zone2", "longAerobic"]))).toBe("zone2");
  });

  test("long aerobic ride (>=70min) beats zone2 by-effect match", () => {
    // Even with an "aerobic_base" training effect, a 75-minute ride should
    // be bucketed as longAerobic, not zone2, because duration takes precedence
    // for the long-aerobic branch.
    const a = build({
      activityType: { typeKey: "cycling" },
      activityName: "Long ride",
      duration: 4500, // 75 min
      trainingEffectLabel: "aerobic_base",
      hrTimeInZone_2: 3000,
    });
    expect(matchSport(a, new Set(["zone2", "longAerobic"]))).toBe("longAerobic");
  });

  test("anaerobic effect beats z2 fallback for short hard run", () => {
    const a = build({
      activityType: { typeKey: "running" },
      activityName: "Intervals",
      duration: 2700, // 45 min — below long-aerobic threshold
      trainingEffectLabel: "anaerobic_capacity",
      hrTimeInZone_2: 600,
      hrTimeInZone_3: 900,
      hrTimeInZone_4: 1200,
    });
    expect(matchSport(a, new Set(["zone2", "highIntensity", "longAerobic"]))).toBe("highIntensity");
  });

  test("climbing-family types route to bouldering uniformly", () => {
    const types = ["climbing", "bouldering", "indoor_climbing", "rock_climbing"];
    for (const typeKey of types) {
      const a = build({ activityType: { typeKey }, activityName: "Session", duration: 3000 });
      expect(matchSport(a, new Set(["bouldering"]))).toBe("bouldering");
    }
  });

  test("aerobic-family types qualify for longAerobic when long", () => {
    const types = ["running", "cycling", "hiking", "trail_running", "walking", "indoor_cycling"];
    for (const typeKey of types) {
      const a = build({ activityType: { typeKey }, activityName: "Long", duration: 5400 });
      expect(matchSport(a, new Set(["longAerobic", "zone2"]))).toBe("longAerobic");
    }
  });
});

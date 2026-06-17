/**
 * Tests for the zone-threshold derivation functions.
 *
 * Both formulas (max-HR and LTHR) follow well-known standards; these tests
 * pin down the percentages so a future refactor can't silently shift the
 * boundaries.
 */

import { describe, test, expect } from "bun:test";
import { zonesFromMaxHr, zonesFromLthr } from "../src/index.ts";

describe("zonesFromMaxHr", () => {
  test("applies 64/75/83/90% bands for a max HR of 195", () => {
    expect(zonesFromMaxHr(195)).toEqual({
      z2: 125, // 64%
      z3: 146, // 75%
      z4: 162, // 83%
      z5: 176, // 90% (rounds up from 175.5)
    });
  });

  test("rounds to integers", () => {
    const z = zonesFromMaxHr(180);
    expect(Number.isInteger(z.z2)).toBe(true);
    expect(Number.isInteger(z.z3)).toBe(true);
    expect(Number.isInteger(z.z4)).toBe(true);
    expect(Number.isInteger(z.z5)).toBe(true);
  });

  test("produces strictly increasing boundaries", () => {
    const z = zonesFromMaxHr(195);
    expect(z.z2).toBeLessThan(z.z3);
    expect(z.z3).toBeLessThan(z.z4);
    expect(z.z4).toBeLessThan(z.z5);
  });
});

describe("zonesFromLthr", () => {
  test("applies 81/90/94/100% bands for LTHR 179", () => {
    expect(zonesFromLthr(179)).toEqual({
      z2: 145, // 81%
      z3: 161, // 90%
      z4: 168, // 94%
      z5: 179, // 100%
    });
  });

  test("Z5 equals LTHR exactly (100% band)", () => {
    expect(zonesFromLthr(170).z5).toBe(170);
    expect(zonesFromLthr(185).z5).toBe(185);
  });

  test("produces strictly increasing boundaries across a range of LTHR values", () => {
    for (const lthr of [150, 165, 175, 185, 195]) {
      const z = zonesFromLthr(lthr);
      expect(z.z2).toBeLessThan(z.z3);
      expect(z.z3).toBeLessThan(z.z4);
      expect(z.z4).toBeLessThan(z.z5);
    }
  });

  test("LTHR zones are higher than max-HR zones for the same person", () => {
    // For an athlete with max ~195 and LTHR ~179 (typical trained ratio),
    // LTHR-based Z2 should be higher than max-HR-based Z2 — reflecting that
    // LTHR-trained zones are more aggressive / accurate for trained athletes.
    const maxHrZ = zonesFromMaxHr(195);
    const lthrZ = zonesFromLthr(179);
    expect(lthrZ.z2).toBeGreaterThan(maxHrZ.z2);
    expect(lthrZ.z3).toBeGreaterThan(maxHrZ.z3);
  });
});

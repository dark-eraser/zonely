/**
 * Cache helper + auth-classifier tests.
 *
 * Cache TTL tests work by writing a cache file with a known fetched_at
 * timestamp and asserting freshness against it. We point HOME at a temp
 * dir so we never touch the developer's real cache.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Redirect the script's data dir BEFORE importing src/index.ts so module-level
// initialization (if any) picks up the override.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gwz-cache-test-"));
const realGZHome = process.env.GARMIN_ZONES_HOME;
process.env.GARMIN_ZONES_HOME = TMP_HOME;

import { isCacheFresh, cacheKey, clearCache, classifyAuthError } from "../src/index.ts";

beforeAll(() => {
  process.env.GARMIN_ZONES_HOME = TMP_HOME;
});

afterAll(() => {
  if (realGZHome === undefined) delete process.env.GARMIN_ZONES_HOME;
  else process.env.GARMIN_ZONES_HOME = realGZHome;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("cacheKey", () => {
  test("activities cache key shape", () => {
    const key = cacheKey("activities", "2026-06-15__40");
    expect(key).toContain("cache");
    expect(key).toContain("activities");
    expect(key.endsWith("2026-06-15__40.json")).toBe(true);
  });

  test("daily-hr cache key shape", () => {
    const key = cacheKey("daily-hr", "2026-06-15");
    expect(key).toContain("daily-hr");
    expect(key.endsWith("2026-06-15.json")).toBe(true);
  });
});

describe("isCacheFresh", () => {
  function writeCacheFile(p: string, fetchedAt: string, payload: unknown) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ fetched_at: fetchedAt, payload }));
  }

  test("returns false when file is missing", () => {
    const key = cacheKey("daily-hr", "missing-date");
    expect(isCacheFresh(key, false)).toBe(false);
    expect(isCacheFresh(key, true)).toBe(false);
  });

  test("past-day cache is always fresh", () => {
    const key = cacheKey("daily-hr", "2020-01-01");
    // Even with a years-old timestamp it should still be considered fresh
    // because the day is in the past and the data is immutable.
    writeCacheFile(key, "2020-01-01T12:00:00.000Z", { heartRateValues: [] });
    expect(isCacheFresh(key, false)).toBe(true);
  });

  test("today cache is fresh within 1 hour", () => {
    const key = cacheKey("daily-hr", "today-fresh");
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeCacheFile(key, tenMinutesAgo, { heartRateValues: [] });
    expect(isCacheFresh(key, true)).toBe(true);
  });

  test("today cache is stale after 1 hour", () => {
    const key = cacheKey("daily-hr", "today-stale");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeCacheFile(key, twoHoursAgo, { heartRateValues: [] });
    expect(isCacheFresh(key, true)).toBe(false);
  });

  test("malformed cache file is treated as stale", () => {
    const key = cacheKey("daily-hr", "broken");
    fs.mkdirSync(path.dirname(key), { recursive: true });
    fs.writeFileSync(key, "not json");
    expect(isCacheFresh(key, true)).toBe(false);
  });
});

describe("clearCache", () => {
  test("removes the cache directory", () => {
    const key = cacheKey("activities", "2026-06-15__40");
    fs.mkdirSync(path.dirname(key), { recursive: true });
    fs.writeFileSync(key, JSON.stringify({ fetched_at: new Date().toISOString(), payload: [] }));
    expect(fs.existsSync(key)).toBe(true);
    clearCache();
    expect(fs.existsSync(key)).toBe(false);
  });

  test("is a no-op when cache dir does not exist", () => {
    clearCache(); // already cleared from previous test
    expect(() => clearCache()).not.toThrow();
  });
});

describe("classifyAuthError", () => {
  test("detects expired-token wording", () => {
    expect(classifyAuthError("token has expired").kind).toBe("token_expired");
    expect(classifyAuthError("please refresh token").kind).toBe("token_expired");
  });

  test("detects rate-limit wording", () => {
    expect(classifyAuthError("429 too many requests").kind).toBe("rate_limited");
    expect(classifyAuthError("you are being rate-limited").kind).toBe("rate_limited");
  });

  test("detects not-logged-in wording", () => {
    expect(classifyAuthError("not logged in").kind).toBe("not_logged_in");
    expect(classifyAuthError("please log in first").kind).toBe("not_logged_in");
    expect(classifyAuthError("401 unauthorized").kind).toBe("not_logged_in");
  });

  test("falls back to unknown for opaque errors", () => {
    expect(classifyAuthError("something exploded").kind).toBe("unknown");
  });

  test("suggests an appropriate remedy", () => {
    expect(classifyAuthError("token expired").remedy).toContain("refresh");
    expect(classifyAuthError("not logged in").remedy).toContain("login");
    expect(classifyAuthError("429").remedy).toContain("wait");
  });
});

/**
 * Smoke tests — invoke the CLI via `bun src/index.ts <args>` and assert on
 * exit code + stdout. Cheap, fast, catches the dumbest regressions.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import * as path from "path";
import { parseArgs, parseWeekFlag } from "../src/index.ts";

const SCRIPT = path.join(import.meta.dir, "..", "src", "index.ts");

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync("bun", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    // Use an empty HOME so the script can never accidentally read the
    // developer's real config during tests.
    env: { ...process.env, HOME: "/tmp/gwz-test-home-does-not-exist" },
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("CLI smoke", () => {
  test("--help exits 0 and prints usage", () => {
    const { code, stdout } = run(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("garmin-weekly-zones");
    expect(stdout).toContain("USAGE");
    expect(stdout).toContain("--week");
    expect(stdout).toContain("--no-daily");
  });

  test("-h is equivalent to --help", () => {
    const { code, stdout } = run(["-h"]);
    expect(code).toBe(0);
    expect(stdout).toContain("USAGE");
  });

  test("--version prints a semver string", () => {
    const { code, stdout } = run(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("-v is equivalent to --version", () => {
    const { code, stdout } = run(["-v"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("unknown flag exits with user-error code", () => {
    const { code, stdout } = run(["--bogus-flag"]);
    expect(code).toBe(1);
    expect(stdout).toContain("Unknown argument");
  });

});

describe("argument parsing", () => {
  test("parseArgs collects unknown flags", () => {
    const args = parseArgs(["--bogus-flag", "--also-bad"]);
    expect(args.unknown).toEqual(["--bogus-flag", "--also-bad"]);
  });

  test("parseArgs recognises --week with separate value", () => {
    const args = parseArgs(["--week", "2026-06-08"]);
    expect(args.week).toBe("2026-06-08");
    expect(args.unknown).toEqual([]);
  });

  test("parseArgs recognises --week=YYYY-MM-DD form", () => {
    const args = parseArgs(["--week=2026-06-08"]);
    expect(args.week).toBe("2026-06-08");
  });

  test("parseArgs recognises setup --reset", () => {
    const args = parseArgs(["setup", "--reset"]);
    expect(args.setup).toBe(true);
    expect(args.resetSetup).toBe(true);
  });

  test("parseWeekFlag returns null for malformed input", () => {
    expect(parseWeekFlag("not-a-date")).toBeNull();
    expect(parseWeekFlag("2026/06/08")).toBeNull();
    expect(parseWeekFlag("")).toBeNull();
  });

  test("parseWeekFlag snaps to Monday of given week", () => {
    // 2026-06-17 is a Wednesday; Monday of that week is 2026-06-15.
    const monday = parseWeekFlag("2026-06-17");
    expect(monday).not.toBeNull();
    expect(monday!.getDay()).toBe(1); // Monday
    expect(monday!.getFullYear()).toBe(2026);
    expect(monday!.getMonth()).toBe(5); // June (0-indexed)
    expect(monday!.getDate()).toBe(15);
  });

  test("parseArgs recognises --json", () => {
    expect(parseArgs(["--json"]).json).toBe(true);
  });

  test("parseArgs recognises --today", () => {
    expect(parseArgs(["--today"]).today).toBe(true);
  });

  test("parseArgs recognises --no-cache and --refresh", () => {
    const a = parseArgs(["--no-cache", "--refresh"]);
    expect(a.noCache).toBe(true);
    expect(a.refresh).toBe(true);
  });

  test("parseArgs accepts --last 4", () => {
    const a = parseArgs(["--last", "4"]);
    expect(a.last).toBe(4);
    expect(a.lastInvalid).toBeNull();
  });

  test("parseArgs accepts --last=8", () => {
    expect(parseArgs(["--last=8"]).last).toBe(8);
  });

  test("parseArgs rejects --last 0 and --last 99 as invalid", () => {
    expect(parseArgs(["--last", "0"]).lastInvalid).toBe("0");
    expect(parseArgs(["--last", "99"]).lastInvalid).toBe("99");
  });

  test("parseArgs rejects non-numeric --last value", () => {
    expect(parseArgs(["--last", "many"]).lastInvalid).toBe("many");
  });
});

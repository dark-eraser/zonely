#!/usr/bin/env bun
/**
 * garmin-weekly-zones
 * Weekly training zone tracker for Garmin Connect.
 *
 * Usage:
 *   garmin-zones                       Show current week
 *   garmin-zones --last-week           Show last week (alias for --week last)
 *   garmin-zones --week 2026-06-08     Show specific week (Monday date)
 *   garmin-zones --no-daily            Skip daily HR fetch (faster)
 *   garmin-zones setup                 Run interactive setup wizard
 *   garmin-zones setup --reset         Reset and re-run setup
 *   garmin-zones --help                Show usage
 *   garmin-zones --version             Show version
 *
 * Exit codes:
 *   0   success
 *   1   user error (bad args, invalid input)
 *   2   auth failure
 *   127 missing external dependency (garmin-connect / bun)
 */

/** Semantic exit codes. */
export const EXIT = {
  OK: 0,
  USER_ERROR: 1,
  AUTH_FAILURE: 2,
  MISSING_DEPENDENCY: 127,
} as const;

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";

// ─────────────────────────────────────────────────────────────────────────────
// ANSI colors
// ─────────────────────────────────────────────────────────────────────────────

const R = "\x1b[0m";
const B = "\x1b[1m";
const GR = "\x1b[90m";
const GN = "\x1b[32m";
const YL = "\x1b[33m";
const RD = "\x1b[31m";
const CY = "\x1b[36m";

const bold = (s: string) => `${B}${s}${R}`;
const gray = (s: string) => `${GR}${s}${R}`;
const green = (s: string) => `${GN}${s}${R}`;
const yell = (s: string) => `${YL}${s}${R}`;
const red = (s: string) => `${RD}${s}${R}`;
const cyan = (s: string) => `${CY}${s}${R}`;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Activity {
  activityName: string;
  startTimeLocal: string;
  activityType: { typeKey: string };
  duration: number;
  distance?: number;
  averageHR?: number;
  hrTimeInZone_1?: number;
  hrTimeInZone_2?: number;
  hrTimeInZone_3?: number;
  hrTimeInZone_4?: number;
  hrTimeInZone_5?: number;
  trainingEffectLabel?: string;
  aerobicTrainingEffectMessage?: string;
}

type SportMetric = "zone2" | "duration";

interface Sport {
  key: string;
  emoji: string;
  name: string;
  description: string;
  targetMin: number;
  targetMax: number;
  metric: SportMetric;
}

/**
 * BPM lower-bounds for each zone above Z1.
 * A sample falls in Z1 if `bpm < z2`, Z2 if `z2 <= bpm < z3`, etc.
 * Z5 has no upper bound.
 */
interface ZoneThresholds {
  z2: number;
  z3: number;
  z4: number;
  z5: number;
}

interface Config {
  version: number;
  sports: Sport[];
  zones?: ZoneThresholds;
  weeklyZoneGoals?: WeeklyZoneGoals;
}

const DEFAULT_ZONES: ZoneThresholds = { z2: 125, z3: 146, z4: 162, z5: 176 };

/** Weekly heart-rate zone minute targets shown in the ZONE TOTALS section. */
interface WeeklyZoneGoals {
  z2Mins: number;
  z45Mins: number;
}

const DEFAULT_WEEKLY_ZONE_GOALS: WeeklyZoneGoals = { z2Mins: 150, z45Mins: 45 };

/** Compute zone boundaries from max HR using standard %-of-max bands. */
export function zonesFromMaxHr(maxHr: number): ZoneThresholds {
  return {
    z2: Math.round(maxHr * 0.64),
    z3: Math.round(maxHr * 0.75),
    z4: Math.round(maxHr * 0.83),
    z5: Math.round(maxHr * 0.90),
  };
}

/**
 * Compute zone boundaries from lactate threshold HR (LTHR) using the
 * Joe Friel / TrainingPeaks standard percentages:
 *   Z1 < 81% LTHR · Z2 81-89% · Z3 90-93% · Z4 94-99% · Z5 ≥ 100%
 * LTHR is the gold-standard zone reference for trained athletes — more
 * accurate than max-HR-based zones because it correlates with sustainable
 * threshold pace rather than peak capacity.
 */
export function zonesFromLthr(lthr: number): ZoneThresholds {
  return {
    z2: Math.round(lthr * 0.81),
    z3: Math.round(lthr * 0.90),
    z4: Math.round(lthr * 0.94),
    z5: Math.round(lthr * 1.0),
  };
}

/**
 * Attempt to pull the user's LTHR from `garmin-connect training lactate`.
 * Returns null if the endpoint fails or the payload doesn't include an HR.
 * This is best-effort — callers should fall back to max-HR-based zones.
 */
export function fetchLthrFromGarmin(): number | null {
  try {
    const out = execSync("garmin-connect training lactate", {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out);
    const hr = parsed?.speed_and_heart_rate?.heartRate;
    if (typeof hr === "number" && hr > 100 && hr < 220) return hr;
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config / setup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve config/cache paths at *call time* rather than module load.
 * Tests set GARMIN_ZONES_HOME before importing; this keeps them isolated
 * from the developer's real ~/.garmin-zones.
 */
function gzHome(): string {
  return process.env.GARMIN_ZONES_HOME || path.join(os.homedir(), ".garmin-zones");
}
function gzConfigPath(): string {
  return path.join(gzHome(), "config.json");
}
function gzCacheDir(): string {
  return path.join(gzHome(), "cache");
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache helpers
//
// Cache files store *raw* Garmin payloads keyed by their request shape:
//   activities/<after>__<limit>.json    — activities list response
//   daily-hr/<YYYY-MM-DD>.json          — heart-rate sample stream
//
// Past-day data is immutable; "today" data has a 1h TTL.
// Each cache file embeds a `fetched_at` ISO timestamp so we can age it.
// ─────────────────────────────────────────────────────────────────────────────

const TODAY_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry<T> {
  fetched_at: string;
  payload: T;
}

export function cacheKey(kind: "activities" | "daily-hr", id: string): string {
  return path.join(gzCacheDir(), kind, `${id}.json`);
}

function ensureCacheDir(kind: "activities" | "daily-hr") {
  const dir = path.join(gzCacheDir(), kind);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function clearCache() {
  if (fs.existsSync(gzCacheDir())) fs.rmSync(gzCacheDir(), { recursive: true, force: true });
}

/**
 * Return `true` if a cache file is fresh enough to use.
 * Past dates: always fresh.
 * Today: fresh if younger than TODAY_TTL_MS.
 */
export function isCacheFresh(filePath: string, isToday: boolean): boolean {
  if (!fs.existsSync(filePath)) return false;
  if (!isToday) return true;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const entry = JSON.parse(raw) as CacheEntry<unknown>;
    if (!entry.fetched_at) return false;
    const age = Date.now() - new Date(entry.fetched_at).getTime();
    return age < TODAY_TTL_MS;
  } catch {
    return false;
  }
}

function readCache<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const entry = JSON.parse(raw) as CacheEntry<T>;
    return entry.payload ?? null;
  } catch {
    return null;
  }
}

function writeCache<T>(kind: "activities" | "daily-hr", id: string, payload: T) {
  ensureCacheDir(kind);
  const filePath = cacheKey(kind, id);
  const entry: CacheEntry<T> = { fetched_at: new Date().toISOString(), payload };
  fs.writeFileSync(filePath, JSON.stringify(entry), "utf8");
}

const DEFAULT_SPORTS: Sport[] = [
  { key: "zone2", emoji: "🏃", name: "Zone 2 Cardio", description: "easy run or ride", targetMin: 60, targetMax: 75, metric: "zone2" },
  { key: "bouldering", emoji: "🧗", name: "Bouldering", description: "~90 min moderate", targetMin: 85, targetMax: 95, metric: "duration" },
  { key: "hiit", emoji: "⚡", name: "HIIT + Stability", description: "intervals + core", targetMin: 55, targetMax: 65, metric: "duration" },
  { key: "volleyball", emoji: "🏐", name: "Volleyball", description: "~90 min", targetMin: 85, targetMax: 95, metric: "duration" },
  { key: "highIntensity", emoji: "🔥", name: "High-Intensity", description: "90–120 min flexible", targetMin: 90, targetMax: 120, metric: "duration" },
  { key: "longAerobic", emoji: "🚴", name: "Long Aerobic", description: "75–90 min ride or trail", targetMin: 75, targetMax: 90, metric: "duration" },
  { key: "mobility", emoji: "🧘", name: "Mobility Only", description: "30–45 min stretching", targetMin: 30, targetMax: 45, metric: "duration" },
];

function configExists(): boolean {
  return fs.existsSync(gzConfigPath());
}

function parsePositiveInt(raw: string, fallback: number): number {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isValidWeeklyZoneGoals(g: any): g is WeeklyZoneGoals {
  return g && typeof g.z2Mins === "number" && g.z2Mins > 0 && typeof g.z45Mins === "number" && g.z45Mins > 0;
}

function isValidZones(z: any): z is ZoneThresholds {
  return (
    z &&
    typeof z.z2 === "number" &&
    typeof z.z3 === "number" &&
    typeof z.z4 === "number" &&
    typeof z.z5 === "number" &&
    z.z2 < z.z3 &&
    z.z3 < z.z4 &&
    z.z4 < z.z5
  );
}

function loadConfig(): Config | null {
  if (!configExists()) return null;
  try {
    const raw = fs.readFileSync(gzConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.sports) || parsed.sports.length === 0) return null;
    return {
      version: parsed.version ?? 1,
      sports: parsed.sports,
      zones: isValidZones(parsed.zones) ? parsed.zones : undefined,
      weeklyZoneGoals: isValidWeeklyZoneGoals(parsed.weeklyZoneGoals) ? parsed.weeklyZoneGoals : undefined,
    };
  } catch {
    return null;
  }
}

function saveConfig(cfg: Config) {
  if (!fs.existsSync(gzHome())) fs.mkdirSync(gzHome(), { recursive: true });
  fs.writeFileSync(gzConfigPath(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function resetConfig() {
  if (fs.existsSync(gzConfigPath())) fs.unlinkSync(gzConfigPath());
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

async function runSetupWizard(reset = false): Promise<Config> {
  if (reset) resetConfig();

  console.log();
  console.log(`  ${bold(cyan("GARMIN WEEKLY ZONES — SETUP"))}`);
  console.log(gray("  " + "─".repeat(62)));
  console.log();
  console.log("  Configure your weekly training plan. You can re-run this anytime");
  console.log("  with " + bold("garmin-zones setup --reset") + ".");
  console.log();

  if (!process.stdin.isTTY) {
    console.log(red("  Setup requires an interactive terminal (stdin is not a TTY)."));
    console.log(gray("  Saving default plan instead."));
    const fallback: Config = { version: 1, sports: DEFAULT_SPORTS, zones: { ...DEFAULT_ZONES } };
    saveConfig(fallback);
    return fallback;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const chosen: Sport[] = [];
  let zones: ZoneThresholds = { ...DEFAULT_ZONES };
  let weeklyZoneGoals: WeeklyZoneGoals = { ...DEFAULT_WEEKLY_ZONE_GOALS };

  try {
    while (true) {
      console.log(bold("  Pick a sport to add (or finish):"));
      DEFAULT_SPORTS.forEach((s, i) => {
        console.log(`    ${gray(String(i + 1).padStart(2))}. ${s.emoji}  ${s.name} ${gray("— " + s.description)}`);
      });
      console.log(`    ${gray(String(DEFAULT_SPORTS.length + 1).padStart(2))}. ${bold("custom")} ${gray("— add your own")}`);
      console.log(`    ${gray(" 0")}. ${green("done")} ${gray("— finish setup")}`);
      console.log();

      const answer = await prompt(rl, `  ${cyan(">")} choice: `);
      console.log();

      if (answer === "0" || answer.toLowerCase() === "done" || answer === "") {
        if (chosen.length === 0) {
          console.log(yell("  Add at least one sport before finishing."));
          console.log();
          continue;
        }
        break;
      }

      const idx = parseInt(answer, 10);
      let sport: Sport | null = null;

      if (Number.isFinite(idx) && idx >= 1 && idx <= DEFAULT_SPORTS.length) {
        const base = DEFAULT_SPORTS[idx - 1]!;
        if (chosen.some((s) => s.key === base.key)) {
          console.log(yell(`  Already added ${base.name}. Pick another.`));
          console.log();
          continue;
        }
        sport = { ...base };
      } else if (idx === DEFAULT_SPORTS.length + 1 || answer.toLowerCase() === "custom") {
        const name = await prompt(rl, `  ${cyan(">")} custom sport name: `);
        if (!name) {
          console.log(yell("  Empty name; skipped."));
          console.log();
          continue;
        }
        const emoji = (await prompt(rl, `  ${cyan(">")} emoji (or blank): `)) || "🏅";
        const description = (await prompt(rl, `  ${cyan(">")} short description: `)) || "";
        const metricAns = (await prompt(rl, `  ${cyan(">")} metric — (1) zone2 / (2) duration [2]: `)) || "2";
        const metric: SportMetric = metricAns.trim() === "1" ? "zone2" : "duration";
        sport = {
          key: name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `custom_${chosen.length + 1}`,
          emoji,
          name,
          description,
          targetMin: 60,
          targetMax: 75,
          metric,
        };
      } else {
        console.log(yell("  Unknown choice."));
        console.log();
        continue;
      }

      const tminAns = await prompt(rl, `  ${cyan(">")} ${sport.name} — target MIN minutes [${sport.targetMin}]: `);
      const tmaxAns = await prompt(rl, `  ${cyan(">")} ${sport.name} — target MAX minutes [${sport.targetMax}]: `);
      const tmin = parseInt(tminAns, 10);
      const tmax = parseInt(tmaxAns, 10);
      if (Number.isFinite(tmin) && tmin > 0) sport.targetMin = tmin;
      if (Number.isFinite(tmax) && tmax >= sport.targetMin) sport.targetMax = tmax;

      chosen.push(sport);
      console.log(green(`  Added ${sport.emoji} ${sport.name} (${sport.targetMin}–${sport.targetMax}m).`));
      console.log();
    }

    // ─── zone thresholds ───────────────────────────────────────────────────
    console.log(gray("  " + "─".repeat(62)));
    console.log();
    console.log(bold("  HEART-RATE ZONE THRESHOLDS"));
    console.log(gray("  Used to bucket non-activity HR samples into zones."));
    console.log(gray("  Activity zones still come straight from Garmin."));
    console.log();
    console.log("    1. Pull lactate threshold HR from Garmin (most accurate)");
    console.log("    2. Auto-calculate from max HR");
    console.log("    3. Enter the 4 boundary BPM values manually");
    console.log(`    4. Use defaults ${gray(`(Z2 ${DEFAULT_ZONES.z2} / Z3 ${DEFAULT_ZONES.z3} / Z4 ${DEFAULT_ZONES.z4} / Z5 ${DEFAULT_ZONES.z5})`)}`);
    console.log();

    const modeAns = (await prompt(rl, `  ${cyan(">")} choice [1]: `)) || "1";

    if (modeAns === "1") {
      process.stdout.write(gray("  fetching lactate threshold from Garmin… "));
      const lthr = fetchLthrFromGarmin();
      process.stdout.write("\r" + " ".repeat(50) + "\r");
      if (lthr !== null) {
        zones = zonesFromLthr(lthr);
        console.log(green(`  Got LTHR ${lthr} bpm — computed: Z2 ${zones.z2} / Z3 ${zones.z3} / Z4 ${zones.z4} / Z5 ${zones.z5}`));
      } else {
        console.log(yell("  Couldn't fetch LTHR from Garmin (auth issue or no lactate data on file)."));
        console.log(gray("  Falling back to max-HR auto-calc."));
        const maxAns = await prompt(rl, `  ${cyan(">")} your max HR (e.g. 195): `);
        const maxHr = parseInt(maxAns, 10);
        if (Number.isFinite(maxHr) && maxHr > 100 && maxHr < 230) {
          zones = zonesFromMaxHr(maxHr);
          console.log(green(`  Computed: Z2 ${zones.z2} / Z3 ${zones.z3} / Z4 ${zones.z4} / Z5 ${zones.z5}`));
        } else {
          console.log(yell(`  Invalid max HR — falling back to defaults.`));
          zones = { ...DEFAULT_ZONES };
        }
      }
    } else if (modeAns === "2") {
      const maxAns = await prompt(rl, `  ${cyan(">")} your max HR (e.g. 195): `);
      const maxHr = parseInt(maxAns, 10);
      if (Number.isFinite(maxHr) && maxHr > 100 && maxHr < 230) {
        zones = zonesFromMaxHr(maxHr);
        console.log(green(`  Computed: Z2 ${zones.z2} / Z3 ${zones.z3} / Z4 ${zones.z4} / Z5 ${zones.z5}`));
      } else {
        console.log(yell(`  Invalid max HR — falling back to defaults.`));
        zones = { ...DEFAULT_ZONES };
      }
    } else if (modeAns === "3") {
      const ask = async (label: string, fallback: number): Promise<number> => {
        const a = await prompt(rl, `  ${cyan(">")} ${label} lower bound [${fallback}]: `);
        const v = parseInt(a, 10);
        return Number.isFinite(v) && v > 0 ? v : fallback;
      };
      const z2 = await ask("Z2", DEFAULT_ZONES.z2);
      const z3 = await ask("Z3", DEFAULT_ZONES.z3);
      const z4 = await ask("Z4", DEFAULT_ZONES.z4);
      const z5 = await ask("Z5", DEFAULT_ZONES.z5);
      if (z2 < z3 && z3 < z4 && z4 < z5) {
        zones = { z2, z3, z4, z5 };
      } else {
        console.log(yell(`  Values must be strictly increasing — falling back to defaults.`));
        zones = { ...DEFAULT_ZONES };
      }
    } else {
      zones = { ...DEFAULT_ZONES };
    }
    console.log();

    // ─── weekly zone goals ────────────────────────────────────────────────
    console.log(gray("  " + "─".repeat(62)));
    console.log();
    console.log(bold("  WEEKLY ZONE GOALS"));
    console.log(gray("  Minute targets shown in the ZONE TOTALS section each week."));
    console.log();
    const z2GoalAns = await prompt(rl, `  ${cyan(">")} Zone 2 weekly target minutes [${DEFAULT_WEEKLY_ZONE_GOALS.z2Mins}]: `);
    const z45GoalAns = await prompt(rl, `  ${cyan(">")} Zone 4+5 combined weekly target minutes [${DEFAULT_WEEKLY_ZONE_GOALS.z45Mins}]: `);
    weeklyZoneGoals = {
      z2Mins: parsePositiveInt(z2GoalAns, DEFAULT_WEEKLY_ZONE_GOALS.z2Mins),
      z45Mins: parsePositiveInt(z45GoalAns, DEFAULT_WEEKLY_ZONE_GOALS.z45Mins),
    };
    console.log(green(`  Zone goals: Z2 ${weeklyZoneGoals.z2Mins}m · Z4+5 ${weeklyZoneGoals.z45Mins}m`));
    console.log();
  } finally {
    rl.close();
  }

  const cfg: Config = { version: 1, sports: chosen, zones, weeklyZoneGoals };
  saveConfig(cfg);

  console.log(gray("  " + "─".repeat(62)));
  console.log(green(`  Saved ${chosen.length} sport(s) to ${gzConfigPath()}`));
  console.log();
  return cfg;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI argument parsing
// ─────────────────────────────────────────────────────────────────────────────

export interface CliArgs {
  help: boolean;
  version: boolean;
  noDaily: boolean;
  week: string | null;
  setup: boolean;
  resetSetup: boolean;
  json: boolean;
  today: boolean;
  last: number | null;
  noCache: boolean;
  refresh: boolean;
  unknown: string[];
  /** Set when --last receives a malformed value; main() converts to USER_ERROR. */
  lastInvalid: string | null;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    version: false,
    noDaily: false,
    week: null,
    setup: false,
    resetSetup: false,
    json: false,
    today: false,
    last: null,
    noCache: false,
    refresh: false,
    unknown: [],
    lastInvalid: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--no-daily") args.noDaily = true;
    else if (a === "--json") args.json = true;
    else if (a === "--today") args.today = true;
    else if (a === "--last-week" || a === "-lw") { if (!args.week) args.week = "last"; }
    else if (a === "--no-cache") args.noCache = true;
    else if (a === "--refresh") args.refresh = true;
    else if (a === "--week") args.week = argv[++i] ?? null;
    else if (a.startsWith("--week=")) args.week = a.slice("--week=".length);
    else if (a === "--last") {
      const raw = argv[++i] ?? "";
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 12) args.last = n;
      else args.lastInvalid = raw || "(missing)";
    } else if (a.startsWith("--last=")) {
      const raw = a.slice("--last=".length);
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 12) args.last = n;
      else args.lastInvalid = raw || "(missing)";
    } else if (a === "setup") args.setup = true;
    else if (a === "--reset" && args.setup) args.resetSetup = true;
    else args.unknown.push(a);
  }
  return args;
}

/** Read version from package.json — small enough to inline-parse rather than import as JSON. */
export function readPackageVersion(): string {
  try {
    const candidates = [
      path.join(__dirname, "..", "package.json"),
      path.join(process.cwd(), "package.json"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
        if (typeof pkg.version === "string") return pkg.version;
      }
    }
  } catch {
    /* swallow */
  }
  return "0.0.0";
}

function printHelp() {
  console.log();
  console.log(`  ${bold(cyan("garmin-weekly-zones"))}  ${gray("· weekly training zone tracker")}`);
  console.log();
  console.log(bold("  USAGE"));
  console.log(`    garmin-zones [options]`);
  console.log(`    garmin-zones setup [--reset]`);
  console.log();
  console.log(bold("  OPTIONS"));
  console.log(`    ${cyan("--last-week, -lw")}       Show last week's full training view (alias for --week last)`);
  console.log(`    ${cyan("--week")} ${gray("YYYY-MM-DD")}   Show the week containing this date (defaults to current week)`);
  console.log(`    ${cyan("--week")} ${gray("last|prev")}    Shortcut for the previous week (also: this, next)`);
  console.log(`    ${cyan("--today")}               Show only today's activities (skips daily HR)`);
  console.log(`    ${cyan("--last")} ${gray("N")}             Show a compact summary of the last N weeks (1–12)`);
  console.log(`    ${cyan("--no-daily")}            Skip daily HR fetch (faster; activities only)`);
  console.log(`    ${cyan("--json")}                Emit a single JSON object instead of the colored UI`);
  console.log(`    ${cyan("--no-cache")}            Bypass cache reads (still writes for next time)`);
  console.log(`    ${cyan("--refresh")}             Clear the cache before running`);
  console.log(`    ${cyan("--help, -h")}            Show this help and exit`);
  console.log(`    ${cyan("--version, -v")}         Print version and exit`);
  console.log();
  console.log(bold("  SUBCOMMANDS"));
  console.log(`    ${cyan("setup")}                 Run interactive setup wizard`);
  console.log(`    ${cyan("setup --reset")}         Clear and re-run setup`);
  console.log();
  console.log(bold("  CONFIG"));
  console.log(`    ${gray(gzConfigPath())}`);
  console.log();
  console.log(bold("  PREREQUISITES"));
  console.log(`    ${gray("- bun (https://bun.sh)")}`);
  console.log(`    ${gray("- garmin-connect CLI (bun add -g garmin-connect)")}`);
  console.log(`    ${gray("- Garmin account: garmin-connect auth login")}`);
  console.log();
}

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────────

function getWeekMonday(reference?: Date): Date {
  const today = reference ?? new Date();
  const d = today.getDay();
  const offset = d === 0 ? -6 : 1 - d;
  const mon = new Date(today);
  mon.setDate(today.getDate() + offset);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0]!;
}

/**
 * Resolve a --week value into the Monday of the target week.
 * Accepts:
 *   - YYYY-MM-DD                       — any date; snaps to that week's Monday
 *   - "this" / "current" / "now"       — current week's Monday
 *   - "last" / "prev" / "previous"     — one week back
 *   - "next"                            — one week forward (for planning ahead)
 * Returns null for anything else.
 */
export function parseWeekFlag(input: string): Date | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  // String aliases (case-insensitive)
  const thisMonday = getWeekMonday();
  if (trimmed === "this" || trimmed === "current" || trimmed === "now") {
    return thisMonday;
  }
  if (trimmed === "last" || trimmed === "prev" || trimmed === "previous") {
    const d = new Date(thisMonday);
    d.setDate(thisMonday.getDate() - 7);
    return d;
  }
  if (trimmed === "next") {
    const d = new Date(thisMonday);
    d.setDate(thisMonday.getDate() + 7);
    return d;
  }

  // Strict YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const [y, m, d] = input.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return null;
  return getWeekMonday(date);
}

function fmtMins(mins: number): string {
  const m = Math.round(mins);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function bar(done: number, target: number, width = 20): string {
  const pct = Math.min(done / Math.max(target, 1), 1);
  const filled = Math.round(pct * width);
  const b = "█".repeat(filled) + "░".repeat(width - filled);
  if (pct >= 1) return `${GN}${b}${R}`;
  if (pct >= 0.5) return `${YL}${b}${R}`;
  return `${RD}${b}${R}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Garmin CLI shim
// ─────────────────────────────────────────────────────────────────────────────

function garminBinaryAvailable(): boolean {
  try {
    execSync("command -v garmin-connect", { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export type AuthFailureKind = "not_logged_in" | "token_expired" | "rate_limited" | "unknown";

export interface AuthCheck {
  ok: boolean;
  kind?: AuthFailureKind;
  message?: string;
  remedy?: string;
}

/** Classify an auth error string so we can give a useful hint. */
export function classifyAuthError(message: string): { kind: AuthFailureKind; remedy: string } {
  const m = message.toLowerCase();
  if (/expired|refresh.*token|token.*expired|reauth/.test(m)) {
    return { kind: "token_expired", remedy: "garmin-connect auth refresh" };
  }
  if (/rate.?limit|too many requests|429/.test(m)) {
    return { kind: "rate_limited", remedy: "wait a few minutes and try again" };
  }
  if (/not.*log(ged)?.*in|no.*credential|unauth(orized|enticated)|please.*log/.test(m)) {
    return { kind: "not_logged_in", remedy: "garmin-connect auth login" };
  }
  return { kind: "unknown", remedy: "garmin-connect auth login" };
}

function garminAuthOk(): AuthCheck {
  try {
    const out = execSync("garmin-connect auth status", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 });
    if (/logged\s*in/i.test(out) || /authenticated/i.test(out) || /ok/i.test(out)) return { ok: true };
    const classified = classifyAuthError(out);
    return { ok: false, kind: classified.kind, remedy: classified.remedy, message: out.trim() || "Auth status unclear" };
  } catch (e: any) {
    const raw = (e?.stderr?.toString?.() || e?.message || "auth check failed").trim();
    const classified = classifyAuthError(raw);
    return { ok: false, kind: classified.kind, remedy: classified.remedy, message: raw };
  }
}

function garmin<T = any>(cmd: string): T | null {
  try {
    const out = execSync(`garmin-connect ${cmd}`, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

interface CacheOpts {
  noCache: boolean;
}

/** Wrap garmin() with disk caching. */
function garminCached<T = any>(
  cmd: string,
  kind: "activities" | "daily-hr",
  id: string,
  isToday: boolean,
  opts: CacheOpts,
): T | null {
  const filePath = cacheKey(kind, id);
  if (!opts.noCache && isCacheFresh(filePath, isToday)) {
    const hit = readCache<T>(filePath);
    if (hit !== null) return hit;
  }
  const fresh = garmin<T>(cmd);
  if (fresh !== null) writeCache(kind, id, fresh);
  return fresh;
}

// ─────────────────────────────────────────────────────────────────────────────
// Labels & matching
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  running: "run",
  cycling: "cycle",
  hiking: "hike",
  walking: "walk",
  swimming: "swim",
  strength_training: "strength",
  cardio: "cardio",
  yoga: "yoga",
  trail_running: "trail",
  indoor_cycling: "indoor cycle",
  open_water_swimming: "OW swim",
  hiit: "hiit",
  tennis: "tennis",
  indoor_climbing: "climb",
  bouldering: "boulder",
};

function actLabel(typeKey: string): string {
  return TYPE_LABELS[typeKey] ?? typeKey.replace(/_/g, " ");
}

/**
 * Match an activity to a configured sport key.
 * The user's config defines which sports are tracked; this function returns
 * the canonical sport key. If the matched key isn't in the user's config,
 * the activity falls through to "unmatched".
 */
export function matchSport(act: Activity, configKeys: Set<string>): string | null {
  const type = act.activityType.typeKey;
  const durMin = act.duration / 60;
  const z2 = (act.hrTimeInZone_2 ?? 0) / 60;
  const z3 = (act.hrTimeInZone_3 ?? 0) / 60;
  const z4 = (act.hrTimeInZone_4 ?? 0) / 60;
  const effect = (act.trainingEffectLabel ?? "").toLowerCase();
  const msg = (act.aerobicTrainingEffectMessage ?? "").toLowerCase();
  const name = act.activityName.toLowerCase();
  // Strip leading "City - " style prefix so geographic names don't interfere.
  // "Zurich - Tempo" → "tempo", "Berlin - Easy Run" → "easy run".
  // Falls back to the full name when no " - " separator is present.
  const shortName = name.replace(/^[^-]+ - /, "");

  const has = (key: string) => configKeys.has(key);

  // Climbing-family
  if (
    ["climbing", "bouldering", "indoor_climbing", "rock_climbing"].includes(type) ||
    name.includes("boulder") ||
    name.includes("climb")
  ) {
    if (has("bouldering")) return "bouldering";
  }

  // Mobility/yoga
  if (["yoga", "flexibility", "stretching"].includes(type) || name.includes("stretch") || name.includes("mobil")) {
    if (has("mobility")) return "mobility";
  }

  // Volleyball
  if (type === "volleyball" || name.includes("volley")) {
    if (has("volleyball")) return "volleyball";
  }

  // Tennis — treat as high intensity if configured, otherwise as its own key
  if (type === "tennis" || name.includes("tennis")) {
    if (has("tennis")) return "tennis";
    if (has("highIntensity")) return "highIntensity";
  }

  // Swimming — long aerobic if long, zone2 otherwise
  if (["swimming", "open_water_swimming", "lap_swimming", "pool_swimming"].includes(type) || name.includes("swim")) {
    if (durMin >= 60 && has("longAerobic")) return "longAerobic";
    if (has("zone2")) return "zone2";
  }

  // HIIT / strength / cardio
  if (["hiit", "strength_training", "cardio"].includes(type)) {
    if (has("hiit")) return "hiit";
  }

  // Aerobic family
  const isAerobic = ["running", "cycling", "hiking", "trail_running", "walking", "indoor_cycling"].includes(type);
  if (!isAerobic) return null;

  if (durMin >= 70 && has("longAerobic")) return "longAerobic";

  // Garmin training-effect signals
  if ((effect.includes("aerobic_base") || effect.includes("recovery") || msg.includes("aerobic_base")) && has("zone2")) return "zone2";
  if ((effect.includes("anaerobic") || effect.includes("vo2") || z3 + z4 > z2 + 10) && has("highIntensity")) return "highIntensity";

  // Activity-name keyword signals (use shortName so city prefixes don't interfere)
  const isIntenseByName =
    shortName.includes("tempo") || shortName.includes("interval") ||
    shortName.includes("threshold") || shortName.includes("fartlek") ||
    shortName.includes("race") || shortName.includes("speed");
  const isEasyByName =
    shortName.includes("easy") || shortName.includes("base") ||
    shortName.includes("recovery") || shortName.includes("jog") ||
    shortName.includes("endurance");

  if (isIntenseByName && has("highIntensity")) return "highIntensity";
  if (isIntenseByName && has("zone2")) return "zone2";
  if (isEasyByName && has("zone2")) return "zone2";

  // Zone-data fallback
  if (z2 >= 10 && has("zone2")) return "zone2";

  // Generic aerobic fallback — covers unlabelled short runs/rides where no
  // specific signal fired (e.g. "Zurich Running", "Zurich Cycling")
  if (has("zone2")) return "zone2";
  if (has("highIntensity")) return "highIntensity";
  if (has("longAerobic")) return "longAerobic";

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-activity HR zone estimation
// ─────────────────────────────────────────────────────────────────────────────

function nonActivityZones(
  hrValues: Array<[number, number]>,
  dayActivities: Activity[],
  thresholds: ZoneThresholds,
): number[] {
  const windows = dayActivities.map((a) => ({
    start: new Date(a.startTimeLocal).getTime(),
    end: new Date(a.startTimeLocal).getTime() + (a.duration + 180) * 1000,
  }));
  const zones = [0, 0, 0, 0, 0];
  for (const [ts, bpm] of hrValues) {
    if (windows.some((w) => ts >= w.start && ts <= w.end)) continue;
    if (bpm < thresholds.z2) zones[0]! += 2;
    else if (bpm < thresholds.z3) zones[1]! += 2;
    else if (bpm < thresholds.z4) zones[2]! += 2;
    else if (bpm < thresholds.z5) zones[3]! += 2;
    else zones[4]! += 2;
  }
  return zones;
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderSportsChecklist(
  sports: Sport[],
  sportMap: Record<string, Activity[]>,
): void {
  console.log(bold("  SPORTS CHECKLIST"));
  console.log();

  for (const sport of sports) {
    const acts = sportMap[sport.key] ?? [];
    const totalZ2 = acts.reduce((s, a) => s + (a.hrTimeInZone_2 ?? 0) / 60, 0);
    const totalDur = acts.reduce((s, a) => s + a.duration / 60, 0);
    const metric = sport.metric === "zone2" ? totalZ2 : totalDur;
    const done = metric >= sport.targetMin;
    const partial = metric > 0 && !done;

    const icon = done ? green("✓") : partial ? yell("◑") : gray("○");
    const targetLabel =
      sport.metric === "zone2"
        ? gray(`${sport.targetMin}–${sport.targetMax}m Z2`)
        : gray(`${sport.targetMin}–${sport.targetMax}m`);

    console.log(`  ${icon}  ${bold(`${sport.emoji}  ${sport.name}`)}  ${targetLabel}`);

    if (acts.length > 0) {
      const doneRnd = Math.round(metric);
      const remaining = Math.max(0, sport.targetMin - doneRnd);
      const remStr = remaining > 0 ? gray(` · ${fmtMins(remaining)} left`) : green(" · done ✓");
      console.log(
        `     ${bar(doneRnd, sport.targetMin)}  ${bold(fmtMins(doneRnd))}${sport.metric === "zone2" ? ` ${gray("Z2")}` : ""} / ${fmtMins(sport.targetMin)}${remStr}`,
      );

      for (const act of acts) {
        const durMins = Math.round(act.duration / 60);
        const z2m = Math.round((act.hrTimeInZone_2 ?? 0) / 60);
        const z3m = Math.round((act.hrTimeInZone_3 ?? 0) / 60);
        const z4m = Math.round((act.hrTimeInZone_4 ?? 0) / 60);
        const distStr = act.distance ? `  ${gray((act.distance / 1000).toFixed(1) + "km")}` : "";
        const hrStr = act.averageHR ? `  ${gray(act.averageHR + "bpm")}` : "";
        const dow = new Date(act.startTimeLocal).toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
        const zoneParts: string[] = [];
        if (z2m > 0) zoneParts.push(cyan(`Z2:${z2m}m`));
        if (z3m > 0) zoneParts.push(yell(`Z3:${z3m}m`));
        if (z4m > 0) zoneParts.push(red(`Z4:${z4m}m`));
        console.log(
          `     ${gray(dow)}  ${act.activityName}  ${gray(actLabel(act.activityType.typeKey))}  ${bold(fmtMins(durMins))}${distStr}${hrStr}${zoneParts.length ? "  " + zoneParts.join("  ") : ""}`,
        );
      }
    } else {
      console.log(`     ${gray("not logged yet")}`);
    }
    console.log();
  }
}

function renderZoneTotals(
  actZones: number[],
  nonActZones: number[],
  totalActivities: number,
  daysOfData: number,
  showDaily: boolean,
  goals: WeeklyZoneGoals,
): void {
  console.log(bold("  ZONE TOTALS"));
  const dailyNote = showDaily ? `· daily HR: ${daysOfData} days · non-activity zones are ~estimates` : "· daily HR skipped";
  console.log(gray(`  activities: ${totalActivities} ${dailyNote}`));
  console.log();
  console.log(gray(`  ${"".padEnd(14)}  ${"bar".padEnd(20)}  ${"activity".padEnd(8)}  ${"+ daily".padEnd(8)}  = total`));

  const ZONE_NAMES = ["Z1  rest", "Z2  aerobic", "Z3  tempo", "Z4  threshold", "Z5  max"];
  const ZONE_COLORS = [GR, CY, YL, RD, RD + B];

  let z45Total = 0;
  for (let i = 0; i < 5; i++) {
    if (i === 0) continue;
    const actM = Math.round(actZones[i]!);
    const dayM = Math.round(nonActZones[i]!);
    const total = actM + dayM;
    if (i >= 3) z45Total += total;
    if (total === 0) continue;
    const name = ZONE_NAMES[i]!.padEnd(14);
    const colorOn = ZONE_COLORS[i]!;
    const target = i === 1 ? goals.z2Mins : undefined;
    const b_ = target
      ? bar(total, target, 18)
      : `${colorOn}${"█".repeat(Math.min(Math.round(total / 6), 18)).padEnd(18, "░")}${R}`;
    const actStr = `${colorOn}${fmtMins(actM).padStart(5)}${R}`;
    const dayStr = dayM > 0 ? `  +${gray("~" + fmtMins(dayM).padStart(4))}` : "        ";
    const totStr = bold(fmtMins(total));
    const tgtStr = target ? (total >= target ? green(" ✓") : gray(` / ${fmtMins(target)}`)) : "";
    console.log(`  ${colorOn}${name}${R}  ${b_}  ${actStr}${dayStr}  = ${totStr}${tgtStr}`);
  }

  // Combined Z4+Z5 row (z45Total accumulated above)
  const z45Name = "Z4+Z5  hard".padEnd(14);
  const z45Bar = bar(z45Total, goals.z45Mins, 18);
  const z45Tgt = z45Total >= goals.z45Mins ? green(" ✓") : gray(` / ${fmtMins(goals.z45Mins)}`);
  console.log(`  ${RD}${z45Name}${R}  ${z45Bar}  ${"".padStart(18)}  = ${bold(fmtMins(z45Total))}${z45Tgt}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Week gathering & rendering
// ─────────────────────────────────────────────────────────────────────────────

interface WeekResult {
  monday: Date;
  sunday: Date;
  passedDates: string[];
  inWindow: Activity[];
  sportMap: Record<string, Activity[]>;
  unmatched: Activity[];
  actZones: number[];      // minutes per zone, activity-only
  nonActZones: number[];   // minutes per zone, non-activity estimate
  showDaily: boolean;
}

interface GatherOpts {
  noDaily: boolean;
  noCache: boolean;
  json: boolean;
}

/** Fetch + bucket a single Mon–Sun window. Side-effect free except for cache writes. */
function gatherWeek(monday: Date, config: Config, opts: GatherOpts): WeekResult {
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const now = new Date();
  const endOfRange = now < sunday ? now : sunday;
  const passedDates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    if (d <= endOfRange) passedDates.push(isoDate(d));
  }

  const todayStr = isoDate(now);
  const loader = opts.json ? (s: string) => process.stderr.write(s) : (s: string) => process.stdout.write(s);

  // Activities — limit 100 to cover high-volume athletes in a single week
  // (a doubles-tennis player can easily log 20+ short sessions). 40 was
  // enough for the original use case but truncated for power users.
  loader(gray("  loading activities…"));
  const ACTS_LIMIT = 100;
  const actsId = `${isoDate(monday)}__${ACTS_LIMIT}`;
  const isTodayInWindow = passedDates.includes(todayStr);
  const activities: Activity[] =
    garminCached<Activity[]>(
      `activities list --after ${isoDate(monday)} --limit ${ACTS_LIMIT}`,
      "activities",
      actsId,
      isTodayInWindow,
      { noCache: opts.noCache },
    ) ?? [];
  const sundayEnd = new Date(sunday);
  sundayEnd.setHours(23, 59, 59, 999);
  const inWindow = activities.filter((a) => {
    const t = new Date(a.startTimeLocal).getTime();
    return t >= monday.getTime() && t <= sundayEnd.getTime();
  });
  loader("\r" + " ".repeat(30) + "\r");

  const actsByDate: Record<string, Activity[]> = {};
  for (const act of inWindow) {
    const d = act.startTimeLocal.split(" ")[0]!;
    (actsByDate[d] ??= []).push(act);
  }

  // Non-activity zones (optional)
  const thresholds: ZoneThresholds = config.zones ?? DEFAULT_ZONES;
  const nonActZones = [0, 0, 0, 0, 0];
  if (!opts.noDaily) {
    loader(gray(`  loading daily HR (${passedDates.length} days)…`));
    for (const dateStr of passedDates) {
      const isToday = dateStr === todayStr;
      const hr = garminCached<{ heartRateValues?: Array<[number, number]> }>(
        `health heart-rate --date ${dateStr}`,
        "daily-hr",
        dateStr,
        isToday,
        { noCache: opts.noCache },
      );
      if (!hr?.heartRateValues) continue;
      const zones = nonActivityZones(hr.heartRateValues, actsByDate[dateStr] ?? [], thresholds);
      for (let i = 0; i < 5; i++) nonActZones[i]! += zones[i]!;
    }
    loader("\r" + " ".repeat(40) + "\r");
  }

  // Bucket into sports
  const configKeys = new Set(config.sports.map((s) => s.key));
  const sportMap: Record<string, Activity[]> = {};
  for (const s of config.sports) sportMap[s.key] = [];
  const unmatched: Activity[] = [];
  for (const act of inWindow) {
    const key = matchSport(act, configKeys);
    if (key && sportMap[key]) sportMap[key]!.push(act);
    else unmatched.push(act);
  }

  // Activity zone totals
  const actZones = [0, 0, 0, 0, 0];
  for (const act of inWindow) {
    actZones[0]! += (act.hrTimeInZone_1 ?? 0) / 60;
    actZones[1]! += (act.hrTimeInZone_2 ?? 0) / 60;
    actZones[2]! += (act.hrTimeInZone_3 ?? 0) / 60;
    actZones[3]! += (act.hrTimeInZone_4 ?? 0) / 60;
    actZones[4]! += (act.hrTimeInZone_5 ?? 0) / 60;
  }

  return {
    monday,
    sunday,
    passedDates,
    inWindow,
    sportMap,
    unmatched,
    actZones,
    nonActZones,
    showDaily: !opts.noDaily,
  };
}

/** Convert a WeekResult into the structured JSON payload. */
function weekToJson(week: WeekResult, config: Config) {
  const goals = config.weeklyZoneGoals ?? DEFAULT_WEEKLY_ZONE_GOALS;
  const sports = config.sports.map((sport) => {
    const acts = week.sportMap[sport.key] ?? [];
    const totalZ2 = acts.reduce((s, a) => s + (a.hrTimeInZone_2 ?? 0) / 60, 0);
    const totalDur = acts.reduce((s, a) => s + a.duration / 60, 0);
    const metric = sport.metric === "zone2" ? totalZ2 : totalDur;
    return {
      key: sport.key,
      name: sport.name,
      emoji: sport.emoji,
      targetMin: sport.targetMin,
      targetMax: sport.targetMax,
      metric: sport.metric,
      progressMins: Math.round(metric),
      done: metric >= sport.targetMin,
      activities: acts.map((a) => ({
        name: a.activityName,
        type: a.activityType.typeKey,
        startTimeLocal: a.startTimeLocal,
        durationMins: Math.round(a.duration / 60),
        distanceKm: a.distance ? +(a.distance / 1000).toFixed(2) : null,
        averageHR: a.averageHR ?? null,
        hrZoneMins: {
          z1: Math.round((a.hrTimeInZone_1 ?? 0) / 60),
          z2: Math.round((a.hrTimeInZone_2 ?? 0) / 60),
          z3: Math.round((a.hrTimeInZone_3 ?? 0) / 60),
          z4: Math.round((a.hrTimeInZone_4 ?? 0) / 60),
          z5: Math.round((a.hrTimeInZone_5 ?? 0) / 60),
        },
      })),
    };
  });

  return {
    week: {
      monday: isoDate(week.monday),
      sunday: isoDate(week.sunday),
      daysOfData: week.passedDates.length,
    },
    sports,
    unmatched: week.unmatched.map((a) => ({
      name: a.activityName,
      type: a.activityType.typeKey,
      startTimeLocal: a.startTimeLocal,
      durationMins: Math.round(a.duration / 60),
    })),
    zoneTotalsMins: {
      activity: {
        z1: Math.round(week.actZones[0]!),
        z2: Math.round(week.actZones[1]!),
        z3: Math.round(week.actZones[2]!),
        z4: Math.round(week.actZones[3]!),
        z5: Math.round(week.actZones[4]!),
      },
      nonActivity: {
        z1: Math.round(week.nonActZones[0]!),
        z2: Math.round(week.nonActZones[1]!),
        z3: Math.round(week.nonActZones[2]!),
        z4: Math.round(week.nonActZones[3]!),
        z5: Math.round(week.nonActZones[4]!),
      },
    },
    totalActiveMins: Math.round(week.inWindow.reduce((s, a) => s + a.duration / 60, 0)),
    weeklyGoals: goals ?? DEFAULT_WEEKLY_ZONE_GOALS,
  };
}

function renderSingleWeek(week: WeekResult, config: Config): void {
  const weekLabel = [week.monday, week.sunday]
    .map((d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))
    .join(" – ");
  const SEP = gray("  " + "─".repeat(62));

  console.log();
  console.log(`  ${bold(cyan("WEEKLY TRAINING"))}  ${gray("·")}  ${bold(weekLabel)}`);
  console.log(SEP);
  console.log();

  renderSportsChecklist(config.sports, week.sportMap);

  if (week.unmatched.length > 0) {
    console.log(gray(`  unmatched (${week.unmatched.length}):`));
    for (const a of week.unmatched) {
      const dow = new Date(a.startTimeLocal).toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
      console.log(
        `     ${gray(dow)}  ${a.activityName}  ${gray(actLabel(a.activityType.typeKey))}  ${bold(fmtMins(a.duration / 60))}`,
      );
    }
    console.log(
      gray(`     ${yell("hint:")} to track these, add a sport with a matching key via `) +
        bold("garmin-zones setup --reset"),
    );
    console.log();
  }

  console.log(SEP);
  console.log();
  const goals = config.weeklyZoneGoals ?? DEFAULT_WEEKLY_ZONE_GOALS;
  renderZoneTotals(week.actZones, week.nonActZones, week.inWindow.length, week.passedDates.length, week.showDaily, goals);

  const totalActive = Math.round(week.inWindow.reduce((s, a) => s + a.duration / 60, 0));
  console.log();
  console.log(`  ${gray("total active:")}  ${bold(fmtMins(totalActive))}`);
  console.log();
}

/** --today: a single-day breakdown. Skips daily HR (single-day focus). */
function renderTodayView(config: Config, args: CliArgs): number {
  const now = new Date();
  const todayStr = isoDate(now);
  const todayLabel = now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });

  const loader = args.json ? (s: string) => process.stderr.write(s) : (s: string) => process.stdout.write(s);
  loader(gray("  loading today's activities…"));
  const acts =
    garminCached<Activity[]>(
      `activities list --after ${todayStr} --limit 50`,
      "activities",
      `today__${todayStr}`,
      true,
      { noCache: args.noCache },
    ) ?? [];
  loader("\r" + " ".repeat(40) + "\r");

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const todays = acts.filter((a) => {
    const t = new Date(a.startTimeLocal).getTime();
    return t >= startOfDay.getTime() && t <= endOfDay.getTime();
  });

  const configKeys = new Set(config.sports.map((s) => s.key));

  if (args.json) {
    const payload = {
      date: todayStr,
      activities: todays.map((a) => ({
        name: a.activityName,
        type: a.activityType.typeKey,
        startTimeLocal: a.startTimeLocal,
        durationMins: Math.round(a.duration / 60),
        distanceKm: a.distance ? +(a.distance / 1000).toFixed(2) : null,
        averageHR: a.averageHR ?? null,
        matchedSport: matchSport(a, configKeys),
      })),
      totalActiveMins: Math.round(todays.reduce((s, a) => s + a.duration / 60, 0)),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return EXIT.OK;
  }

  console.log();
  console.log(`  ${bold(cyan("TODAY"))}  ${gray("·")}  ${bold(todayLabel)}`);
  console.log(gray("  " + "─".repeat(62)));
  console.log();
  if (todays.length === 0) {
    console.log(gray("  no activities logged yet today."));
    console.log();
    return EXIT.OK;
  }
  for (const a of todays) {
    const durMins = Math.round(a.duration / 60);
    const z2m = Math.round((a.hrTimeInZone_2 ?? 0) / 60);
    const z3m = Math.round((a.hrTimeInZone_3 ?? 0) / 60);
    const z4m = Math.round((a.hrTimeInZone_4 ?? 0) / 60);
    const distStr = a.distance ? `  ${gray((a.distance / 1000).toFixed(1) + "km")}` : "";
    const hrStr = a.averageHR ? `  ${gray(a.averageHR + "bpm")}` : "";
    const sport = matchSport(a, configKeys);
    const sportStr = sport ? `  ${green("→ " + sport)}` : `  ${yell("→ unmatched")}`;
    const zoneParts: string[] = [];
    if (z2m > 0) zoneParts.push(cyan(`Z2:${z2m}m`));
    if (z3m > 0) zoneParts.push(yell(`Z3:${z3m}m`));
    if (z4m > 0) zoneParts.push(red(`Z4:${z4m}m`));
    console.log(
      `  ${a.activityName}  ${gray(actLabel(a.activityType.typeKey))}  ${bold(fmtMins(durMins))}${distStr}${hrStr}${zoneParts.length ? "  " + zoneParts.join("  ") : ""}${sportStr}`,
    );
  }
  const total = Math.round(todays.reduce((s, a) => s + a.duration / 60, 0));
  console.log();
  console.log(`  ${gray("total active:")}  ${bold(fmtMins(total))}`);
  console.log();
  return EXIT.OK;
}

/** --last N: compact summary of last N weeks side-by-side. */
function renderLastNView(config: Config, args: CliArgs, n: number): number {
  const weeks: WeekResult[] = [];
  const thisMonday = getWeekMonday();
  for (let i = n - 1; i >= 0; i--) {
    const mon = new Date(thisMonday);
    mon.setDate(thisMonday.getDate() - i * 7);
    if (!args.json) {
      process.stdout.write(gray(`  fetching week of ${isoDate(mon)}…  `));
    } else {
      process.stderr.write(gray(`  fetching week of ${isoDate(mon)}…  `));
    }
    const w = gatherWeek(mon, config, { noDaily: true, noCache: args.noCache, json: args.json });
    weeks.push(w);
    if (!args.json) process.stdout.write("\r" + " ".repeat(50) + "\r");
    else process.stderr.write("\r" + " ".repeat(50) + "\r");
  }

  if (args.json) {
    const payload = {
      weeks: weeks.map((w) => weekToJson(w, config)),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return EXIT.OK;
  }

  // Render compact grid: rows are sports, columns are weeks, each cell is a status glyph.
  console.log();
  console.log(`  ${bold(cyan(`LAST ${n} WEEKS`))}  ${gray("·")}  ${bold(isoDate(weeks[0]!.monday))} → ${bold(isoDate(weeks[n - 1]!.sunday))}`);
  console.log(gray("  " + "─".repeat(62)));
  console.log();

  // Column headers — abbreviated MM/DD of each Monday
  const colHeaders = weeks.map((w) => {
    const m = String(w.monday.getMonth() + 1).padStart(2, "0");
    const d = String(w.monday.getDate()).padStart(2, "0");
    return `${m}/${d}`;
  });
  const sportColWidth = Math.max(...config.sports.map((s) => s.name.length)) + 4;
  console.log(
    "  " + gray("sport".padEnd(sportColWidth)) + colHeaders.map((h) => gray(h.padStart(7))).join(""),
  );

  for (const sport of config.sports) {
    const row: string[] = [];
    for (const w of weeks) {
      const acts = w.sportMap[sport.key] ?? [];
      const totalZ2 = acts.reduce((s, a) => s + (a.hrTimeInZone_2 ?? 0) / 60, 0);
      const totalDur = acts.reduce((s, a) => s + a.duration / 60, 0);
      const metric = sport.metric === "zone2" ? totalZ2 : totalDur;
      const m = Math.round(metric);
      if (m === 0) row.push(gray("  ·   "));
      else if (m >= sport.targetMin) row.push(green(`  ${m}m`.padStart(7)));
      else row.push(yell(`  ${m}m`.padStart(7)));
    }
    console.log(
      "  " + `${sport.emoji}  ${bold(sport.name)}`.padEnd(sportColWidth + 4) + row.join(""),
    );
  }

  // Totals row
  console.log();
  const totals = weeks.map((w) => Math.round(w.inWindow.reduce((s, a) => s + a.duration / 60, 0)));
  const totalsRow = totals.map((t) => gray(fmtMins(t).padStart(7))).join("");
  console.log("  " + gray("total".padEnd(sportColWidth)) + totalsRow);
  console.log();

  console.log(gray("  legend: ") + green("met target") + gray("  ") + yell("under target") + gray("  ") + gray("·") + gray(" not logged"));
  console.log();
  return EXIT.OK;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return EXIT.OK;
  }

  if (args.version) {
    console.log(readPackageVersion());
    return EXIT.OK;
  }

  if (args.unknown.length > 0) {
    console.log();
    console.log(red(`  Unknown argument(s): ${args.unknown.join(" ")}`));
    console.log(gray(`  Run "garmin-zones --help" for usage.`));
    console.log();
    return EXIT.USER_ERROR;
  }

  if (args.lastInvalid !== null) {
    console.log();
    console.log(red(`  Invalid --last value: "${args.lastInvalid}". Expected an integer between 1 and 12.`));
    console.log();
    return EXIT.USER_ERROR;
  }

  if (args.setup) {
    await runSetupWizard(args.resetSetup);
    return EXIT.OK;
  }

  // First-run detection
  let config = loadConfig();
  if (!config) {
    console.log();
    console.log(yell("  No config found — let's set up your weekly plan."));
    config = await runSetupWizard(false);
  }

  // Preflight: garmin-connect CLI
  if (!garminBinaryAvailable()) {
    const out = args.json ? console.error : console.log;
    out();
    out(red("  garmin-connect CLI not found in PATH."));
    out(gray("  Install it with:  ") + bold("bun add -g garmin-connect"));
    out();
    return EXIT.MISSING_DEPENDENCY;
  }

  // Preflight: auth (with classified hint)
  const auth = garminAuthOk();
  if (!auth.ok) {
    const out = args.json ? console.error : console.log;
    const kindLabel: Record<AuthFailureKind, string> = {
      not_logged_in: "You are not logged in to Garmin Connect.",
      token_expired: "Your Garmin Connect session has expired.",
      rate_limited: "Garmin Connect rate-limited the request.",
      unknown: "Garmin Connect authentication is not active.",
    };
    out();
    out(red("  " + kindLabel[auth.kind ?? "unknown"]));
    if (auth.message) out(gray(`  ${auth.message}`));
    out(gray("  Fix: ") + bold(auth.remedy ?? "garmin-connect auth login"));
    out();
    return EXIT.AUTH_FAILURE;
  }

  // --refresh: nuke the cache up front
  if (args.refresh) clearCache();

  // ─── --today ────────────────────────────────────────────────────────────
  if (args.today) {
    return renderTodayView(config, args);
  }

  // ─── --last N ───────────────────────────────────────────────────────────
  if (args.last !== null) {
    return renderLastNView(config, args, args.last);
  }

  // ─── single week ────────────────────────────────────────────────────────
  let monday: Date;
  if (args.week) {
    const parsed = parseWeekFlag(args.week);
    if (!parsed) {
      const out = args.json ? console.error : console.log;
      out(red(`  Invalid --week date: "${args.week}". Expected YYYY-MM-DD.`));
      return EXIT.USER_ERROR;
    }
    monday = parsed;
  } else {
    monday = getWeekMonday();
  }

  const week = gatherWeek(monday, config, args);

  if (args.json) {
    process.stdout.write(JSON.stringify(weekToJson(week, config), null, 2) + "\n");
    return EXIT.OK;
  }

  renderSingleWeek(week, config);
  return EXIT.OK;
}

/**
 * Only run main() when this file is executed directly, not when imported by tests.
 * Bun sets `import.meta.main` to true for the entry point.
 */
if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code ?? EXIT.OK);
    })
    .catch((err) => {
      console.error(red("  Unexpected error:"), err?.message ?? err);
      process.exit(EXIT.USER_ERROR);
    });
}

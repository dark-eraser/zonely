#!/usr/bin/env bun
/**
 * garmin-weekly-zones
 * Weekly training zone tracker for Garmin Connect.
 *
 * Usage:
 *   garmin-zones                       Show current week
 *   garmin-zones --week 2026-06-08     Show specific week (Monday date)
 *   garmin-zones --no-daily            Skip daily HR fetch (faster)
 *   garmin-zones setup                 Run interactive setup wizard
 *   garmin-zones setup --reset         Reset and re-run setup
 *   garmin-zones --help                Show usage
 */

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

interface Activity {
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

interface Config {
  version: number;
  sports: Sport[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Config / setup
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), ".garmin-zones");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

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
  return fs.existsSync(CONFIG_PATH);
}

function loadConfig(): Config | null {
  if (!configExists()) return null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.sports) || parsed.sports.length === 0) return null;
    return { version: parsed.version ?? 1, sports: parsed.sports };
  } catch {
    return null;
  }
}

function saveConfig(cfg: Config) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function resetConfig() {
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
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
    const fallback: Config = { version: 1, sports: DEFAULT_SPORTS };
    saveConfig(fallback);
    return fallback;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const chosen: Sport[] = [];

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
  } finally {
    rl.close();
  }

  const cfg: Config = { version: 1, sports: chosen };
  saveConfig(cfg);

  console.log(gray("  " + "─".repeat(62)));
  console.log(green(`  Saved ${chosen.length} sport(s) to ${CONFIG_PATH}`));
  console.log();
  return cfg;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI argument parsing
// ─────────────────────────────────────────────────────────────────────────────

interface CliArgs {
  help: boolean;
  noDaily: boolean;
  week: string | null;
  setup: boolean;
  resetSetup: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, noDaily: false, week: null, setup: false, resetSetup: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--no-daily") args.noDaily = true;
    else if (a === "--week") {
      args.week = argv[++i] ?? null;
    } else if (a === "setup") {
      args.setup = true;
    } else if (a === "--reset" && args.setup) {
      args.resetSetup = true;
    } else if (a.startsWith("--week=")) {
      args.week = a.slice("--week=".length);
    }
  }
  return args;
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
  console.log(`    ${cyan("--week")} ${gray("YYYY-MM-DD")}   Show the week containing this date (defaults to current week)`);
  console.log(`    ${cyan("--no-daily")}            Skip daily HR fetch (faster; activities only)`);
  console.log(`    ${cyan("--help, -h")}            Show this help and exit`);
  console.log();
  console.log(bold("  SUBCOMMANDS"));
  console.log(`    ${cyan("setup")}                 Run interactive setup wizard`);
  console.log(`    ${cyan("setup --reset")}         Clear and re-run setup`);
  console.log();
  console.log(bold("  CONFIG"));
  console.log(`    ${gray(CONFIG_PATH)}`);
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

function parseWeekFlag(input: string): Date | null {
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

function garminAuthOk(): { ok: boolean; message?: string } {
  try {
    const out = execSync("garmin-connect auth status", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 });
    if (/logged\s*in/i.test(out) || /authenticated/i.test(out) || /ok/i.test(out)) return { ok: true };
    return { ok: false, message: out.trim() || "Auth status unclear" };
  } catch (e: any) {
    return { ok: false, message: (e?.stderr?.toString?.() || e?.message || "auth check failed").trim() };
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
function matchSport(act: Activity, configKeys: Set<string>): string | null {
  const type = act.activityType.typeKey;
  const durMin = act.duration / 60;
  const z2 = (act.hrTimeInZone_2 ?? 0) / 60;
  const z3 = (act.hrTimeInZone_3 ?? 0) / 60;
  const z4 = (act.hrTimeInZone_4 ?? 0) / 60;
  const effect = (act.trainingEffectLabel ?? "").toLowerCase();
  const msg = (act.aerobicTrainingEffectMessage ?? "").toLowerCase();
  const name = act.activityName.toLowerCase();

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
  if ((effect.includes("aerobic_base") || effect.includes("recovery") || msg.includes("aerobic_base")) && has("zone2")) return "zone2";
  if ((effect.includes("anaerobic") || effect.includes("vo2") || z3 + z4 > z2 + 10) && has("highIntensity")) return "highIntensity";
  if (z2 >= 10 && has("zone2")) return "zone2";

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-activity HR zone estimation
// ─────────────────────────────────────────────────────────────────────────────

function nonActivityZones(hrValues: Array<[number, number]>, dayActivities: Activity[]): number[] {
  const windows = dayActivities.map((a) => ({
    start: new Date(a.startTimeLocal).getTime(),
    end: new Date(a.startTimeLocal).getTime() + (a.duration + 180) * 1000,
  }));
  const zones = [0, 0, 0, 0, 0];
  for (const [ts, bpm] of hrValues) {
    if (windows.some((w) => ts >= w.start && ts <= w.end)) continue;
    if (bpm < 125) zones[0]! += 2;
    else if (bpm < 146) zones[1]! += 2;
    else if (bpm < 162) zones[2]! += 2;
    else if (bpm < 176) zones[3]! += 2;
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
): void {
  console.log(bold("  ZONE TOTALS"));
  const dailyNote = showDaily ? `· daily HR: ${daysOfData} days · non-activity zones are ~estimates` : "· daily HR skipped";
  console.log(gray(`  activities: ${totalActivities} ${dailyNote}`));
  console.log();
  console.log(gray(`  ${"".padEnd(14)}  ${"bar".padEnd(20)}  ${"activity".padEnd(8)}  ${"+ daily".padEnd(8)}  = total`));

  const ZONE_NAMES = ["Z1  rest", "Z2  aerobic", "Z3  tempo", "Z4  threshold", "Z5  max"];
  const ZONE_COLORS = [GR, CY, YL, RD, RD + B];

  for (let i = 0; i < 5; i++) {
    if (i === 0) continue;
    const actM = Math.round(actZones[i]!);
    const dayM = Math.round(nonActZones[i]!);
    const total = actM + dayM;
    if (total === 0) continue;
    const name = ZONE_NAMES[i]!.padEnd(14);
    const colorOn = ZONE_COLORS[i]!;
    const target = i === 1 ? 60 : undefined;
    const b_ = target
      ? bar(total, target, 18)
      : `${colorOn}${"█".repeat(Math.min(Math.round(total / 6), 18)).padEnd(18, "░")}${R}`;
    const actStr = `${colorOn}${fmtMins(actM).padStart(5)}${R}`;
    const dayStr = dayM > 0 ? `  +${gray("~" + fmtMins(dayM).padStart(4))}` : "        ";
    const totStr = bold(fmtMins(total));
    const tgtStr = target ? (total >= target ? green(" ✓") : gray(` / ${fmtMins(target)}`)) : "";
    console.log(`  ${colorOn}${name}${R}  ${b_}  ${actStr}${dayStr}  = ${totStr}${tgtStr}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (args.setup) {
    await runSetupWizard(args.resetSetup);
    return;
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
    console.log();
    console.log(red("  garmin-connect CLI not found in PATH."));
    console.log(gray("  Install it with:  ") + bold("bun add -g garmin-connect"));
    console.log();
    process.exit(1);
  }

  // Preflight: auth
  const auth = garminAuthOk();
  if (!auth.ok) {
    console.log();
    console.log(red("  Garmin Connect authentication is not active."));
    if (auth.message) console.log(gray(`  ${auth.message}`));
    console.log(gray("  Login with:  ") + bold("garmin-connect auth login"));
    console.log();
    process.exit(1);
  }

  // Week selection
  let monday: Date;
  if (args.week) {
    const parsed = parseWeekFlag(args.week);
    if (!parsed) {
      console.log(red(`  Invalid --week date: "${args.week}". Expected YYYY-MM-DD.`));
      process.exit(1);
    }
    monday = parsed;
  } else {
    monday = getWeekMonday();
  }
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const today = new Date();
  const endOfRange = today < sunday ? today : sunday;
  const passedDates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    if (d <= endOfRange) passedDates.push(isoDate(d));
  }

  const weekLabel = [monday, sunday]
    .map((d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))
    .join(" – ");
  const SEP = gray("  " + "─".repeat(62));

  console.log();
  console.log(`  ${bold(cyan("WEEKLY TRAINING"))}  ${gray("·")}  ${bold(weekLabel)}`);
  console.log(SEP);
  console.log();

  // Activities
  process.stdout.write(gray("  loading activities…"));
  const activities: Activity[] = garmin<Activity[]>(`activities list --after ${isoDate(monday)} --limit 40`) ?? [];
  // Filter to within the requested week
  const sundayEnd = new Date(sunday);
  sundayEnd.setHours(23, 59, 59, 999);
  const inWindow = activities.filter((a) => {
    const t = new Date(a.startTimeLocal).getTime();
    return t >= monday.getTime() && t <= sundayEnd.getTime();
  });
  process.stdout.write("\r" + " ".repeat(30) + "\r");

  const actsByDate: Record<string, Activity[]> = {};
  for (const act of inWindow) {
    const d = act.startTimeLocal.split(" ")[0]!;
    (actsByDate[d] ??= []).push(act);
  }

  // Non-activity zones (optional)
  const nonActZones = [0, 0, 0, 0, 0];
  if (!args.noDaily) {
    process.stdout.write(gray(`  loading daily HR (${passedDates.length} days)…`));
    for (const dateStr of passedDates) {
      const hr = garmin<{ heartRateValues?: Array<[number, number]> }>(`health heart-rate --date ${dateStr}`);
      if (!hr?.heartRateValues) continue;
      const zones = nonActivityZones(hr.heartRateValues, actsByDate[dateStr] ?? []);
      for (let i = 0; i < 5; i++) nonActZones[i]! += zones[i]!;
    }
    process.stdout.write("\r" + " ".repeat(40) + "\r");
  }

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

  renderSportsChecklist(config.sports, sportMap);

  if (unmatched.length > 0) {
    console.log(gray(`  unmatched (${unmatched.length}):`));
    for (const a of unmatched) {
      const dow = new Date(a.startTimeLocal).toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
      console.log(
        `     ${gray(dow)}  ${a.activityName}  ${gray(actLabel(a.activityType.typeKey))}  ${bold(fmtMins(a.duration / 60))}`,
      );
    }
    console.log();
  }

  console.log(SEP);
  console.log();
  renderZoneTotals(actZones, nonActZones, inWindow.length, passedDates.length, !args.noDaily);

  const totalActive = Math.round(inWindow.reduce((s, a) => s + a.duration / 60, 0));
  console.log();
  console.log(`  ${gray("total active:")}  ${bold(fmtMins(totalActive))}`);
  console.log();
}

main().catch((err) => {
  console.error(red("  Unexpected error:"), err?.message ?? err);
  process.exit(1);
});

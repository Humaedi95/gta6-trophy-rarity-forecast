// gta6-trophy-rarity-forecast — forecast Exophase earn rates for GTA VI (PS5).
//
// Reads one case file per run (makefun/gta6-trophies-case/v1) from
// $MAKEFUN_INPUT_DIR (else /input) and writes one forecast per case to
// $MAKEFUN_OUTPUT_DIR (else /output): five quantiles (5/25/50/75/95%) of
// each trophy's earn rate at the case target.
//
// Model, in brief (no network, no fitted answers — everything is derived
// from the case's own history at run time):
//   * Earn counts c = rate * players_tracked / 100 are the real quantity.
//     Per trophy, a robust log-linear trend of log(c) against time is fit
//     when the history actually moves; when it does not, existing players
//     are assumed to keep earning on an exponential waiting-time curve
//     (a trophy at rate r after exposure E reaches 1 - (1 - r)^(1 + g)
//     after exposure grows by a factor 1 + g).
//   * Players tracked N is forecast the same way, plus a "refresh is due"
//     term: Exophase holds its counts stale for hours and then jumps.
//     When N has been flat since some read, the shown count is treated as
//     fresh as of that read and N is grown forward along a power law in
//     time since launch (exponent fit from the history when it moves,
//     0.55 prior otherwise — tracked populations grow roughly like the
//     square root of time since launch in the first week).
//   * Newly tracked players dilute the rates: they arrive holding each
//     trophy at a_i = 1 - (1 - r)^k, where k is their relative play
//     exposure (smaller for platinum/gold than for bronze — late-game
//     trophies are earned slowly by newcomers). The forecast rate is the
//     mix of the old cohort's grown counts and the new cohort's counts
//     over the forecast N.
//   * Quantiles live on the logit scale around the median, with a spread
//     that widens with horizon, with the size of the pending refresh
//     (log N growth), and with small-count noise. Flat/stale histories
//     therefore get honest wide bands instead of false precision.
//
// Deterministic: no randomness, no wall-clock use, pure function of the
// case file. Standard library only; runs under Node 22+ type stripping.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Standard-normal quantiles for the five levels [0.05, 0.25, 0.5, 0.75, 0.95].
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

const logit = (p: number): number => Math.log(p / (1 - p)); // p in (0, 1)
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

// Least-squares slope of y against x; null when the fit is not usable.
function olsSlope(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  if (sxx <= 1e-12 || !Number.isFinite(sxy / sxx)) return null;
  return sxy / sxx;
}

type Trophy = {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
};

type Read = {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: (number | null)[];
};

type CaseFile = {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { name: string; platform: string; release_date: string; source: string };
  trophies: Trophy[];
  history: Read[];
  notes: string;
};

// How fast newcomers earn a trophy, by tier, relative to bronze.
// Late-game trophies (platinum, gold) need far more play before a new
// player holds them; early bronze trophies are picked up quickly.
function tierFactor(tier: string): number {
  if (tier === "platinum") return 0.35;
  if (tier === "gold") return 0.55;
  if (tier === "silver") return 0.75;
  return 1;
}

function forecastCase(c: CaseFile): { trophies: { id: number; q: number[] }[] } {
  const horizonDays = Math.max(0, c.horizon_minutes / 1440);
  const launchMs = Date.parse(c.game.release_date + "T00:00:00Z");
  const targetMs = Date.parse(c.target);
  const atMs = Date.parse(c.at);

  // Hours since launch for a read time; clamped so the very first read,
  // which lands just before midnight on release day, still has a usable
  // (small, positive) age for the power-law growth of tracked players.
  const hoursSinceLaunch = (ms: number): number =>
    Math.max(0.25, (ms - launchMs) / 3600000);

  const reads = (c.history ?? []).filter(
    (r) => r && Number.isFinite(Date.parse(r.at)) && r.players_tracked > 0,
  );
  const nTrophies = c.trophies.length;

  // Last non-null rate per trophy, and the last players-tracked count.
  const lastRate: number[] = new Array(nTrophies).fill(NaN);
  let nLast = NaN;
  for (const r of reads) {
    nLast = r.players_tracked;
    for (let i = 0; i < nTrophies; i++) {
      const v = r.rates ? r.rates[i] : null;
      if (v !== null && v !== undefined && Number.isFinite(v)) lastRate[i] = v;
    }
  }
  // No usable history at all: fall back to a flat 1% prior with a wide
  // band rather than crashing. (Not expected for the real cases.)
  if (!Number.isFinite(nLast)) {
    return {
      trophies: c.trophies.map((t) => ({
        id: t.id,
        q: quantiles(1, 2),
      })),
    };
  }

  const targetHours = hoursSinceLaunch(targetMs);

  // --- Forecast the players-tracked count at the target. -------------
  // Power-law growth in time since launch, anchored at the first read
  // of the current flat run: the page shows the count as of its last
  // refresh, so a long flat run means a big pending jump. The exponent is
  // fit from the history's own log-log slope when it moves, else 0.55.
  // (A plain exponential trend of log N against time is NOT used: fitted
  // over the launch surge it extrapolates to absurd multiples over a
  // 4.6-day horizon, while tracked-population growth decays like a power
  // law in time since launch.)
  let beta: number | null = null;
  {
    const xs: number[] = [];
    const ys: number[] = [];
    const seen = new Set<number>();
    for (const r of reads) {
      if (seen.has(r.players_tracked)) continue;
      seen.add(r.players_tracked);
      xs.push(Math.log(hoursSinceLaunch(Date.parse(r.at))));
      ys.push(Math.log(r.players_tracked));
    }
    const s = olsSlope(xs, ys);
    if (s !== null) beta = clamp(s, 0.05, 1.2);
  }
  const betaEff = beta ?? 0.55;

  // First read of the current flat run of N (the last refresh point).
  let anchorIdx = reads.length - 1;
  while (anchorIdx > 0 && reads[anchorIdx - 1].players_tracked === nLast) anchorIdx--;
  const anchorHours = hoursSinceLaunch(Date.parse(reads[anchorIdx].at));
  // The page only ever jumps up at a refresh; cap the total jump so a
  // degenerate fit cannot run away.
  const nTarget = clamp(
    nLast * Math.pow(targetHours / anchorHours, betaEff),
    nLast,
    nLast * 60,
  );
  const dN = nTarget - nLast;
  const logGrowth = Math.log(nTarget / nLast);

  // --- Per-trophy forecast. ------------------------------------------
  const kappa0 = clamp(0.3 + 0.06 * horizonDays, 0.3, 0.65); // newcomer exposure
  const gamma0 = clamp(horizonDays / 7, 0, 1); // extra exposure, old cohort

  const out: { id: number; q: number[] }[] = [];
  for (let i = 0; i < nTrophies; i++) {
    const t = c.trophies[i];
    const rLast = Number.isFinite(lastRate[i]) ? lastRate[i] : 0;
    const pLast = clamp(rLast, 0, 100) / 100;
    const cLast = Math.round(pLast * nLast);
    const tf = tierFactor(t.tier);

    // Old cohort's counts at the target: fitted log-linear trend of log
    // earn-count against time when the history moves, else the
    // waiting-time curve 1 - (1 - r)^(1 + g).
    let cOld: number;
    {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const r of reads) {
        const v = r.rates ? r.rates[i] : null;
        if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) continue;
        const cnt = Math.round((v / 100) * r.players_tracked);
        if (cnt <= 0) continue;
        xs.push((Date.parse(r.at) - atMs) / 86400000);
        ys.push(Math.log(cnt));
      }
      const timeSpanDays = xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0;
      // A slope fit over less than 6 hours of counts is noise, not a
      // trend; fall back to the waiting-time curve there.
      const s = timeSpanDays >= 0.25 ? olsSlope(xs, ys) : null;
      if (s !== null) {
        cOld = cLast * Math.exp(clamp(s, 0, 2.5) * horizonDays);
      } else {
        const pOld = 1 - Math.pow(1 - pLast, 1 + gamma0 * tf);
        cOld = pOld * nLast;
      }
    }
    cOld = clamp(cOld, 0, nLast);

    // New cohort's earn rate for this trophy (waiting-time curve at a
    // fraction k of the old cohort's exposure).
    const kappa = kappa0 * tf;
    const pNew = 1 - Math.pow(1 - pLast, kappa);
    const cNew = pNew * dN;

    let median = (100 * (cOld + cNew)) / nTarget;
    if (pLast >= 1) median = 100; // a trophy everyone holds stays held
    if (pLast <= 0) median = Math.max(median, (100 * 0.25) / nTarget);
    median = clamp(median, 0.01, 99.99);

    // --- Spread on the logit scale. -----------------------------------
    // Random-walk term (house baseline shape) + refresh uncertainty,
    // which scales with the pending log jump in N + small-count noise.
    const countVar = Math.min(0.25, 1 / Math.max(cLast, 1));
    const refreshSd = 0.45 * logGrowth;
    const sd = clamp(
      Math.sqrt(0.25 * horizonDays + refreshSd * refreshSd + countVar),
      0.35,
      2.5,
    );

    out.push({ id: t.id, q: quantiles(median, sd) });
  }
  return { trophies: out };
}

// Five quantiles around a median (percent) with logit spread sd.
function quantiles(medianPct: number, sd: number): number[] {
  const m = clamp(medianPct, 0.01, 99.99);
  const base = logit(m / 100);
  const qs: number[] = [];
  for (let k = 0; k < 5; k++) {
    const v = clamp(sigmoid(base + Z[k] * sd) * 100, 0.01, 99.99);
    qs.push(round4(v));
  }
  // Rounding can only break monotonicity by a hair; enforce it.
  for (let k = 1; k < 5; k++) {
    if (qs[k] < qs[k - 1]) qs[k] = qs[k - 1];
  }
  return qs;
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  if (!existsSync(inputDir)) {
    throw new Error(`input dir not found: ${inputDir}`);
  }
  mkdirSync(outputDir, { recursive: true });
  const files = readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  if (files.length === 0) {
    throw new Error(`no .in case files in ${inputDir}`);
  }
  for (const f of files) {
    const raw = readFileSync(join(inputDir, f), "utf8");
    const c = JSON.parse(raw) as CaseFile;
    if (!c || !Array.isArray(c.trophies) || c.trophies.length === 0) {
      throw new Error(`bad case file: ${f}`);
    }
    const forecast = forecastCase(c);
    const outPath = join(outputDir, f.replace(/\.in$/, ".out"));
    writeFileSync(outPath, JSON.stringify(forecast), "utf8");
  }
}

main();

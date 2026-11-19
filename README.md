# gta6-trophy-rarity-forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Humaedi95/gta6-trophy-rarity-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Humaedi95/gta6-trophy-rarity-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts every GTA VI (PS5) trophy's Exophase earn rate at a case target, as five quantiles (5/25/50/75/95%) per trophy. The program is `main.ts` (Node 22, standard library only, offline, deterministic).

## How it works

Exophase holds its trophy counts stale for hours and then jumps, so a pure "rates stay where they are" forecast loses badly at a refresh. This forecaster works in earn counts, not rates:

- **Earn counts** `c = rate × players_tracked / 100` are the real quantity. Per trophy, a log-linear trend of `log(c)` against time is fit when the history actually moves; when the history is flat, existing players are assumed to keep earning on an exponential waiting-time curve.
- **Players tracked** is forecast with a power law in time since launch, anchored at the first read of the current flat run — a long flat run means a big pending refresh jump. The exponent is fit from the history when it moves (0.55 prior otherwise).
- **Dilution:** newly tracked players arrive holding each trophy at `1 − (1 − r)^k`, where `k` is their relative play exposure — smaller for platinum/gold than for bronze, since late-game trophies are earned slowly by newcomers. The forecast rate mixes the old cohort's grown counts with the new cohort's counts over the forecast player count.
- **Quantiles** live on the logit scale around the median, with a spread that widens with horizon, with the size of the pending refresh (log growth in players tracked), and with small-count noise — so flat, stale histories get honest wide bands instead of false precision.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit input dir> MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads every `*.in` case in the input directory and writes one `*.out` forecast per case. Each output is one JSON object, `{"trophies": [{"id": n, "q": [q05, q25, q50, q75, q95]}, ...]}`, one row per trophy, five finite non-decreasing quantiles in 0..100.

<sub>Entered on [make.fun](https://make.fun/?ref=spg1d5j0&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>

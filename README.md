# RCAA ERA BALL (REB) v1.02

A mobile-friendly RCAA roster builder and season simulator.

## What's included

- Classic four-player mode and five-player Bench mode
- Seasons 1–4, 6, 8–10, and 13–17
- Two-way lineup optimization and manual slot swaps
- RCAA-specific out-of-position penalties
- Six-game regular season, playoffs, Bowl, and complete simulated player stats
- MVP, OPOY, DPOY, Championship, and Super Bowl MVP effects
- Hindsight-based best possible roster comparison
- Player profile pictures in the draft choices and player cards
- Anonymous online multiplayer—friends do not create accounts
- Two-player Era Duel with independent Classic drafts
- Four-player fantasy snake draft using all 203 era cards
- Six-week fantasy league, point-differential tiebreakers, semifinal, and Bowl

## Multiplayer backend

This repository is connected to the Supabase project `RCAA-Era-Ball-v1.02`. Anonymous Auth, RLS-secured lobby tables, realtime subscriptions, fantasy snake-draft turn enforcement, and multiplayer state are configured for the browser build.

## Run locally

Serve the folder with a simple local web server. Multiplayer cannot be tested reliably from a `file://` URL.

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. No build command is required.

## Validate game data

```bash
node scripts/validate-game.cjs
node scripts/validate-multiplayer.cjs
```

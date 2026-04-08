# PostHog Impact Dashboard Final Plan

## Summary
Build a static single-page dashboard that identifies the top 5 most impactful engineers in `PostHog/posthog` using repository activity from January 7, 2026 through April 7, 2026.

Use:
- Vite
- React
- TypeScript
- one offline data script
- one optional agent-evaluation script
- one generated JSON file
- one static deploy
- no sandbox for commands that need network or external access

Non-goals:
- no backend
- no client-side GitHub fetches
- no placeholder UI
- no synthetic fallback data

## Implementation Changes
### Data pipeline
Create `scripts/build-impact.ts`.

Flow:
1. Read `GITHUB_TOKEN` when available
2. Pass 1: REST search all merged PRs in the 90-day window
3. Build rough author and reviewer scores from shallow PR metadata
4. Group related PRs by engineer + scope to reward initiative ownership
5. Select top 12 candidate engineers
6. Pass 2: fetch detailed PR metadata for candidate engineers only
7. Recompute final scores with repo-aware leverage, quality, scope, and initiative logic
8. Optionally run agent evaluation over the top 5 using cached evidence
9. Write `src/data/impact.json`

Fail fast if:
- API returns errors
- pagination is incomplete
- generated top 5 has missing evidence

### Pass 1: shallow fetch
For every merged PR in the window fetch:
- number
- title
- url
- mergedAt
- author login
- labels
- comments total
- reviews total

Use pass 1 for:
- rough delivery from `feat(...)`
- rough quality from `fix(...)`
- rough leverage from `refactor(...)`
- rough collaboration from review counts only as candidate selection input
- excluding bots and dependency automation

Do not use pass 1 for final evidence.

### Pass 2: deep fetch
For candidate engineers only, fetch detailed PR metadata:
- changed files count
- review comments count
- commit count

Use pass 2 to finalize:
- initiative strength
- scope
- coordination depth
- evidence summaries

### Agent evaluation
Create `scripts/evaluate-impact.ts`.

Purpose:
- use an LLM as a second-pass evaluator over cached evidence
- improve narrative quality and caveat quality
- never replace the deterministic ranking step

Inputs:
- generated top 5
- cached PR data
- cached detailed PR metadata
- methodology summary

Model behavior:
- call the NVIDIA OpenAI-compatible endpoint when `NVIDIA_API_KEY` is present
- evaluate each leader independently
- return structured JSON only
- do not persist raw reasoning traces

Outputs per leader:
- `agentSummary`
- `agentStrengths`
- `agentRisks`
- `agentImpactType`
- `agentWhyTopFive`

Rules:
- agent evaluation is optional and additive
- deterministic ordering remains the source of truth
- if `NVIDIA_API_KEY` is missing, skip this step cleanly
- cache agent outputs locally

### Repo-aware classification
Use actual repo area groups from the PostHog repo.

Groups:
- product UI: `frontend`, `products`, `staticfiles`
- backend/core: `posthog`, `ee`, `services`
- platform/shared: `common`, `share`, `proto`, `rust`
- dev tooling: `.github`, `bin`, `tools`, `docker`, `playwright`, `terraform`, `devenv`

PR intent from title prefix:
- `feat` -> delivery by default
- `fix` -> quality by default
- `refactor` -> leverage by default
- `chore` -> ignored unless paths show real leverage or quality

Path refinement:
- leverage if PR primarily touches platform/shared or dev-tooling areas
- delivery if PR primarily touches product UI or backend/core and is feature-oriented
- quality if title/review/body/path signals bug fix, reliability, performance, security, or test stabilization
- scope if PR spans at least 2 repo area groups, with full scope credit at 3+

Exclude from ranking:
- bots
- dependency-only PRs
- merge queue / automation noise
- pure snapshot churn unless paired with meaningful code changes
- changelog / release automation

### Scoring
Use 5 internal dimensions to order the top 5 only.

Weights:
- delivery: 30
- leverage: 25
- quality: 20
- collaboration: 15
- scope: 10

Rules:
- score is internal for ordering only and is never shown in the UI
- evidence is the primary output
- LOC, commit count, raw PR count, and raw review count cannot drive ranking
- the user-facing dashboard explains impact through themes, archetypes, and proof, not numbers

Per-PR author scoring:
- classify PR into one or more dimensions
- apply a light importance multiplier from discussion depth
- no size multiplier from additions/deletions

Initiative scoring:
- group PRs by engineer + scope
- reward sustained multi-PR sequences
- route bonus toward delivery for product initiatives
- route bonus toward leverage for platform / infra initiatives
- add scope credit for end-to-end multi-PR ownership

Collaboration scoring:
- use visible coordination signals from discussion and review-comment depth
- boost collaboration credit when the underlying PR itself scores on delivery, leverage, or quality
- upgrade to direct reviewer attribution only if the detail fetch explicitly includes review authors and states

Aggregation:
- sum raw points per engineer
- normalize each dimension against the top engineer in that dimension
- use the combined result only to decide ordering, not as a displayed artifact

Archetype:
- highest dimension wins
- labels:
  - `Feature Driver`
  - `Infrastructure Multiplier`
  - `Reliability Owner`
  - `Review Backbone`
  - `Cross-Cutting Builder`

### Output contract
Generate `src/data/impact.json`.

Shape:
- `generatedAt`
- `timeframe`
- `methodology`
- `leaders`

Each leader includes:
- `login`
- `rank`
- `impactScore`
- `archetype`
- `scoreBreakdown`
- `whyTheyRanked`
- `evidence`
- optional agent-evaluation fields

Evidence item:
- `kind`
- `title`
- `url`
- `summary`

Constraints:
- exactly 5 leaders
- each leader has 3 to 5 evidence items
- every evidence item maps to a scored PR or scored review
- numeric ranking artifacts are internal only

### UI
Implement one page in `src/App.tsx`.

Visible on first screen:
- page title
- exact timeframe
- one-line impact definition
- methodology strip without numeric weights
- top 5 leaderboard

Each leader card shows:
- login
- archetype
- strongest contribution themes
- 3 short reasons
- 3 to 5 evidence links
- optional agent read with short summary, strengths, and one caveat

Bottom note:
- this measures repo-visible impact only
- it does not measure planning, mentoring outside GitHub, or non-repo incident leadership

No tabs.
No filters.
No numeric score display.
No exposed model weights.

## Test Plan
- script exits on GitHub API errors
- merged PR window is exactly January 7, 2026 through April 7, 2026
- bots and dependency automation are excluded
- candidate pool is exactly 12 before deep fetch
- final output contains exactly 5 leaders
- each leader has at least 3 evidence items
- no leader ranks from raw activity alone
- a feature-heavy engineer and an infra-heavy engineer can both rank highly
- review-heavy engineers can surface but cannot win on reviews alone
- app builds from local JSON only
- build fails if JSON shape is invalid
- if `GITHUB_TOKEN` is absent, cached search-only analysis still works
- if `NVIDIA_API_KEY` is absent, the dashboard still works without agent fields
- agent output is cached and reused on repeated runs
- raw reasoning is never shown in the UI or stored in JSON

## Assumptions
- Use REST throughout, with auth when available
- Use NVIDIA agent evaluation only as a narrative overlay, not a ranking source
- Current PR naming conventions in PostHog are stable enough to use as a signal
- Repo structure from [PostHog/posthog](https://github.com/PostHog/posthog) is the basis for path grouping
- Recent PR patterns from [PostHog/posthog pull requests](https://github.com/PostHog/posthog/pulls) justify prefix-first classification
- Evidence quality matters more than model complexity

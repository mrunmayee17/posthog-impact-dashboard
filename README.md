# PostHog Impact Dashboard

Single-page dashboard that ranks the top 5 repo-visible engineers in `PostHog/posthog` over the last 90 days.

## Stack

- React
- TypeScript
- Vite
- Node.js scripts
- GitHub REST API
- NVIDIA `nvidia/nemotron-3-super-120b-a12b` for agent evaluation
- Vercel

## Approach

The dashboard scores engineering impact across five dimensions:

- Delivery
- Leverage
- Quality
- Coordination
- Scope

The data pipeline pulls merged pull requests, filters bots and dependency churn, groups related PRs into initiatives, and generates a local JSON dataset. The UI reads that dataset and shows the top 5 engineers, score distribution, linked evidence, and agent-written interpretation.

## Scoring

The total score is capped at `100`.

- Delivery: max `30`
  - Measures shipped feature work and product-facing initiative ownership.
  - Built from `feature PR` evidence and `initiative` bonus.
  - Displayed as `normalized(raw delivery input)`.

- Leverage: max `25`
  - Measures shared-system, infrastructure, tooling, and platform work.
  - Built from `shared-system PR` evidence and `platform initiative` bonus.
  - Displayed as `normalized(raw leverage input)`.

- Quality: max `20`
  - Measures fixes, reliability work, and visible risk reduction.
  - Built from `fix/reliability PR` evidence.
  - Displayed as `normalized(raw quality input)`.

- Coordination: max `15`
  - Measures discussion depth and coordination around meaningful changes.
  - Built from `discussion signal` evidence and `initiative coordination signal`.
  - Displayed as `normalized(raw coordination input)`.

- Scope: max `10`
  - Measures breadth across related work and sustained multi-PR sequences.
  - Built from `initiative sequence` evidence and, when present, `broad PR` evidence.
  - Displayed as `normalized(raw scope input)`.

For each engineer, the dashboard shows:

- the normalized score for each dimension
- the raw value before normalization
- the component breakdown behind that raw value
- linked PR evidence used to support the ranking

## Scripts

```bash
npm run build:data
npm run eval:agent
npm run build
```

## Environment

```bash
GITHUB_TOKEN=...
NVIDIA_API_KEY=...
```

## Deploy

Production:

- https://project-ef6jg.vercel.app

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

import data from "./data/impact.json";
import type { Dimension, ImpactData, Leader } from "./types";

const model = data as ImpactData;
const dims: Dimension[] = ["delivery", "leverage", "quality", "collaboration", "scope"];
const labels: Record<Dimension, string> = {
  delivery: "Delivery",
  leverage: "Leverage",
  quality: "Quality",
  collaboration: "Coordination",
  scope: "Scope"
};
const explainers: Record<Dimension, { up: string; formula: string; why: string; down: string }> = {
  delivery: {
    up: "Feature rollouts, product movement, and user-facing shipping.",
    formula: "delivery = normalized initiative shipping + feature PR evidence",
    why: "High when an engineer repeatedly lands feature work or owns a multi-PR rollout.",
    down: "Few shipped changes or work that stayed too isolated."
  },
  leverage: {
    up: "Platform, CI, tooling, shared systems, and enablement work.",
    formula: "leverage = normalized shared-system PRs + infra/tooling initiative evidence",
    why: "High when work helps other engineers move faster or makes the system easier to build on.",
    down: "Little evidence of reusable or multiplier-style contributions."
  },
  quality: {
    up: "Fixes, reliability, cleanup, and reduced risk.",
    formula: "quality = normalized fix/reliability PRs + risk-reduction evidence",
    why: "High when the engineer clearly reduces bugs, regressions, or maintenance cost.",
    down: "Few visible signs of correctness or reliability ownership."
  },
  collaboration: {
    up: "Discussion depth, coordination, and cross-team change shaping.",
    formula: "coordination = normalized review depth + important PR discussion signals",
    why: "High when the engineer shapes important changes through reviews and visible coordination.",
    down: "Less visible coordination around important PRs."
  },
  scope: {
    up: "Multi-PR initiatives and broader cross-area ownership.",
    formula: "scope = normalized repo-area breadth + sustained initiative sequences",
    why: "High when the work spans several areas or continues across multiple linked PRs.",
    down: "Narrower contributions concentrated in fewer areas."
  }
};

function topSignals(leader: Leader) {
  return [...dims]
    .sort((a, b) => leader.scoreBreakdown[b] - leader.scoreBreakdown[a])
    .filter((key) => leader.scoreBreakdown[key] > 0)
    .slice(0, 3);
}

function modelSummary() {
  return "Internal impact score orders the top 5. Max score is 100 total from delivery 30, leverage 25, quality 20, coordination 15, and scope 10. Every rank is backed by linked evidence.";
}

function methodology() {
  return (
    <section className="method">
      <div className="method-copy">
        <p className="eyebrow">How Ranking Works</p>
        <h2 className="section-title">Who ranked high, why, and what moved the score</h2>
        <div className="method-lede">
          <p>One internal score orders the top 5.</p>
          <p>That score is built from five dimensions.</p>
          <p>Max score is 100, and high numbers matter only when the linked PR evidence supports the story.</p>
        </div>
      </div>
      <div className="method-grid">
        {dims.map((key) => (
          <article key={key} className="method-card">
            <span>{labels[key]} {model.methodology.weights[key]}</span>
            <p>{explainers[key].up}</p>
            <strong>Formula:</strong>
            <p>{explainers[key].formula}</p>
            <strong>Why it rises:</strong>
            <p>{explainers[key].why}</p>
            <strong>Lost points:</strong>
            <p>{explainers[key].down}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function scoreLine(leader: Leader) {
  return `${leader.impactScore} total`;
}

function countLabel(count: number, label: string) {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function partLines(leader: Leader, key: Dimension) {
  return leader.scoreInputs[key].parts.map((part) => `${part.value} from ${countLabel(part.count, part.label)}`);
}

function scoreFormula(leader: Leader, key: Dimension) {
  return `${leader.scoreBreakdown[key]} = normalized(${leader.scoreInputs[key].raw} raw)`;
}

function breakdown(leader: Leader) {
  return dims.map((key) => (
    <div key={key} className="metric">
      <div className="metric-label">
        <span>{labels[key]}</span>
        <strong>{leader.scoreBreakdown[key]}</strong>
      </div>
      <div className="metric-track" aria-hidden="true">
        <div className="metric-fill" style={{ width: `${(leader.scoreBreakdown[key] / model.methodology.weights[key]) * 100}%` }} />
      </div>
    </div>
  ));
}

function card(leader: Leader) {
  return (
    <article key={leader.login} className="card">
      <div className="card-top">
        <div>
          <p className="eyebrow">{leader.rank === 1 ? "Most Visible Impact" : "High Visible Impact"}</p>
          <h2>{leader.login}</h2>
        </div>
        <div className="score">
          <strong>{scoreLine(leader)}</strong>
          <span>{leader.archetype}</span>
        </div>
      </div>
      <div className="metrics">{breakdown(leader)}</div>
      <div className="signals">
        {topSignals(leader).map((key) => (
          <span key={key} className="signal">{labels[key]}</span>
        ))}
      </div>
      {leader.agentSummary ? (
        <section className="agent">
          <p className="agent-kicker">Agent Read</p>
          <p className="agent-summary">{leader.agentSummary}</p>
          <div className="agent-line">
            <strong>{leader.agentImpactType}</strong>
            <span>{leader.agentWhyTopFive}</span>
          </div>
          <p className="agent-rank">{leader.agentRankReason}</p>
          <div className="agent-dims">
            {dims.map((key) => (
              <div key={key} className="agent-dim">
                <span>{labels[key]}</span>
                <strong>{leader.scoreBreakdown[key]} · {leader.agentDimensionRead?.[key]}</strong>
                <p>{leader.agentDimensionReason?.[key]}</p>
              </div>
            ))}
          </div>
          <ul className="agent-list">
            {leader.agentStrengths?.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="agent-risk">{leader.agentRisks?.[0]}</p>
        </section>
      ) : null}
      <div className="evidence">
        {leader.evidence.map((item) => (
          <a key={item.url} href={item.url} target="_blank" rel="noreferrer">
            <span>{item.kind.toUpperCase()}</span>
            <strong>{item.title}</strong>
            {item.agentNote ? <p className="evidence-note">{item.agentNote}</p> : null}
          </a>
        ))}
      </div>
    </article>
  );
}

export default function App() {
  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">PostHog / Engineering Impact</p>
        <div className="hero-main">
          <h1>Top 5 repo-visible engineers in the last 90 days</h1>
          <p className="lede">{model.methodology.definition}</p>
        </div>
      </section>
      {methodology()}
      <section className="board">{model.leaders.map(card)}</section>
      <section className="meta meta-end">
        <div>
          <span>Window</span>
          <strong>{model.timeframe.start} to {model.timeframe.end}</strong>
        </div>
        <div>
          <span>Model</span>
          <strong>{modelSummary()}</strong>
        </div>
      </section>
      <section className="foot">
        {model.methodology.limitations.map((item) => (
          <p key={item}>{item}</p>
        ))}
      </section>
    </main>
  );
}

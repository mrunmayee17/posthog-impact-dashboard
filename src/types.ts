export type Dimension = "delivery" | "leverage" | "quality" | "collaboration" | "scope";

export type ScorePart = {
  label: string;
  value: number;
  count: number;
};

export type ScoreInput = {
  raw: number;
  parts: ScorePart[];
};

export type Evidence = {
  kind: "pr" | "review";
  title: string;
  url: string;
  summary: string;
  agentNote?: string;
};

export type AgentRead = {
  agentSummary: string;
  agentStrengths: string[];
  agentRisks: string[];
  agentImpactType: string;
  agentWhyTopFive: string;
  agentRankReason: string;
  agentDimensionRead: Record<Dimension, string>;
  agentDimensionReason: Record<Dimension, string>;
  agentEvidence: Array<{
    url: string;
    note: string;
  }>;
};

export type Leader = {
  login: string;
  rank: number;
  impactScore: number;
  archetype: string;
  scoreBreakdown: Record<Dimension, number>;
  scoreInputs: Record<Dimension, ScoreInput>;
  whyTheyRanked: string[];
  evidence: Evidence[];
} & Partial<AgentRead>;

export type ImpactData = {
  generatedAt: string;
  timeframe: {
    start: string;
    end: string;
    days: number;
  };
  methodology: {
    definition: string;
    weights: Record<Dimension, number>;
    limitations: string[];
  };
  leaders: Leader[];
};

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AgentRead, Dimension, ImpactData, Leader } from "../src/types.ts";

const key = process.env.NVIDIA_API_KEY ?? "";
const cacheRoot = ".cache/agent";
const url = "https://integrate.api.nvidia.com/v1/chat/completions";
const version = "v6-dimension-calls";
const dims: Dimension[] = ["delivery", "leverage", "quality", "collaboration", "scope"];
const labels: Record<Dimension, string> = {
  delivery: "Delivery",
  leverage: "Leverage",
  quality: "Quality",
  collaboration: "Coordination",
  scope: "Scope"
};

async function main() {
  if (!key) throw new Error("Missing NVIDIA_API_KEY");
  const data = await readJson<ImpactData>("src/data/impact.json");
  const reads = await Promise.all(data.leaders.map((leader) => evaluateLeader(data, leader)));
  data.leaders = data.leaders.map((leader) => ({ ...leader, ...reads.find((item) => item.login === leader.login)! }));
  await writeFile("src/data/impact.json", JSON.stringify(data, null, 2));
}

async function evaluateLeader(data: ImpactData, leader: Leader) {
  const overall = await readMaybe<{ fingerprint?: string } & Partial<AgentRead>>(`${cacheRoot}/${leader.login}.json`);
  const dimReads = await Promise.all(dims.map((dim) => evaluateDimension(data, leader, dim)));
  const agentDimensionRead = Object.fromEntries(dimReads.map((item) => [item.dim, item.read])) as Record<Dimension, string>;
  const agentDimensionReason = Object.fromEntries(dimReads.map((item) => [item.dim, explainDimension(leader, item.dim, item.read)])) as Record<Dimension, string>;
  const notes = new Map((overall?.agentEvidence ?? []).map((item) => [item.url, item.note]));
  return {
    login: leader.login,
    agentSummary: overall?.agentSummary ?? summary(leader),
    agentStrengths: overall?.agentStrengths ?? strengths(leader),
    agentRisks: overall?.agentRisks ?? [risk(leader)],
    agentImpactType: overall?.agentImpactType ?? leader.archetype,
    agentWhyTopFive: overall?.agentWhyTopFive ?? whyTopFive(leader),
    agentRankReason: overall?.agentRankReason ?? rankReason(leader),
    agentDimensionRead,
    agentDimensionReason,
    agentEvidence: overall?.agentEvidence ?? leader.evidence.map((item) => ({ url: item.url, note: item.summary })),
    evidence: leader.evidence.map((item) => ({ ...item, agentNote: notes.get(item.url) ?? item.agentNote ?? item.summary }))
  };
}

async function evaluateDimension(data: ImpactData, leader: Leader, dim: Dimension) {
  const payload = {
    version,
    timeframe: data.timeframe,
    leader: {
      login: leader.login,
      rank: leader.rank,
      archetype: leader.archetype
    },
    dimension: {
      key: dim,
      label: labels[dim],
      score: leader.scoreBreakdown[dim],
      raw: leader.scoreInputs[dim].raw,
      parts: leader.scoreInputs[dim].parts
    },
    peers: data.leaders.map((item) => ({
      login: item.login,
      score: item.scoreBreakdown[dim]
    }))
  };
  const fingerprint = hash(payload);
  const file = `${cacheRoot}/${leader.login}-${dim}.json`;
  const cached = await readMaybe<{ fingerprint: string; read: string }>(file);
  if (cached?.fingerprint === fingerprint) return { dim, read: cached.read };
  const response = await callDimensionModel(payload);
  await writeJson(file, { fingerprint, ...response });
  return { dim, ...response };
}

async function callDimensionModel(payload: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: "nvidia/nemotron-3-super-120b-a12b",
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 500,
      reasoning_budget: 1500,
      chat_template_kwargs: { enable_thinking: true },
      messages: [
        {
          role: "system",
          content: "You evaluate one engineering-impact dimension at a time. Return strict JSON only with key read. read must be exactly one of: Primary driver, Strong, Supporting, Limited. Use the engineer's score, the dimension max weight, and the peer scores to decide the label."
        },
        {
          role: "user",
          content: JSON.stringify(payload)
        }
      ]
    })
  });
  if (!res.ok) throw new Error(`NVIDIA ${res.status}`);
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("Missing dimension content");
  return parseDimension(text);
}

function parseDimension(text: string) {
  const clean = extractJson(text);
  try {
    const parsed = JSON.parse(clean) as { read?: string };
    if (parsed.read) return { read: parsed.read };
  } catch {}
  const match = text.match(/\b(Primary driver|Strong|Supporting|Limited)\b/i);
  if (match) return { read: normalizeRead(match[1]) };
  throw new Error("Invalid dimension output");
}

function summary(leader: Leader) {
  const top = topDims(leader);
  return `${leader.login} ranked #${leader.rank} through visible ${labels[top[0]].toLowerCase()} work, with added strength in ${labels[top[1]].toLowerCase()}.`;
}

function strengths(leader: Leader) {
  return topDims(leader).slice(0, 2).map((dim) => strengthText(dim));
}

function whyTopFive(leader: Leader) {
  const top = topDims(leader);
  return `Top five because ${labels[top[0]].toLowerCase()} and ${labels[top[1]].toLowerCase()} evidence stayed strong relative to peers.`;
}

function rankReason(leader: Leader) {
  const top = topDims(leader);
  return `${leader.login} ranked #${leader.rank} because ${labels[top[0]].toLowerCase()} and ${labels[top[1]].toLowerCase()} carried the strongest visible case.`;
}

function risk(leader: Leader) {
  const low = [...dims].sort((a, b) => leader.scoreBreakdown[a] - leader.scoreBreakdown[b])[0];
  return `${labels[low]} was the weakest visible area in the repo evidence.`;
}

function topDims(leader: Leader) {
  return [...dims].sort((a, b) => leader.scoreBreakdown[b] - leader.scoreBreakdown[a]);
}

function explainDimension(leader: Leader, dim: Dimension, read: string) {
  const score = leader.scoreBreakdown[dim];
  const raw = leader.scoreInputs[dim].raw;
  const parts = leader.scoreInputs[dim].parts.map((part) => `${part.value} from ${part.count} ${part.label}${part.count === 1 ? "" : "s"}`).join(" + ");
  return `${labels[dim]} is ${read.toLowerCase()} at ${score}/${max(dim)}, built from ${raw} raw via ${parts}.`;
}

function max(dim: Dimension) {
  if (dim === "delivery") return 30;
  if (dim === "leverage") return 25;
  if (dim === "quality") return 20;
  if (dim === "collaboration") return 15;
  return 10;
}

function extractJson(text: string) {
  const fenced = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start >= 0 && end > start) return fenced.slice(start, end + 1);
  return fenced;
}

function normalizeRead(value: string) {
  const lower = value.toLowerCase();
  if (lower === "primary driver") return "Primary driver";
  if (lower === "strong") return "Strong";
  if (lower === "supporting") return "Supporting";
  return "Limited";
}

function strengthText(dim: Dimension) {
  if (dim === "delivery") return "Visible feature and rollout ownership.";
  if (dim === "leverage") return "Shared-system and platform impact.";
  if (dim === "quality") return "Fixes and risk reduction.";
  if (dim === "collaboration") return "Coordination around important changes.";
  return "Breadth across related initiatives.";
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readJson<T>(file: string) {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function readMaybe<T>(file: string) {
  try {
    return await readJson<T>(file);
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { invokeAi } from "./invoke";

// =============================================================================
// In-App Copilot (roadmap Tier 3 / feature 11) — client side.
//
// Asks the ai-copilot function a question about CRM history; it looks up the
// leads the caller can see and answers from them. Advisory and read-only.
// =============================================================================

export type CopilotSource = {
  jobId: string;
  customerName: string;
  serviceType: string;
  status: string;
};

export type CopilotAnswer = {
  answer: string;
  confidence: "low" | "medium" | "high";
  usedCount: number;
  sources: CopilotSource[];
};

const ALLOWED_ROLES = new Set(["admin", "cs_admin", "customer_service", "processor"]);

export function canUseCopilot(role: string | null | undefined): boolean {
  return !!role && ALLOWED_ROLES.has(role);
}

export async function askCopilot(question: string): Promise<CopilotAnswer> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error("Ask a question.");

  const res = await invokeAi<{
    answer?: unknown;
    confidence?: unknown;
    used_count?: unknown;
    sources?: unknown;
  }>("ai-copilot", { question: trimmed }, 30_000);
  if (!res.ok) throw new Error(res.message);

  const d = res.data ?? {};
  const confidence =
    d.confidence === "high" || d.confidence === "medium" ? d.confidence : "low";
  const rawSources = Array.isArray(d.sources) ? d.sources : [];
  const sources: CopilotSource[] = rawSources.map((entry) => {
    const s = (entry ?? {}) as Record<string, unknown>;
    return {
      jobId: typeof s.job_id === "string" ? s.job_id : "",
      customerName: typeof s.customer_name === "string" ? s.customer_name : "",
      serviceType: typeof s.service_type === "string" ? s.service_type : "",
      status: typeof s.status === "string" ? s.status : "",
    };
  });

  return {
    answer: typeof d.answer === "string" ? d.answer : "",
    confidence,
    usedCount: typeof d.used_count === "number" ? d.used_count : 0,
    sources,
  };
}

import { NextResponse, type NextRequest } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  coerceWorkflowOutcome,
  getWorkflowHistory,
  recordWorkflowOutcome,
  workflowMemorySize,
} from "@omniroute/open-sse/services/harness/workflowMemory.ts";

/**
 * GET/POST /api/v1/router/outcomes — B16.1, the Hermes integration guide
 * §17/§22.4 "structured outcome callback" (§15's memory interface over
 * HTTP). Hermes Bots run in the CLIENT runtime — their executions never
 * pass through the fork's closed loop — so they report workflow outcomes
 * here and read history back:
 *
 *   POST {workflow, model?, tools?, sources_found?, sources_verified?,
 *         quality_score?, latency_ms?, success?}
 *   GET ?workflow=web_research   → per-(workflow, model, tools) evidence
 *
 * Workflow outcomes are WORKFLOW memory (§14), never model benchmarks —
 * they surface on /v1/router/execution's agents and workflow_memory.
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request: NextRequest) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_request", details: ["Invalid JSON body"] }, { status: 400 });
  }
  const outcome = coerceWorkflowOutcome(raw);
  if ("error" in outcome) {
    return NextResponse.json({ ok: false, error: "invalid_request", details: [outcome.error] }, { status: 400 });
  }
  recordWorkflowOutcome(outcome);
  return NextResponse.json(
    {
      ok: true,
      recorded: true,
      workflow: outcome.workflow,
      memory_size: workflowMemorySize(),
      note: "workflow evidence — surfaced on /v1/router/execution; never a model benchmark",
    },
    { status: 202 }
  );
}

export async function GET(request: NextRequest) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  const workflow = new URL(request.url).searchParams.get("workflow");
  if (!workflow || !workflow.trim()) {
    return NextResponse.json({ ok: false, error: "invalid_request", details: ["?workflow= is required"] }, { status: 400 });
  }
  return NextResponse.json({ ok: true, workflow: workflow.trim(), history: getWorkflowHistory(workflow) }, { status: 200 });
}

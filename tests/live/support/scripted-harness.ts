import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AgentExecutionError,
  type AgentControl,
  type AgentEventSink,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentHarness,
} from "@thor/agent";
import { reviewerKindSchema, type HarnessKind } from "@thor/domain";
import { z } from "zod";

export type ScriptedLiveScenario =
  | "happy_path"
  | "repair_and_deferral"
  | "restart_recovery"
  | "cancel_during_implementation"
  | "resume_after_block";

export type ScriptedLiveHarnessOptions = {
  scenario?: ScriptedLiveScenario;
  repairFile?: string;
};

export class ScriptedLiveHarness implements AgentHarness {
  private implementationAttempts = 0;

  public constructor(
    public readonly kind: HarnessKind,
    private readonly runId: string,
    private readonly deliveryFile: string,
    private readonly options: ScriptedLiveHarnessOptions = {},
  ) {}

  public async execute(
    request: AgentExecutionRequest,
    events: AgentEventSink,
    controls: AsyncIterable<AgentControl>,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    void controls;
    if (signal.aborted) throw signal.reason;
    await events.publish({
      kind: "session_started",
      providerSessionId: `${this.kind}-${request.package.executionId}`,
    });
    await events.publish({ kind: "turn_started", turn: 1 });
    const purpose = request.package.purpose;
    let structuredOutput: unknown;
    switch (purpose.kind) {
      case "blueprint":
        structuredOutput = {
          objective: `Deliver the live fixture ${this.runId}`,
          constraints: ["Keep the fixture change isolated to one run-specific file."],
          architecture: "A run-specific marker committed through Thor's real Git workspace.",
          proposedDesign: `Create ${this.deliveryFile} with the live run identifier.`,
          affectedAreas: [this.deliveryFile],
          implementationPlan: [`Create ${this.deliveryFile}.`],
          testingPlan: ["Verify the marker content after merge."],
          rolloutPlan: [],
          risks: [],
          unresolvedBlockingQuestions: [],
          acceptanceCriteria: [`${this.deliveryFile} contains ${this.runId}.`],
        };
        break;
      case "implementation": {
        this.implementationAttempts += 1;
        const target = path.join(request.workspace, this.deliveryFile);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `${this.runId}\n`, "utf8");
        if (
          this.options.scenario === "cancel_during_implementation" ||
          (this.options.scenario === "resume_after_block" && this.implementationAttempts === 1)
        ) {
          await waitForCancellation(signal);
        }
        structuredOutput = {
          testsPassed: true,
          riskFlags: [],
          summary: `Created ${this.deliveryFile}`,
          verification: [`Wrote the marker for ${this.runId}.`],
        };
        break;
      }
      case "review": {
        const input = reviewInputSchema.parse(phaseInput(request));
        if (
          this.options.scenario === "repair_and_deferral" &&
          input.reviewRunId.endsWith("pass-01") &&
          input.reviewer === "correctness"
        ) {
          structuredOutput = {
            findings: [
              {
                severity: "medium",
                category: "correctness",
                summary: "The live marker needs a verified repair artifact",
                evidence: [`${this.deliveryFile} was created without the repair marker.`],
                affectedFiles: [this.deliveryFile],
                recommendedFix: "Add the run-specific repair marker and re-review the change.",
                blocking: true,
                deferrable: false,
                confidence: 1,
              },
            ],
            passed: false,
          };
        } else if (
          this.options.scenario === "repair_and_deferral" &&
          input.reviewRunId.endsWith("pass-02") &&
          input.reviewer === "testing"
        ) {
          structuredOutput = {
            findings: [
              {
                severity: "medium",
                category: "testing",
                summary: "Add a longer-lived regression check for the live marker",
                evidence: ["The delivery is verified live but has no permanent repository test."],
                affectedFiles: [this.deliveryFile],
                recommendedFix: "Add a durable regression test in a follow-up ticket.",
                blocking: false,
                deferrable: true,
                confidence: 0.95,
              },
            ],
            passed: true,
          };
        } else {
          structuredOutput = { findings: [], passed: true };
        }
        break;
      }
      case "synthesis": {
        const input = synthesisInputSchema.parse(phaseInput(request));
        const source = input.reviewerResults.flatMap((result) => result.findings).at(0);
        structuredOutput = {
          findings:
            source === undefined
              ? []
              : [
                  {
                    sourceFindingIds: [source.findingId],
                    reviewers: [source.reviewer],
                    severity: source.severity,
                    category: source.category,
                    summary: source.summary,
                    evidence: source.evidence,
                    affectedFiles: source.affectedFiles,
                    recommendedFix: source.recommendedFix,
                    disposition: source.blocking ? "blocking" : "defer_candidate",
                    confidence: source.confidence,
                  },
                ],
          failureScope: "repair",
          fullReReview: false,
        };
        break;
      }
      case "repair": {
        if (
          this.options.scenario !== "repair_and_deferral" &&
          this.options.scenario !== "restart_recovery"
        ) {
          throw new Error("repair is not expected in this live scenario");
        }
        const input = repairInputSchema.parse(phaseInput(request));
        const repairFile = this.options.repairFile;
        if (repairFile === undefined) throw new Error("live repair scenario omitted repairFile");
        const target = path.join(request.workspace, repairFile);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `${this.runId}\n`, "utf8");
        structuredOutput = {
          repairedFindings: input.requiredFindingIds,
          testsPassed: true,
          summary: `Created ${repairFile}`,
          verification: [`Wrote the repair marker for ${this.runId}.`],
        };
        break;
      }
    }
    await events.publish({ kind: "turn_completed", turn: 1 });
    return {
      executionId: request.package.executionId,
      harness: this.kind,
      finalResponse: JSON.stringify(structuredOutput),
      structuredOutput,
      sessionId: `scripted-${this.kind}-${request.package.executionId}`,
      packageDigest: request.package.digest,
      usage: {},
    };
  }
}

const reviewInputSchema = z.object({
  reviewRunId: z.string().min(1),
  reviewer: reviewerKindSchema,
});

const sourceFindingSchema = z.object({
  findingId: z.string().min(1),
  reviewer: reviewerKindSchema,
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  category: z.string().min(1),
  summary: z.string().min(1),
  evidence: z.array(z.string()).min(1),
  affectedFiles: z.array(z.string()),
  recommendedFix: z.string().min(1),
  blocking: z.boolean(),
  confidence: z.number().min(0).max(1),
});

const synthesisInputSchema = z.object({
  reviewerResults: z.array(z.object({ findings: z.array(sourceFindingSchema) })),
});

const repairInputSchema = z.object({
  requiredFindingIds: z.array(z.string().min(1)),
});

function phaseInput(request: AgentExecutionRequest): unknown {
  const marker = "## Phase input\n\n```json\n";
  const start = request.package.prompt.indexOf(marker);
  if (start < 0) throw new Error("execution package omitted the phase input marker");
  const jsonStart = start + marker.length;
  const end = request.package.prompt.indexOf("\n```", jsonStart);
  if (end < 0) throw new Error("execution package omitted the phase input terminator");
  return JSON.parse(request.package.prompt.slice(jsonStart, end)) as unknown;
}

async function waitForCancellation(signal: AbortSignal): Promise<never> {
  if (!signal.aborted) {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
  throw new AgentExecutionError("scripted live execution was cancelled", false, "cancelled");
}

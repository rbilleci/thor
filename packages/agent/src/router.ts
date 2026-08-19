import type { HarnessKind } from "@thor/domain";

import { AgentExecutionError } from "./types.js";
import {
  agentExecutionRequestSchema,
  agentExecutionResultSchema,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentControl,
  type AgentEventSink,
  type AgentHarness,
} from "./types.js";

export class HarnessRouter {
  private readonly harnesses = new Map<HarnessKind, AgentHarness>();

  public register(harness: AgentHarness): void {
    this.harnesses.set(harness.kind, harness);
  }

  public async execute(
    request: AgentExecutionRequest,
    events: AgentEventSink,
    controls: AsyncIterable<AgentControl>,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const parsedRequest = agentExecutionRequestSchema.parse(request);
    const harness = this.harnesses.get(parsedRequest.package.harness);
    if (harness === undefined) {
      throw new AgentExecutionError(
        `${parsedRequest.package.harness} harness is not configured`,
        false,
        "invalid_request",
      );
    }
    const result = agentExecutionResultSchema.parse(
      await harness.execute(parsedRequest, events, controls, signal),
    );
    if (
      result.executionId !== parsedRequest.package.executionId ||
      result.harness !== parsedRequest.package.harness ||
      result.packageDigest !== parsedRequest.package.digest
    ) {
      throw new AgentExecutionError(
        "agent provider returned mismatched execution correlation",
        false,
        "invalid_response",
      );
    }
    return result;
  }
}

export class FakeHarness implements AgentHarness {
  public readonly calls: AgentExecutionRequest[] = [];

  public constructor(
    public readonly kind: HarnessKind,
    private readonly response: Omit<
      AgentExecutionResult,
      "executionId" | "harness" | "packageDigest"
    >,
  ) {}

  public async execute(
    request: AgentExecutionRequest,
    events: AgentEventSink,
    controls: AsyncIterable<AgentControl>,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    if (signal.aborted) {
      throw new AgentExecutionError("agent execution cancelled", false, "cancelled");
    }
    this.calls.push(request);
    await events.publish({
      kind: "session_started",
      providerSessionId: `${this.kind}-${request.package.executionId}`,
    });
    await events.publish({ kind: "turn_started", turn: 1 });
    await events.publish({ kind: "turn_completed", turn: 1 });
    void controls;
    return Promise.resolve({
      executionId: request.package.executionId,
      harness: this.kind,
      packageDigest: request.package.digest,
      ...this.response,
    });
  }
}

import { AgentExecutionError } from "./types.js";

export function normalizeProviderError(
  error: unknown,
  signal: AbortSignal,
  context: { resumingSession?: boolean } = {},
): AgentExecutionError {
  if (signal.aborted || isAbortError(error)) {
    return new AgentExecutionError("agent execution cancelled", false, "cancelled", {
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (context.resumingSession === true && isUnavailableSessionMessage(message)) {
    return new AgentExecutionError(message, true, "session_unavailable", { cause: error });
  }
  if (/unauthorized|forbidden|authentication|api key|401|403/i.test(message)) {
    return new AgentExecutionError(message, false, "authentication", { cause: error });
  }
  if (/invalid|schema|working directory|git repository|permission denied/i.test(message)) {
    return new AgentExecutionError(message, false, "invalid_request", { cause: error });
  }
  if (/timeout|timed out|rate limit|429|502|503|connection|temporar/i.test(message)) {
    return new AgentExecutionError(message, true, "provider_unavailable", { cause: error });
  }
  return new AgentExecutionError(message, true, "provider_failed", { cause: error });
}

function isUnavailableSessionMessage(message: string): boolean {
  return (
    /(?:session|thread|rollout).{0,100}(?:not found|does not exist|unknown|unavailable|missing|invalid|cannot (?:be )?resume|failed to (?:load|resume))/i.test(
      message,
    ) || /no (?:saved )?(?:session|thread|rollout).{0,100}found/i.test(message)
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "CancelledError");
}

export function parseStructuredResponse(
  direct: unknown,
  finalResponse: string,
  expectsStructuredOutput: boolean,
): unknown {
  if (!expectsStructuredOutput) return undefined;
  if (direct !== undefined) return direct;
  try {
    return JSON.parse(finalResponse) as unknown;
  } catch (error) {
    throw new AgentExecutionError(
      "provider returned invalid JSON for a structured execution",
      false,
      "provider_failed",
      { cause: error },
    );
  }
}

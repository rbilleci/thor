import { GitHubError } from "@thor/github";
import pRetry, { type RetryContext } from "p-retry";

export const INFRASTRUCTURE_RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;

export type InfrastructureRetryOptions = {
  retries?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  randomize?: boolean;
  maxRetryTimeMs?: number;
  signal?: AbortSignal;
  shouldRetry: (error: Error) => boolean | Promise<boolean>;
  onFailedAttempt?: (context: RetryContext) => void | Promise<void>;
};

/**
 * Applies the maintained p-retry scheduler at process boundaries that Temporal does not own.
 * Temporal Activities must use Temporal Retry Policies instead so their waits remain durable.
 */
export function retryInfrastructureOperation<Value>(
  operation: (attemptNumber: number) => PromiseLike<Value> | Value,
  options: InfrastructureRetryOptions,
): Promise<Value> {
  return pRetry(operation, {
    retries: options.retries ?? Number.POSITIVE_INFINITY,
    factor: 2,
    minTimeout: options.minDelayMs ?? 1_000,
    maxTimeout: options.maxDelayMs ?? INFRASTRUCTURE_RETRY_MAX_DELAY_MS,
    randomize: options.randomize ?? true,
    shouldRetry: ({ error }) => options.shouldRetry(error),
    ...(options.maxRetryTimeMs === undefined ? {} : { maxRetryTime: options.maxRetryTimeMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onFailedAttempt === undefined ? {} : { onFailedAttempt: options.onFailedAttempt }),
  });
}

export function isRetryableGitHubFailure(error: Error): boolean {
  if (error instanceof GitHubError) return error.retryable;
  return /(?:HTTP\s+)?(?:429|5\d\d)|rate[ -]?limit|timed?\s*out|connection|network|temporar|server is currently available/i.test(
    error.message,
  );
}

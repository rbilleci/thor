import { z } from "zod";

export declare const brand: unique symbol;
export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type ProjectItemId = Brand<string, "ProjectItemId">;
export type IssueId = Brand<string, "IssueId">;
export type WorkflowId = Brand<string, "WorkflowId">;
export type ReviewRunId = Brand<string, "ReviewRunId">;
export type FindingId = Brand<string, "FindingId">;
export type DeferredIssueId = Brand<string, "DeferredIssueId">;
export type ExecutionId = Brand<string, "ExecutionId">;

const identifier = <Name extends string>(name: Name) =>
  z
    .string()
    .trim()
    .min(1, `${name} must not be empty`)
    .transform((value) => value as Brand<string, Name>);

export const projectItemIdSchema = identifier("ProjectItemId");
export const issueIdSchema = identifier("IssueId");
export const workflowIdSchema = identifier("WorkflowId");
export const reviewRunIdSchema = identifier("ReviewRunId");
export const findingIdSchema = identifier("FindingId");
export const deferredIssueIdSchema = identifier("DeferredIssueId");
export const executionIdSchema = identifier("ExecutionId");

export function workflowIdFor(projectItemId: ProjectItemId): WorkflowId {
  return workflowIdSchema.parse(`github-project-item:${projectItemId}`);
}

export function reviewRunIdFor(projectItemId: ProjectItemId, pass: number): ReviewRunId {
  if (!Number.isSafeInteger(pass) || pass < 1) {
    throw new RangeError("review pass must be a positive integer");
  }
  return reviewRunIdSchema.parse(
    `review-run:${projectItemId}:pass-${pass.toString().padStart(2, "0")}`,
  );
}

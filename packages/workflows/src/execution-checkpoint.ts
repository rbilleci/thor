import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { agentControlSourceReferenceSchema } from "@thor/agent";
import { z } from "zod";

const executionCheckpointSchema = z.strictObject({
  version: z.literal(1),
  executionId: z.string().min(1),
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  providerSessionId: z.string().min(1).optional(),
  providerTurn: z.number().int().nonnegative().optional(),
  slackMessageTs: z
    .string()
    .regex(/^\d{10,}\.\d{6}$/)
    .optional(),
  lastItemId: z.string().min(1).optional(),
  appliedCommandIds: z.array(z.string().min(1)).max(100),
  pendingControlReferences: z.array(agentControlSourceReferenceSchema).max(100).default([]),
  updatedAt: z.iso.datetime(),
});
export type AgentExecutionCheckpoint = z.infer<typeof executionCheckpointSchema>;

export type ExecutionCheckpointStore = {
  load(executionId: string): Promise<AgentExecutionCheckpoint | undefined>;
  save(checkpoint: AgentExecutionCheckpoint): Promise<void>;
};

export class FileExecutionCheckpointStore implements ExecutionCheckpointStore {
  private readonly root: string;

  public constructor(root: string) {
    this.root = path.resolve(root);
  }

  public async load(executionId: string): Promise<AgentExecutionCheckpoint | undefined> {
    try {
      return executionCheckpointSchema.parse(
        JSON.parse(await readFile(this.file(executionId), "utf8")),
      );
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError || error instanceof z.ZodError) {
        return undefined;
      }
      throw error;
    }
  }

  public async save(checkpoint: AgentExecutionCheckpoint): Promise<void> {
    const parsed = executionCheckpointSchema.parse(checkpoint);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.file(parsed.executionId);
    const temporary = `${target}.${process.pid.toString()}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  private file(executionId: string): string {
    const key = createHash("sha256").update(executionId).digest("hex");
    return path.join(this.root, `${key}.json`);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  );
}

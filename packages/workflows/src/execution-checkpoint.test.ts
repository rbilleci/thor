import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileExecutionCheckpointStore } from "./execution-checkpoint.js";

describe("FileExecutionCheckpointStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("atomically persists bounded provider and steering recovery state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "thor-checkpoint-"));
    roots.push(root);
    const store = new FileExecutionCheckpointStore(root);
    const checkpoint = {
      version: 1 as const,
      executionId: "execution-1",
      packageDigest: "a".repeat(64),
      providerSessionId: "session-1",
      providerTurn: 2,
      slackMessageTs: "1700000000.000001",
      lastItemId: "item-2",
      appliedCommandIds: ["command-1"],
      pendingControlReferences: [
        {
          commandId: "command-1",
          eventId: "Ev001",
          workspaceId: "TWORKSPACE",
          channelId: "CPROJECT",
          threadTs: "1700000000.000001",
          messageTs: "1700000000.100001",
          actorId: "UACTOR",
          mode: "queue" as const,
          contentDigest: "b".repeat(64),
        },
      ],
      updatedAt: "2026-08-17T20:00:00.000Z",
    };

    await store.save(checkpoint);

    expect(await store.load(checkpoint.executionId)).toEqual(checkpoint);
    expect(await readdir(root)).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.json$/)]);
  });

  it("treats a corrupt checkpoint as unavailable so recovery can start a new session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "thor-checkpoint-"));
    roots.push(root);
    const store = new FileExecutionCheckpointStore(root);
    await store.save({
      version: 1,
      executionId: "execution-corrupt",
      packageDigest: "b".repeat(64),
      appliedCommandIds: [],
      pendingControlReferences: [],
      updatedAt: "2026-08-17T20:00:00.000Z",
    });
    const [file] = await readdir(root);
    if (file === undefined) throw new Error("checkpoint file was not created");
    await writeFile(path.join(root, file), "not-json", "utf8");

    expect(await store.load("execution-corrupt")).toBeUndefined();
  });
});

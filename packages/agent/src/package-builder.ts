import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  executionPackageSchema,
  type ExecutionId,
  type ExecutionPackage,
  type ExecutionPurpose,
  type HarnessKind,
  type SkillRef,
  type TicketContext,
  redactKnownSecrets,
} from "@thor/domain";
import { z } from "zod";

export type PackageBuildRequest = {
  executionId: ExecutionId;
  harness: HarnessKind;
  purpose: ExecutionPurpose;
  ticket: TicketContext;
  payload: unknown;
  configuration?: Readonly<Record<string, string>>;
};

export class PackageBuildError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "missing_resource"
      | "empty_resource"
      | "duplicate_skill"
      | "secret_configuration"
      | "invalid_configuration",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PackageBuildError";
  }
}

export class ExecutionPackageBuilder {
  public constructor(private readonly resourceRoot: string) {}

  public async build(request: PackageBuildRequest): Promise<ExecutionPackage> {
    validateConfiguration(request.configuration ?? {});
    const harnessRoot = path.join(this.resourceRoot, "harnesses", request.harness);
    const [basePrompt, agentsMd, defaultConfiguration] = await Promise.all([
      readRequired(path.join(harnessRoot, "base-prompt.md")),
      readRequired(path.join(harnessRoot, "AGENTS.md")),
      readConfiguration(path.join(harnessRoot, "config.json")),
    ]);
    const configuration = {
      ...defaultConfiguration,
      ...(request.configuration ?? {}),
    };
    validateConfiguration(configuration);

    const selected = [
      {
        path: path.join(harnessRoot, "skills", purposeSkill(request.purpose), "SKILL.md"),
        reason: `built-in ${request.harness} skill for ${request.purpose.kind}`,
      },
      ...selectCustomSkills(this.resourceRoot, request.ticket, request.payload),
    ];
    const skills = await Promise.all(
      selected.map(async ({ path: skillPath, reason }) => {
        const content = redactKnownSecrets(await readRequired(skillPath));
        const name = path.basename(path.dirname(skillPath));
        const digest = sha256(content);
        return {
          name,
          version: `sha256:${digest.slice(0, 12)}`,
          path: path.relative(this.resourceRoot, skillPath),
          digest,
          content,
          selectionReason: reason,
        } satisfies SkillRef;
      }),
    );
    const names = new Set<string>();
    for (const skill of skills) {
      if (names.has(skill.name)) {
        throw new PackageBuildError(`duplicate selected skill ${skill.name}`, "duplicate_skill");
      }
      names.add(skill.name);
    }

    const prompt = redactKnownSecrets(
      `${basePrompt}\n\n## Ticket context\n\n\`\`\`json\n${JSON.stringify(request.ticket, null, 2)}\n\`\`\`\n\n## Phase input\n\n\`\`\`json\n${JSON.stringify(request.payload, null, 2)}\n\`\`\`\n`,
    );
    const redactedAgentsMd = redactKnownSecrets(agentsMd);
    const promptDigest = sha256(prompt);
    const agentsMdDigest = sha256(redactedAgentsMd);
    const configurationDigest = sha256(stableConfiguration(configuration));
    const digest = executionPackageDigest({
      harness: request.harness,
      purpose: request.purpose,
      prompt,
      promptDigest,
      agentsMd: redactedAgentsMd,
      agentsMdDigest,
      skills,
      configuration,
      configurationDigest,
    });
    return executionPackageSchema.parse({
      executionId: request.executionId,
      harness: request.harness,
      purpose: request.purpose,
      prompt,
      promptDigest,
      agentsMd: redactedAgentsMd,
      agentsMdDigest,
      skills,
      configuration,
      configurationDigest,
      digest,
    });
  }
}

function purposeSkill(purpose: ExecutionPurpose): string {
  switch (purpose.kind) {
    case "blueprint":
    case "implementation":
    case "review":
    case "synthesis":
    case "repair":
      return purpose.kind;
  }
}

function selectCustomSkills(
  root: string,
  ticket: TicketContext,
  payload: unknown,
): { path: string; reason: string }[] {
  const searchable =
    `${ticket.title} ${ticket.body} ${ticket.component ?? ""} ${JSON.stringify(payload)}`.toLowerCase();
  const custom = path.join(root, "skills", "custom");
  const selected: { path: string; reason: string }[] = [];
  if (containsAny(searchable, ["auth", "secure", "security", "secret", "permission"])) {
    selected.push({
      path: path.join(custom, "security", "SKILL.md"),
      reason: "ticket or phase context indicates security-sensitive work",
    });
  }
  if (containsAny(searchable, ["database", "schema", "migration", "data"])) {
    selected.push({
      path: path.join(custom, "data-migration", "SKILL.md"),
      reason: "ticket or phase context indicates data or migration work",
    });
  }
  if (containsAny(searchable, ["api", "compatibility", "endpoint", "protocol"])) {
    selected.push({
      path: path.join(custom, "api-compatibility", "SKILL.md"),
      reason: "ticket or phase context indicates API or compatibility work",
    });
  }
  if (ticket.workType === "bug" || containsAny(searchable, ["test", "regression", "flaky"])) {
    selected.push({
      path: path.join(custom, "regression-testing", "SKILL.md"),
      reason: "ticket or phase context requires regression-focused verification",
    });
  }
  return selected;
}

function containsAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

const configurationSchema = z.record(
  z.string().trim().min(1),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);

async function readConfiguration(filePath: string): Promise<Record<string, string>> {
  const text = await readRequired(filePath);
  const parsed = configurationSchema.safeParse(JSON.parse(text) as unknown);
  if (!parsed.success) {
    throw new PackageBuildError(
      `invalid harness configuration ${filePath}: ${z.prettifyError(parsed.error)}`,
      "invalid_configuration",
    );
  }
  return Object.fromEntries(
    Object.entries(parsed.data).map(([key, value]) => [
      key,
      Array.isArray(value) ? JSON.stringify(value) : String(value),
    ]),
  );
}

async function readRequired(filePath: string): Promise<string> {
  let value: string;
  try {
    value = await readFile(filePath, "utf8");
  } catch (error) {
    throw new PackageBuildError(`cannot read execution resource ${filePath}`, "missing_resource", {
      cause: error,
    });
  }
  if (value.trim().length === 0) {
    throw new PackageBuildError(`execution resource ${filePath} is empty`, "empty_resource");
  }
  return value;
}

function validateConfiguration(configuration: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(configuration)) {
    if (/(secret|token|password|api[_-]?key)/i.test(key)) {
      throw new PackageBuildError(
        `configuration key ${key} may contain a secret and cannot enter Workflow history`,
        "secret_configuration",
      );
    }
  }
}

export { redactKnownSecrets };

function executionPackageDigest(input: Omit<ExecutionPackage, "executionId" | "digest">): string {
  return sha256(
    JSON.stringify({
      harness: input.harness,
      purpose: input.purpose,
      prompt: input.prompt,
      agentsMd: input.agentsMd,
      skills: input.skills.map(({ name, version, digest, content }) => ({
        name,
        version,
        digest,
        content,
      })),
      configuration: stableConfiguration(input.configuration),
    }),
  );
}

function stableConfiguration(configuration: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(configuration).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

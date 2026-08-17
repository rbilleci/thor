import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentProfileSnapshot, SkillSelector } from "@thor/config/schema";
import {
  executionPackageSchema,
  type ExecutionId,
  type ExecutionPackage,
  type ExecutionPurpose,
  type SkillRef,
  type TicketContext,
  redactKnownSecrets,
} from "@thor/domain";
import { z } from "zod";

export type PackageBuildRequest = {
  executionId: ExecutionId;
  agent: AgentProfileSnapshot;
  purpose: ExecutionPurpose;
  ticket: TicketContext;
  payload: unknown;
  skillSelectors: readonly SkillSelector[];
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
    validateConfiguration(request.agent.configuration);
    const harnessRoot = agentResourceRoot(this.resourceRoot, request.agent);
    const [basePrompt, agentsMd, defaultConfiguration] = await Promise.all([
      readRequired(path.join(harnessRoot, "base-prompt.md")),
      readRequired(path.join(harnessRoot, "AGENTS.md")),
      readConfiguration(path.join(harnessRoot, "config.json")),
    ]);
    const configuration = {
      ...defaultConfiguration,
      ...request.agent.configuration,
    };
    validateConfiguration(configuration);

    const selected = [
      {
        path: path.join(harnessRoot, "skills", purposeSkill(request.purpose), "SKILL.md"),
        reason: `built-in ${request.agent.harness} skill for ${request.purpose.kind}`,
      },
      ...selectCustomSkills(
        this.resourceRoot,
        request.ticket,
        request.payload,
        request.purpose,
        request.skillSelectors,
      ),
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
      agentProfile: request.agent.id,
      agentProfileDigest: request.agent.digest,
      harness: request.agent.harness,
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
      agentProfile: request.agent.id,
      agentProfileDigest: request.agent.digest,
      harness: request.agent.harness,
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
  purpose: ExecutionPurpose,
  selectors: readonly SkillSelector[],
): { path: string; reason: string }[] {
  const custom = path.join(root, "skills", "custom");
  return selectors
    .filter((selector) => selectorMatches(selector, ticket, payload, purpose))
    .map((selector) => ({
      path: path.join(custom, selector.skill, "SKILL.md"),
      reason: selector.reason,
    }));
}

function containsAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function selectorMatches(
  selector: SkillSelector,
  ticket: TicketContext,
  payload: unknown,
  purpose: ExecutionPurpose,
): boolean {
  const { match } = selector;
  if (match.purposes !== undefined && !match.purposes.includes(purpose.kind)) return false;
  if (
    match.reviewers !== undefined &&
    (purpose.kind !== "review" || !match.reviewers.includes(purpose.reviewer))
  ) {
    return false;
  }
  const searchable =
    `${ticket.title} ${ticket.body} ${ticket.component ?? ""} ${JSON.stringify(payload)}`.toLowerCase();
  const signals: boolean[] = [];
  if (match.workTypes !== undefined) signals.push(match.workTypes.includes(ticket.workType));
  if (match.components !== undefined) {
    const component = ticket.component?.toLowerCase();
    signals.push(
      component !== undefined &&
        match.components.some((candidate) => candidate.toLowerCase() === component),
    );
  }
  if (match.riskFlags !== undefined) {
    signals.push(match.riskFlags.some((risk) => searchable.includes(risk)));
  }
  if (match.keywords !== undefined) {
    signals.push(
      containsAny(
        searchable,
        match.keywords.map((keyword) => keyword.toLowerCase()),
      ),
    );
  }
  return signals.length === 0 || signals.some(Boolean);
}

function agentResourceRoot(root: string, agent: AgentProfileSnapshot): string {
  const harnessRoot = path.join(root, "harnesses", agent.harness);
  return agent.resourceProfile === "default"
    ? harnessRoot
    : path.join(harnessRoot, "profiles", agent.resourceProfile);
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
      agentProfile: input.agentProfile,
      agentProfileDigest: input.agentProfileDigest,
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

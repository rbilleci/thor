import type { ExecutionPackage } from "@thor/domain";

export function assembledUserPrompt(executionPackage: ExecutionPackage): string {
  const skills = executionPackage.skills
    .map(
      (skill) =>
        `## Injected skill: ${skill.name}\n\nSelection: ${skill.selectionReason}\n\n${skill.content}`,
    )
    .join("\n\n---\n\n");
  return `# Harness instructions\n\n${executionPackage.agentsMd}\n\n${executionPackage.prompt}\n\n# Active skills\n\n${skills}`;
}

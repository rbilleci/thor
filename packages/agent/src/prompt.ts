import type { ExecutionPackage } from "@thor/domain";

import type { AgentControl } from "./types.js";

export function assembledUserPrompt(
  executionPackage: ExecutionPackage,
  recoveryControls: AgentControl[] = [],
): string {
  const skills = executionPackage.skills
    .map(
      (skill) =>
        `## Injected skill: ${skill.name}\n\nSelection: ${skill.selectionReason}\n\n${skill.content}`,
    )
    .join("\n\n---\n\n");
  const recovery = recoveryControls
    .map((control) => {
      const text = control.kind === "cancel" ? (control.reason ?? "cancel") : control.text;
      return `${control.kind} command ${control.commandId}: ${text}`;
    })
    .join("\n\n");
  return [
    `# Harness instructions\n\n${executionPackage.agentsMd}`,
    executionPackage.prompt,
    `# Active skills\n\n${skills}`,
    ...(recovery.length === 0
      ? []
      : [
          `# Recovery guidance\n\nThe following previously accepted human commands may not have completed before worker recovery. Apply them now and preserve the required structured output schema.\n\n${recovery}`,
        ]),
  ].join("\n\n");
}

import { readFile } from "node:fs/promises";
import path from "node:path";

import { Connection } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import type { CompiledProjectBinding, DeliveryProjectDeclaration } from "@thor/config";
import { loadDeliveryProjectDeclaration } from "@thor/config/node";
import { type NormalizedFinding, type RepositoryRef, type TicketContext } from "@thor/domain";
import {
  OctokitGitHubGateway,
  OctokitProjectAdministrationGateway,
  ProjectConfigurationManager,
  type DeferredProjectField,
  type GitHubAuth,
  type GitHubProjectConfiguration,
} from "@thor/github";
import { z } from "zod";

const emptyToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalPositiveInteger = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().positive().optional(),
);
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());

const environmentSchema = z.object({
  TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  TEMPORAL_TASK_QUEUE: z.string().min(1).default("thor-delivery"),
  TEMPORAL_API_KEY: optionalString,
  TEMPORAL_TLS: z.enum(["true", "false"]).default("false"),
  GITHUB_TOKEN: optionalString,
  GITHUB_APP_ID: optionalPositiveInteger,
  GITHUB_APP_PRIVATE_KEY_PATH: optionalString,
  GITHUB_APP_INSTALLATION_ID: optionalPositiveInteger,
  GITHUB_API_URL: optionalUrl,
  GITHUB_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default("2026-03-10"),
  THOR_PROJECT_DECLARATION: z.string().min(1).default("./config/delivery-project.json"),
  THOR_SOURCE_ROOT: z.string().min(1).default("./repositories"),
  THOR_WORKTREE_ROOT: z.string().min(1).default("./.thor-worktrees"),
  THOR_RESOURCE_ROOT: z.string().min(1).default("./resources"),
});

const temporalEnvironmentSchema = environmentSchema.pick({
  TEMPORAL_ADDRESS: true,
  TEMPORAL_NAMESPACE: true,
  TEMPORAL_TASK_QUEUE: true,
  TEMPORAL_API_KEY: true,
  TEMPORAL_TLS: true,
});

export type ProjectControlConfiguration = {
  auth: GitHubAuth;
  apiUrl?: string;
  apiVersion: string;
  declarationPath: string;
  declaration: DeliveryProjectDeclaration;
};

export type RuntimeConfiguration = {
  temporal: {
    address: string;
    namespace: string;
    taskQueue: string;
    tls: boolean;
    apiKey?: string;
  };
  github: {
    auth: GitHubAuth;
    project: GitHubProjectConfiguration;
    apiUrl?: string;
    apiVersion: string;
  };
  binding: CompiledProjectBinding;
  paths: {
    sourceRoot: string;
    worktreeRoot: string;
    resourceRoot: string;
  };
};

export async function loadRuntimeConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<RuntimeConfiguration> {
  const parsed = environmentSchema.parse(environment);
  const control = await loadProjectControlConfiguration(environment, cwd);
  const manager = createProjectConfigurationManager(control);
  const binding = await manager.validate(control.declaration);
  return {
    temporal: {
      address: parsed.TEMPORAL_ADDRESS,
      namespace: parsed.TEMPORAL_NAMESPACE,
      taskQueue: parsed.TEMPORAL_TASK_QUEUE,
      tls: parsed.TEMPORAL_TLS === "true",
      ...(parsed.TEMPORAL_API_KEY === undefined ? {} : { apiKey: parsed.TEMPORAL_API_KEY }),
    },
    github: {
      auth: control.auth,
      project: {
        projectId: binding.project.id,
        fields: binding.fields,
        ticketDefaults: binding.ticketDefaults,
        dependencyCompletion: binding.delivery.workflow.dependencies.completion,
        doneOptionId:
          binding.fields.lifecycle.options[binding.delivery.workflow.board.states.done] ?? "",
      },
      apiVersion: control.apiVersion,
      ...(control.apiUrl === undefined ? {} : { apiUrl: control.apiUrl }),
    },
    binding,
    paths: {
      sourceRoot: path.resolve(cwd, parsed.THOR_SOURCE_ROOT),
      worktreeRoot: path.resolve(cwd, parsed.THOR_WORKTREE_ROOT),
      resourceRoot: path.resolve(cwd, parsed.THOR_RESOURCE_ROOT),
    },
  };
}

export async function loadProjectControlConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<ProjectControlConfiguration> {
  const parsed = environmentSchema.parse(environment);
  const declarationPath = path.resolve(cwd, parsed.THOR_PROJECT_DECLARATION);
  return {
    auth: await githubAuth(parsed, cwd),
    apiVersion: parsed.GITHUB_API_VERSION,
    ...(parsed.GITHUB_API_URL === undefined ? {} : { apiUrl: parsed.GITHUB_API_URL }),
    declarationPath,
    declaration: await loadDeliveryProjectDeclaration(declarationPath),
  };
}

export function createProjectConfigurationManager(
  configuration: ProjectControlConfiguration,
): ProjectConfigurationManager {
  return new ProjectConfigurationManager(
    new OctokitProjectAdministrationGateway({
      auth: configuration.auth,
      apiVersion: configuration.apiVersion,
      ...(configuration.apiUrl === undefined ? {} : { apiUrl: configuration.apiUrl }),
    }),
  );
}

export function loadTemporalConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfiguration["temporal"] {
  const parsed = temporalEnvironmentSchema.parse(environment);
  return {
    address: parsed.TEMPORAL_ADDRESS,
    namespace: parsed.TEMPORAL_NAMESPACE,
    taskQueue: parsed.TEMPORAL_TASK_QUEUE,
    tls: parsed.TEMPORAL_TLS === "true",
    ...(parsed.TEMPORAL_API_KEY === undefined ? {} : { apiKey: parsed.TEMPORAL_API_KEY }),
  };
}

export function createGitHubGateway(configuration: RuntimeConfiguration): OctokitGitHubGateway {
  return new OctokitGitHubGateway(configuration.github);
}

export async function createClientConnection(
  configuration: Pick<RuntimeConfiguration, "temporal">,
): Promise<Connection> {
  return Connection.connect({
    address: configuration.temporal.address,
    tls: configuration.temporal.tls,
    ...(configuration.temporal.apiKey === undefined
      ? {}
      : { apiKey: configuration.temporal.apiKey }),
  });
}

export async function createWorkerConnection(
  configuration: Pick<RuntimeConfiguration, "temporal">,
): Promise<NativeConnection> {
  return NativeConnection.connect({
    address: configuration.temporal.address,
    tls: configuration.temporal.tls,
    ...(configuration.temporal.apiKey === undefined
      ? {}
      : { apiKey: configuration.temporal.apiKey }),
  });
}

async function githubAuth(
  environment: z.infer<typeof environmentSchema>,
  cwd: string,
): Promise<GitHubAuth> {
  if (environment.GITHUB_TOKEN !== undefined) {
    return { kind: "token", token: environment.GITHUB_TOKEN };
  }
  if (
    environment.GITHUB_APP_ID === undefined ||
    environment.GITHUB_APP_PRIVATE_KEY_PATH === undefined ||
    environment.GITHUB_APP_INSTALLATION_ID === undefined
  ) {
    throw new Error(
      "configure GITHUB_TOKEN or all of GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, and GITHUB_APP_INSTALLATION_ID",
    );
  }
  const privateKey = await readFile(
    path.resolve(cwd, environment.GITHUB_APP_PRIVATE_KEY_PATH),
    "utf8",
  );
  return {
    kind: "app",
    appId: environment.GITHUB_APP_ID,
    privateKey,
    installationId: environment.GITHUB_APP_INSTALLATION_ID,
  };
}

export function mapDeferredProjectFields(
  binding: Pick<CompiledProjectBinding, "fields">,
  finding: NormalizedFinding,
  ticket: TicketContext,
): DeferredProjectField[] {
  const fields: DeferredProjectField[] = [];
  addSelect(fields, binding.fields.workType, ticket.workType);
  addSelect(fields, binding.fields.priority, ticket.priority);
  if (binding.fields.component !== undefined && ticket.component !== undefined) {
    fields.push({
      fieldId: binding.fields.component.fieldId,
      kind: "text",
      text: ticket.component,
    });
  }
  addSelect(fields, binding.fields.agentPolicy, ticket.policy.agentPolicy);
  addSelect(fields, binding.fields.planningDepth, ticket.policy.planningDepth);
  addSelect(fields, binding.fields.severity, finding.severity);
  return fields;
}

function addSelect(
  fields: DeferredProjectField[],
  route: { fieldId: string; options: Partial<Record<string, string>> } | undefined,
  value: string,
): void {
  const optionId = route?.options[value];
  if (route !== undefined && optionId !== undefined) {
    fields.push({ fieldId: route.fieldId, kind: "single_select", optionId });
  }
}

export function baseBranchFor(binding: CompiledProjectBinding, repository: RepositoryRef): string {
  const configured = binding.repositories.find(
    (candidate) =>
      candidate.owner.toLowerCase() === repository.owner.toLowerCase() &&
      candidate.name.toLowerCase() === repository.name.toLowerCase(),
  );
  if (configured === undefined) {
    throw new Error(
      `repository ${repository.owner}/${repository.name} is not declared by ${binding.delivery.declarationName}`,
    );
  }
  return configured.baseBranch;
}

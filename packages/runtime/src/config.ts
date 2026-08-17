import { readFile } from "node:fs/promises";
import path from "node:path";

import { Connection } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import {
  agentPolicySchema,
  planningDepthSchema,
  prioritySchema,
  severitySchema,
  ticketStatusSchema,
  workTypeSchema,
  type NormalizedFinding,
  type TicketContext,
  type TicketStatus,
} from "@thor/domain";
import {
  OctokitGitHubGateway,
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
  GITHUB_PROJECT_ID: z.string().min(1),
  GITHUB_STATUS_FIELD_ID: z.string().min(1),
  GITHUB_STATUS_OPTIONS_JSON: z.string().min(2),
  GITHUB_DEFERRED_FIELDS_JSON: z.string().min(2).default("{}"),
  THOR_SOURCE_ROOT: z.string().min(1).default("./repositories"),
  THOR_WORKTREE_ROOT: z.string().min(1).default("./.thor-worktrees"),
  THOR_RESOURCE_ROOT: z.string().min(1).default("./resources"),
  THOR_BASE_BRANCH: z.string().min(1).default("main"),
});

const temporalEnvironmentSchema = environmentSchema.pick({
  TEMPORAL_ADDRESS: true,
  TEMPORAL_NAMESPACE: true,
  TEMPORAL_TASK_QUEUE: true,
  TEMPORAL_API_KEY: true,
  TEMPORAL_TLS: true,
});

const fieldIdSchema = z.string().trim().min(1);
const selectFieldSchema = <Key extends z.ZodEnum>(keySchema: Key) =>
  z.object({
    fieldId: fieldIdSchema,
    options: z.partialRecord(keySchema, fieldIdSchema),
  });
const deferredFieldRoutingSchema = z.object({
  type: selectFieldSchema(workTypeSchema).optional(),
  priority: selectFieldSchema(prioritySchema).optional(),
  component: z.object({ fieldId: fieldIdSchema }).optional(),
  agentPolicy: selectFieldSchema(agentPolicySchema).optional(),
  planningDepth: selectFieldSchema(planningDepthSchema).optional(),
  severity: selectFieldSchema(severitySchema).optional(),
});
export type DeferredFieldRouting = z.infer<typeof deferredFieldRoutingSchema>;

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
    deferredFields: DeferredFieldRouting;
    apiUrl?: string;
  };
  paths: {
    sourceRoot: string;
    worktreeRoot: string;
    resourceRoot: string;
  };
  baseBranch: string;
};

export async function loadRuntimeConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<RuntimeConfiguration> {
  const parsed = environmentSchema.parse(environment);
  const auth = await githubAuth(parsed, cwd);
  const statusOptions = parseStatusOptions(parsed.GITHUB_STATUS_OPTIONS_JSON);
  const deferredFields = parseDeferredFields(parsed.GITHUB_DEFERRED_FIELDS_JSON);
  return {
    temporal: {
      address: parsed.TEMPORAL_ADDRESS,
      namespace: parsed.TEMPORAL_NAMESPACE,
      taskQueue: parsed.TEMPORAL_TASK_QUEUE,
      tls: parsed.TEMPORAL_TLS === "true",
      ...(parsed.TEMPORAL_API_KEY === undefined ? {} : { apiKey: parsed.TEMPORAL_API_KEY }),
    },
    github: {
      auth,
      project: {
        projectId: parsed.GITHUB_PROJECT_ID,
        statusFieldId: parsed.GITHUB_STATUS_FIELD_ID,
        statusOptions,
      },
      deferredFields,
      ...(parsed.GITHUB_API_URL === undefined ? {} : { apiUrl: parsed.GITHUB_API_URL }),
    },
    paths: {
      sourceRoot: path.resolve(cwd, parsed.THOR_SOURCE_ROOT),
      worktreeRoot: path.resolve(cwd, parsed.THOR_WORKTREE_ROOT),
      resourceRoot: path.resolve(cwd, parsed.THOR_RESOURCE_ROOT),
    },
    baseBranch: parsed.THOR_BASE_BRANCH,
  };
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

function parseStatusOptions(value: string): Record<TicketStatus, string> {
  const raw: unknown = JSON.parse(value);
  return z.record(ticketStatusSchema, z.string().min(1)).parse(raw);
}

function parseDeferredFields(value: string): DeferredFieldRouting {
  const raw: unknown = JSON.parse(value);
  return deferredFieldRoutingSchema.parse(raw);
}

export function mapDeferredProjectFields(
  routing: DeferredFieldRouting,
  finding: NormalizedFinding,
  ticket: TicketContext,
): DeferredProjectField[] {
  const fields: DeferredProjectField[] = [];
  addSelect(fields, routing.type, ticket.workType);
  addSelect(fields, routing.priority, ticket.priority);
  if (routing.component !== undefined && ticket.component !== undefined) {
    fields.push({ fieldId: routing.component.fieldId, kind: "text", text: ticket.component });
  }
  addSelect(fields, routing.agentPolicy, ticket.policy.agentPolicy);
  addSelect(fields, routing.planningDepth, ticket.policy.planningDepth);
  addSelect(fields, routing.severity, finding.severity);
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

import {
  agentPolicySchema,
  approvalPolicySchema,
  executionModeSchema,
  harnessKindSchema,
  planningDepthSchema,
  prioritySchema,
  projectableTicketStatusSchema,
  repositoryRefSchema,
  reviewerKindSchema,
  riskFlagSchema,
  severitySchema,
  workTypeSchema,
} from "@thor/domain";
import { z } from "zod";

export const configurationKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:[._/-][A-Za-z0-9]+)*$/, "invalid configuration key");
export type ConfigurationKey = z.infer<typeof configurationKeySchema>;

export const boardStateKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/, "invalid board state key");
export type BoardStateKey = z.infer<typeof boardStateKeySchema>;

export const profileIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/, "invalid profile identifier");
export type ProfileId = z.infer<typeof profileIdSchema>;

export const workflowImplementationSchema = z.enum(["ticket-delivery/v1"]);
export type WorkflowImplementation = z.infer<typeof workflowImplementationSchema>;

export const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const projectFieldColorSchema = z.enum([
  "GRAY",
  "BLUE",
  "GREEN",
  "YELLOW",
  "ORANGE",
  "RED",
  "PINK",
  "PURPLE",
]);
export type ProjectFieldColor = z.infer<typeof projectFieldColorSchema>;

export const projectOptionDeclarationSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  color: projectFieldColorSchema.default("GRAY"),
});
export type ProjectOptionDeclaration = z.infer<typeof projectOptionDeclarationSchema>;

const requiredOnItemsSchema = z.boolean().default(true);

const lifecycleFieldDeclarationSchema = z.strictObject({
  type: z.literal("single_select"),
  name: z.string().trim().min(1),
  requiredOnItems: z.literal(true).default(true),
  options: z
    .record(boardStateKeySchema, projectOptionDeclarationSchema)
    .refine((options) => Object.keys(options).length > 0, "lifecycle requires at least one option"),
});

const selectFieldDeclarationSchema = <Key extends z.ZodEnum>(keySchema: Key) =>
  z.strictObject({
    type: z.literal("single_select"),
    name: z.string().trim().min(1),
    requiredOnItems: requiredOnItemsSchema,
    options: z.partialRecord(keySchema, projectOptionDeclarationSchema),
  });

const textFieldDeclarationSchema = z.strictObject({
  type: z.literal("text"),
  name: z.string().trim().min(1),
  requiredOnItems: z.boolean().default(false),
});

export const projectFieldsDeclarationSchema = z.strictObject({
  lifecycle: lifecycleFieldDeclarationSchema,
  workType: selectFieldDeclarationSchema(workTypeSchema).optional(),
  priority: selectFieldDeclarationSchema(prioritySchema).optional(),
  component: textFieldDeclarationSchema.optional(),
  executionMode: selectFieldDeclarationSchema(executionModeSchema).optional(),
  planningDepth: selectFieldDeclarationSchema(planningDepthSchema).optional(),
  approvalPolicy: selectFieldDeclarationSchema(approvalPolicySchema).optional(),
  agentPolicy: selectFieldDeclarationSchema(agentPolicySchema).optional(),
  severity: selectFieldDeclarationSchema(severitySchema).optional(),
});
export type ProjectFieldsDeclaration = z.infer<typeof projectFieldsDeclarationSchema>;

export const projectFieldKeySchema = z.enum([
  "lifecycle",
  "workType",
  "priority",
  "component",
  "executionMode",
  "planningDepth",
  "approvalPolicy",
  "agentPolicy",
  "severity",
]);
export type ProjectFieldKey = z.infer<typeof projectFieldKeySchema>;

export const projectViewLayoutSchema = z.enum(["BOARD_LAYOUT", "TABLE_LAYOUT", "ROADMAP_LAYOUT"]);
export type ProjectViewLayout = z.infer<typeof projectViewLayoutSchema>;

export const projectViewDeclarationSchema = z.strictObject({
  name: z.string().trim().min(1),
  layout: projectViewLayoutSchema,
  filter: z.string().trim().optional(),
  visibleFields: z.array(projectFieldKeySchema),
});
export type ProjectViewDeclaration = z.infer<typeof projectViewDeclarationSchema>;

export const ticketDefaultsSchema = z.strictObject({
  workType: workTypeSchema,
  priority: prioritySchema,
  executionMode: executionModeSchema,
  planningDepth: planningDepthSchema,
  approvalPolicy: approvalPolicySchema,
  agentPolicy: agentPolicySchema,
  autonomousRepairBudget: z.number().int().min(0).max(20).default(3),
});
export type TicketDefaults = z.infer<typeof ticketDefaultsSchema>;

export const agentProfileDeclarationSchema = z.strictObject({
  harness: harnessKindSchema,
  resourceProfile: profileIdSchema.default("default"),
  configuration: z.record(configurationKeySchema, z.string()).default({}),
});
export type AgentProfileDeclaration = z.infer<typeof agentProfileDeclarationSchema>;

export const agentProfileSnapshotSchema = agentProfileDeclarationSchema.extend({
  id: profileIdSchema,
  digest: sha256DigestSchema,
});
export type AgentProfileSnapshot = z.infer<typeof agentProfileSnapshotSchema>;

export const executionPurposeKindSchema = z.enum([
  "blueprint",
  "implementation",
  "review",
  "synthesis",
  "repair",
]);
export type ExecutionPurposeKind = z.infer<typeof executionPurposeKindSchema>;

export const skillSelectorSchema = z
  .strictObject({
    skill: profileIdSchema,
    reason: z.string().trim().min(1),
    match: z.strictObject({
      purposes: z.array(executionPurposeKindSchema).min(1).optional(),
      reviewers: z.array(reviewerKindSchema).min(1).optional(),
      workTypes: z.array(workTypeSchema).min(1).optional(),
      components: z.array(z.string().trim().min(1)).min(1).optional(),
      riskFlags: z.array(riskFlagSchema).min(1).optional(),
      keywords: z.array(z.string().trim().min(2)).min(1).optional(),
    }),
  })
  .refine(
    (selector) => Object.values(selector.match).some((value) => value !== undefined),
    "skill selector requires at least one match condition",
  );
export type SkillSelector = z.infer<typeof skillSelectorSchema>;

export const workflowAgentRolesSchema = z.strictObject({
  blueprint: profileIdSchema,
  implementation: profileIdSchema,
  review: profileIdSchema,
  synthesis: profileIdSchema,
  repair: profileIdSchema,
});
export type WorkflowAgentRoles = z.infer<typeof workflowAgentRolesSchema>;

export const boardProjectionSchema = z.strictObject({
  states: z.record(projectableTicketStatusSchema, boardStateKeySchema),
  entrypoints: z.strictObject({
    blueprint: z.array(boardStateKeySchema).min(1),
    implementation: z.array(boardStateKeySchema).min(1),
  }),
  controls: z.strictObject({
    blocked: boardStateKeySchema,
    cancelled: boardStateKeySchema,
  }),
  approvals: z.strictObject({
    blueprint: z.strictObject({
      approved: boardStateKeySchema,
      changesRequested: boardStateKeySchema,
    }),
    merge: z.strictObject({
      approved: boardStateKeySchema,
      changesRequested: boardStateKeySchema,
    }),
  }),
});
export type BoardProjection = z.infer<typeof boardProjectionSchema>;

export const interventionPolicySchema = z.strictObject({
  ticketChanges: z.enum(["replan", "cancel"]).default("replan"),
  dependencyChanges: z.enum(["replan", "resume", "cancel"]).default("replan"),
  unexpectedStatuses: z.enum(["block", "cancel"]).default("block"),
  unreadableItems: z
    .strictObject({
      action: z.enum(["block", "cancel"]).default("block"),
      afterConsecutivePolls: z.number().int().min(1).max(100).default(3),
    })
    .default({ action: "block", afterConsecutivePolls: 3 }),
  removedItems: z.enum(["orphan", "cancel"]).default("orphan"),
});
export type InterventionPolicy = z.infer<typeof interventionPolicySchema>;

export const dependencyPolicySchema = z.strictObject({
  completion: z
    .enum(["issue_closed", "issue_closed_or_project_done", "issue_closed_and_project_done"])
    .default("issue_closed_and_project_done"),
  closeIssueAfterMerge: z.boolean().default(true),
});
export type DependencyPolicy = z.infer<typeof dependencyPolicySchema>;

export const workflowProfileSchema = z.strictObject({
  id: profileIdSchema,
  implementation: workflowImplementationSchema,
  version: z.string().trim().min(1),
  board: boardProjectionSchema,
  reviewers: z.array(reviewerKindSchema).min(1),
  agents: workflowAgentRolesSchema,
  interventions: interventionPolicySchema.default({
    ticketChanges: "replan",
    dependencyChanges: "replan",
    unexpectedStatuses: "block",
    unreadableItems: { action: "block", afterConsecutivePolls: 3 },
    removedItems: "orphan",
  }),
  dependencies: dependencyPolicySchema.default({
    completion: "issue_closed_and_project_done",
    closeIssueAfterMerge: true,
  }),
});
export type WorkflowProfile = z.infer<typeof workflowProfileSchema>;

export const projectRepositorySchema = repositoryRefSchema.extend({
  baseBranch: z.string().trim().min(1).default("main"),
});
export type ProjectRepository = z.infer<typeof projectRepositorySchema>;

export const deliveryProjectDeclarationSchema = z.strictObject({
  apiVersion: z.literal("thor.dev/v1alpha1"),
  kind: z.literal("DeliveryProject"),
  metadata: z.strictObject({
    name: profileIdSchema,
    version: z.string().trim().min(1),
  }),
  github: z.strictObject({
    owner: z.string().trim().min(1),
    ownerType: z.enum(["organization", "user"]).default("organization"),
    projectNumber: z.number().int().positive().optional(),
    title: z.string().trim().min(1),
    shortDescription: z.string().trim().min(1).optional(),
    visibility: z.enum(["private", "public"]).default("private"),
    repositories: z.array(projectRepositorySchema).min(1),
    fields: projectFieldsDeclarationSchema,
    views: z.record(profileIdSchema, projectViewDeclarationSchema).default({}),
  }),
  ticketDefaults: ticketDefaultsSchema,
  workflow: workflowProfileSchema,
  agents: z.record(profileIdSchema, agentProfileDeclarationSchema),
  skillSelectors: z.array(skillSelectorSchema).default([]),
});
export type DeliveryProjectDeclaration = z.infer<typeof deliveryProjectDeclarationSchema>;

export const discoveredProjectOptionSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  color: projectFieldColorSchema,
});
export type DiscoveredProjectOption = z.infer<typeof discoveredProjectOptionSchema>;

export const discoveredProjectFieldSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.literal("single_select"),
    options: z.array(discoveredProjectOptionSchema),
  }),
  z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.literal("text"),
  }),
]);
export type DiscoveredProjectField = z.infer<typeof discoveredProjectFieldSchema>;

export const discoveredProjectSchema = z.strictObject({
  id: z.string().min(1),
  owner: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  shortDescription: z.string().nullable().optional(),
  readme: z.string().nullable().optional(),
  public: z.boolean(),
  url: z.url(),
  repositories: z.array(
    z.strictObject({
      id: z.string().min(1),
      owner: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
  fields: z.array(discoveredProjectFieldSchema),
  views: z.array(
    z.strictObject({
      id: z.string().min(1),
      number: z.number().int().positive(),
      name: z.string().min(1),
      layout: projectViewLayoutSchema,
      filter: z.string().nullable().optional(),
      visibleFieldIds: z.array(z.string().min(1)),
    }),
  ),
});
export type DiscoveredProject = z.infer<typeof discoveredProjectSchema>;

const resolvedSelectFieldSchema = z.strictObject({
  type: z.literal("single_select"),
  fieldId: z.string().min(1),
  requiredOnItems: z.boolean(),
  options: z.record(z.string().min(1), z.string().min(1)),
});

const resolvedTextFieldSchema = z.strictObject({
  type: z.literal("text"),
  fieldId: z.string().min(1),
  requiredOnItems: z.boolean(),
});

export const resolvedProjectFieldsSchema = z.strictObject({
  lifecycle: resolvedSelectFieldSchema,
  workType: resolvedSelectFieldSchema.optional(),
  priority: resolvedSelectFieldSchema.optional(),
  component: resolvedTextFieldSchema.optional(),
  executionMode: resolvedSelectFieldSchema.optional(),
  planningDepth: resolvedSelectFieldSchema.optional(),
  approvalPolicy: resolvedSelectFieldSchema.optional(),
  agentPolicy: resolvedSelectFieldSchema.optional(),
  severity: resolvedSelectFieldSchema.optional(),
});
export type ResolvedProjectFields = z.infer<typeof resolvedProjectFieldsSchema>;

export const runtimeDeliveryProfileSchema = z.strictObject({
  declarationName: profileIdSchema,
  declarationVersion: z.string().min(1),
  declarationDigest: sha256DigestSchema,
  workflow: workflowProfileSchema,
  agents: z.record(profileIdSchema, agentProfileSnapshotSchema),
  skillSelectors: z.array(skillSelectorSchema),
});
export type RuntimeDeliveryProfile = z.infer<typeof runtimeDeliveryProfileSchema>;

export const compiledProjectBindingSchema = z.strictObject({
  apiVersion: z.literal("thor.dev/binding-v1alpha1"),
  digest: sha256DigestSchema,
  project: z.strictObject({
    id: z.string().min(1),
    owner: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
    url: z.url(),
  }),
  repositories: z.array(projectRepositorySchema).min(1),
  fields: resolvedProjectFieldsSchema,
  ticketDefaults: ticketDefaultsSchema,
  delivery: runtimeDeliveryProfileSchema,
});
export type CompiledProjectBinding = z.infer<typeof compiledProjectBindingSchema>;

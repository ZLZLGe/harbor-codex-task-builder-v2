import { z } from "zod";
import { canonicalTaskName } from "./utils.js";

type JsonSchemaNode = {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: readonly string[];
  items?: JsonSchemaNode | JsonSchemaNode[];
  anyOf?: readonly JsonSchemaNode[];
  oneOf?: readonly JsonSchemaNode[];
  allOf?: readonly JsonSchemaNode[];
};

function assertStructuredOutputCompatible(schema: JsonSchemaNode, label: string, trail = label): void {
  if (schema.type === "object" && schema.properties) {
    const propertyKeys = Object.keys(schema.properties);
    const requiredKeys = schema.required ?? [];
    if (requiredKeys.length !== propertyKeys.length || propertyKeys.some((key) => !requiredKeys.includes(key))) {
      throw new Error(`${trail} 的 required 必须覆盖 properties 中的全部字段: ${propertyKeys.join(", ")}`);
    }

    for (const [key, value] of Object.entries(schema.properties)) {
      assertStructuredOutputCompatible(value, label, `${trail}.properties.${key}`);
    }
  }

  if (schema.items) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    for (const [index, item] of items.entries()) {
      assertStructuredOutputCompatible(item, label, `${trail}.items[${index}]`);
    }
  }

  for (const [keyword, variants] of [
    ["anyOf", schema.anyOf],
    ["oneOf", schema.oneOf],
    ["allOf", schema.allOf],
  ] as const) {
    for (const [index, variant] of (variants ?? []).entries()) {
      assertStructuredOutputCompatible(variant, label, `${trail}.${keyword}[${index}]`);
    }
  }
}

export const taskRoleSchema = z.enum(["similar", "transfer"]);
export const skillModeSchema = z.enum(["all", "per-skill"]);

export const plannedTaskSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  primaryOutputFile: z.string().min(1),
  difficulty: z.string().min(1),
  category: z.string().min(1),
  skillBenefitRationale: z.string().min(1),
});

export const familyPlanSchema = z.object({
  templateId: z.string().min(1),
  skillMode: skillModeSchema,
  targetSkillDirName: z.string(),
  targetSkillName: z.string(),
  familyTheme: z.string().min(1),
  similarTasks: z.array(plannedTaskSchema),
  transferTasks: z.array(plannedTaskSchema),
});

export const derivedTaskPlanSchema = z.object({
  derivedTaskId: z.string().min(1),
  taskRole: taskRoleSchema,
  roleOrdinal: z.number().int().positive(),
  title: z.string().min(1),
  goal: z.string().min(1),
  primaryOutputFile: z.string().min(1),
  difficulty: z.string().min(1),
  category: z.string().min(1),
  skillBenefitRationale: z.string().min(1),
  templateId: z.string().min(1),
  skillMode: skillModeSchema,
  targetSkillDirName: z.string(),
  targetSkillName: z.string(),
});

export const writerSummarySchema = z.object({
  derivedTaskId: z.string().min(1),
  draftRelativePath: z.string().min(1),
  primaryOutputFile: z.string().min(1),
  filesWritten: z.array(z.string().min(1)).min(1),
  summary: z.string().min(1),
});

export const blockingReviewerTaskResultSchema = z.object({
  derivedTaskId: z.string().min(1),
  blockingPass: z.boolean(),
  blockingIssues: z.array(z.string()),
});

export const blockingReviewResultSchema = z.object({
  taskResults: z.array(blockingReviewerTaskResultSchema),
});

export const repairTurnResultSchema = z.object({
  summary: z.string().min(1),
  repairReason: z.string().min(1).optional(),
  changedFiles: z.array(z.string().min(1)),
});

export type PlannedTask = z.infer<typeof plannedTaskSchema>;
export type FamilyPlan = z.infer<typeof familyPlanSchema>;
export type DerivedTaskPlan = z.infer<typeof derivedTaskPlanSchema>;
export type WriterSummary = z.infer<typeof writerSummarySchema>;
export type BlockingReviewerTaskResult = z.infer<typeof blockingReviewerTaskResultSchema>;
export type BlockingReviewResult = z.infer<typeof blockingReviewResultSchema>;
export type RepairTurnResult = z.infer<typeof repairTurnResultSchema>;

function resolveOrdinals(count: number, ordinals: number[] | undefined, label: string): number[] {
  if (!ordinals) {
    return Array.from({ length: count }, (_, index) => index + 1);
  }
  if (ordinals.length !== count) {
    throw new Error(`${label} 数量与 familyPlan 不一致: ordinals=${ordinals.length}, tasks=${count}`);
  }
  return ordinals;
}

export function flattenFamilyPlan(
  familyPlan: FamilyPlan,
  options: {
    similarOrdinals?: number[];
    transferOrdinals?: number[];
  } = {},
): DerivedTaskPlan[] {
  const similarOrdinals = resolveOrdinals(familyPlan.similarTasks.length, options.similarOrdinals, "similarOrdinals");
  const transferOrdinals = resolveOrdinals(
    familyPlan.transferTasks.length,
    options.transferOrdinals,
    "transferOrdinals",
  );

  const similarTasks = familyPlan.similarTasks.map((task, index) => ({
    derivedTaskId: canonicalTaskName("similar", similarOrdinals[index]!),
    taskRole: "similar" as const,
    roleOrdinal: similarOrdinals[index]!,
    title: task.title,
    goal: task.goal,
    primaryOutputFile: task.primaryOutputFile,
    difficulty: task.difficulty,
    category: task.category,
    skillBenefitRationale: task.skillBenefitRationale,
    templateId: familyPlan.templateId,
    skillMode: familyPlan.skillMode,
    targetSkillDirName: familyPlan.targetSkillDirName,
    targetSkillName: familyPlan.targetSkillName,
  }));

  const transferTasks = familyPlan.transferTasks.map((task, index) => ({
    derivedTaskId: canonicalTaskName("transfer", transferOrdinals[index]!),
    taskRole: "transfer" as const,
    roleOrdinal: transferOrdinals[index]!,
    title: task.title,
    goal: task.goal,
    primaryOutputFile: task.primaryOutputFile,
    difficulty: task.difficulty,
    category: task.category,
    skillBenefitRationale: task.skillBenefitRationale,
    templateId: familyPlan.templateId,
    skillMode: familyPlan.skillMode,
    targetSkillDirName: familyPlan.targetSkillDirName,
    targetSkillName: familyPlan.targetSkillName,
  }));

  return [...similarTasks, ...transferTasks];
}

export function countFamilyTasks(familyPlan: FamilyPlan): number {
  return familyPlan.similarTasks.length + familyPlan.transferTasks.length;
}

const plannedTaskJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "goal", "primaryOutputFile", "difficulty", "category", "skillBenefitRationale"],
  properties: {
    title: { type: "string" },
    goal: { type: "string" },
    primaryOutputFile: { type: "string" },
    difficulty: { type: "string" },
    category: { type: "string" },
    skillBenefitRationale: { type: "string" },
  },
} as const;

export const familyPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "templateId",
    "skillMode",
    "targetSkillDirName",
    "targetSkillName",
    "familyTheme",
    "similarTasks",
    "transferTasks",
  ],
  properties: {
    templateId: { type: "string" },
    skillMode: { type: "string", enum: ["all", "per-skill"] },
    targetSkillDirName: { type: "string" },
    targetSkillName: { type: "string" },
    familyTheme: { type: "string" },
    similarTasks: {
      type: "array",
      items: plannedTaskJsonSchema,
    },
    transferTasks: {
      type: "array",
      items: plannedTaskJsonSchema,
    },
  },
} as const;

export const writerSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["derivedTaskId", "draftRelativePath", "primaryOutputFile", "filesWritten", "summary"],
  properties: {
    derivedTaskId: { type: "string" },
    draftRelativePath: { type: "string" },
    primaryOutputFile: { type: "string" },
    filesWritten: {
      type: "array",
      items: { type: "string" },
    },
    summary: { type: "string" },
  },
} as const;

export const blockingReviewResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["taskResults"],
  properties: {
    taskResults: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["derivedTaskId", "blockingPass", "blockingIssues"],
        properties: {
          derivedTaskId: { type: "string" },
          blockingPass: { type: "boolean" },
          blockingIssues: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
  },
} as const;

export const repairTurnResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "repairReason", "changedFiles"],
  properties: {
    summary: { type: "string" },
    repairReason: { type: "string" },
    changedFiles: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

assertStructuredOutputCompatible(familyPlanJsonSchema, "familyPlanJsonSchema");
assertStructuredOutputCompatible(writerSummaryJsonSchema, "writerSummaryJsonSchema");
assertStructuredOutputCompatible(blockingReviewResultJsonSchema, "blockingReviewResultJsonSchema");
assertStructuredOutputCompatible(repairTurnResultJsonSchema, "repairTurnResultJsonSchema");

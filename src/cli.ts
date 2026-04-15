import path from "node:path";
import { CodexTaskBuilderClient } from "./codex.js";
import {
  buildGenerationUnits,
  collectEnvironmentAssetPaths,
  discoverInputSkills,
  discoverTaskTemplate,
  discoverTaskTemplates,
  type PublishedTaskInfo,
  type GenerationUnit,
  type SkillMode,
} from "./discovery.js";
import { appendManifest, writeRunSummary, type ManifestEntry } from "./manifest.js";
import { buildMaterializedTaskDir, sanitizeAndCopyTask } from "./materialize.js";
import { applyPublishedFamilyState, inspectPublishedFamily, selectExecutableUnits } from "./published.js";
import type { DerivedTaskPlan, FamilyPlan, WriterSummary } from "./schema.js";
import { flattenFamilyPlan } from "./schema.js";
import {
  buildSkillEffectBucketRoot,
  buildSkillEffectIssues,
  runSkillEffectEvaluation,
  runSkillEffectPreflight,
  type SkillEffectBucket,
  type SkillEffectEvaluationResult,
} from "./skill_effect.js";
import {
  DEFAULT_OUTPUT_ROOT,
  TEMPLATE_ROOT,
  buildFinalRoot,
  buildQuarantineRoot,
  buildRawRoot,
  ensureDir,
  writeJson,
} from "./utils.js";
import { createFamilyWorkspace, prepareDraftSkeleton, type FamilyWorkspace } from "./workspace.js";
import {
  collectFamilyObservationIssues,
  resolveRuntimeEnvironment,
  runRuntimePreflight,
  runRuntimeValidation,
  validateBlockingReviewResult,
  validateDraftStatic,
  validateFamilyPlan,
  validateTaskPlans,
  type RuntimeEnvironment,
  type RuntimeEvidence,
  type ValidationIssue,
} from "./validate.js";

type OptionValue = string | string[] | boolean;
type Options = Record<string, OptionValue>;

type FamilyExecutionResult = {
  templateId: string;
  skillMode: SkillMode;
  scopeSlug: string;
  targetSkillDirName?: string;
  targetSkillName?: string;
  runtimeEnvironment?: RuntimeEnvironment;
  runId?: string;
  status: "completed" | "failed";
  issues: string[];
  publishedTaskIds: string[];
  quarantinedTaskIds: string[];
  skillEffectResults: Array<{
    derivedTaskId: string;
    bucket: SkillEffectBucket;
    repairRequired: boolean;
    withSkillPassed: boolean;
    withSkillReward: number | null;
    withSkillSummary: string;
    noSkillPassed: boolean;
    noSkillReward: number | null;
    noSkillSummary: string;
  }>;
  skillEffectBucketCounts: Partial<Record<SkillEffectBucket, number>>;
  workspace?: FamilyWorkspace;
};

type TaskCycleState = {
  plan: DerivedTaskPlan;
  draftDir: string;
  writerSummary: WriterSummary;
  repairThreadId: string | null;
  repairRoundsUsed: number;
  runtimeAttemptCount: number;
  skillEffectAttemptCount: number;
  lastMutatedCycle: number | null;
  runtimePassedCycle: number | null;
  skillEffectAcceptedCycle: number | null;
  blockingIssues: ValidationIssue[];
  staticIssues: ValidationIssue[];
  runtimeIssues: ValidationIssue[];
  skillEffectIssues: ValidationIssue[];
  runtimeEvidence?: RuntimeEvidence;
  skillEffectEvaluation?: SkillEffectEvaluationResult;
  skillEffectResultPath?: string;
  passed: boolean;
};

type ExecuteFamilyOptions = {
  outputRoot: string;
  rawRoot: string;
  finalRoot: string;
  quarantineRoot: string;
  runtimeEnvironment: RuntimeEnvironment;
  maxRepairRounds: number;
  skillEffectEnabled: boolean;
  skillEffectModel: string;
  skillEffectApiKey: string;
  skillEffectBaseUrl?: string;
};

function parseArgs(argv: string[]): { command: string | undefined; options: Options } {
  const [command, ...rest] = argv;
  const options: Options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    const existing = options[key];
    if (typeof existing === "string") {
      options[key] = [existing, next];
    } else if (Array.isArray(existing)) {
      existing.push(next);
    } else {
      options[key] = next;
    }
    index += 1;
  }

  return { command, options };
}

function getStringOption(options: Options, key: string, fallback?: string): string | undefined {
  const value = options[key];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[value.length - 1] ?? fallback;
  }
  return fallback;
}

function getStringArrayOption(options: Options, key: string): string[] {
  const value = options[key];
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function getNumberOption(options: Options, key: string, fallback: number): number {
  const value = getStringOption(options, key);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getFlagOption(options: Options, key: string): boolean {
  return options[key] === true;
}

function getSkillModeOption(options: Options): SkillMode {
  const value = getStringOption(options, "skill-mode", "all");
  if (value === "all" || value === "per-skill") {
    return value;
  }
  throw new Error(`不支持的 --skill-mode: ${value}`);
}

function issueMessages(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => `${issue.scope}${issue.taskId ? `:${issue.taskId}` : ""} ${issue.message}`);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function recordSkillEffectBucketCount(
  counts: Partial<Record<SkillEffectBucket, number>>,
  bucket: SkillEffectBucket,
): void {
  counts[bucket] = (counts[bucket] ?? 0) + 1;
}

function buildOrdinalRange(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => index + 1);
}

function resolvePendingOrdinals(unit: {
  similarCount: number;
  transferCount: number;
  pendingSimilarOrdinals?: number[];
  pendingTransferOrdinals?: number[];
}): { similarOrdinals: number[]; transferOrdinals: number[] } {
  const similarOrdinals =
    Array.isArray(unit.pendingSimilarOrdinals) ? unit.pendingSimilarOrdinals : buildOrdinalRange(unit.similarCount);
  const transferOrdinals =
    Array.isArray(unit.pendingTransferOrdinals) ? unit.pendingTransferOrdinals : buildOrdinalRange(unit.transferCount);
  return {
    similarOrdinals,
    transferOrdinals,
  };
}

function normalizeFamilyPlan(unit: GenerationUnit, familyPlan: FamilyPlan): FamilyPlan {
  return {
    ...familyPlan,
    templateId: unit.template.templateId,
    skillMode: unit.skillMode,
    targetSkillDirName: unit.targetSkill?.dirName ?? "",
    targetSkillName: unit.targetSkill?.name ?? "",
  };
}

function buildScopeMetadata(
  unit: GenerationUnit,
  runtimeEnvironment?: RuntimeEnvironment,
): Record<string, unknown> {
  return {
    templateId: unit.template.templateId,
    templateRelativePath: unit.template.templateRelativePath,
    skillMode: unit.skillMode,
    scopeSlug: unit.scopeSlug,
    targetSkillDirName: unit.targetSkill?.dirName,
    targetSkillName: unit.targetSkill?.name,
    inputSkillDirNames: unit.inputSkills.map((skill) => skill.dirName),
    inputSkillNames: unit.inputSkills.map((skill) => skill.name),
    similarCount: unit.similarCount,
    transferCount: unit.transferCount,
    pendingSimilarOrdinals: unit.pendingSimilarOrdinals,
    pendingTransferOrdinals: unit.pendingTransferOrdinals,
    finalFamilyDir: unit.finalFamilyDir,
    publishedTaskIds: unit.publishedTasks.map((task) => task.derivedTaskId),
    ...(runtimeEnvironment ? { runtimeEnvironment } : {}),
  };
}

function compareTaskPlansForExecution(left: DerivedTaskPlan, right: DerivedTaskPlan): number {
  if (left.taskRole !== right.taskRole) {
    return left.taskRole === "similar" ? -1 : 1;
  }
  return left.roleOrdinal - right.roleOrdinal;
}

function comparePublishedTasks(left: PublishedTaskInfo, right: PublishedTaskInfo): number {
  if (left.taskRole !== right.taskRole) {
    return left.taskRole === "similar" ? -1 : 1;
  }
  return left.roleOrdinal - right.roleOrdinal;
}

function buildPublishedTaskInfo(plan: DerivedTaskPlan, taskDir: string): PublishedTaskInfo {
  return {
    derivedTaskId: plan.derivedTaskId,
    taskRole: plan.taskRole,
    roleOrdinal: plan.roleOrdinal,
    taskDir,
    planPath: path.join(taskDir, "plan.json"),
    instructionPath: path.join(taskDir, "instruction.md"),
    taskTomlPath: path.join(taskDir, "task.toml"),
    testOutputsPath: path.join(taskDir, "tests", "test_outputs.py"),
    environmentDir: path.join(taskDir, "environment"),
  };
}

function upsertPublishedTask(unit: GenerationUnit, publishedTask: PublishedTaskInfo): void {
  const nextPublishedTasks = unit.publishedTasks.filter((task) => task.derivedTaskId !== publishedTask.derivedTaskId);
  nextPublishedTasks.push(publishedTask);
  nextPublishedTasks.sort(comparePublishedTasks);
  unit.publishedTasks = nextPublishedTasks;
}

async function inventory(templateRoot: string): Promise<void> {
  const templates = await discoverTaskTemplates(templateRoot);
  const rows = await Promise.all(
    templates.map(async (template) => ({
      templateId: template.templateId,
      templateRelativePath: template.templateRelativePath,
      difficulty: template.metadata.difficulty ?? null,
      category: template.metadata.category ?? null,
      referenceSkillNames: template.referenceSkills.map((skill) => skill.name),
      environmentAssets: await collectEnvironmentAssetPaths(template),
    })),
  );
  console.log(JSON.stringify(rows, null, 2));
}

async function repairTaskDraft(
  codex: CodexTaskBuilderClient,
  unit: GenerationUnit,
  workspace: FamilyWorkspace,
  taskState: TaskCycleState,
  cycle: number,
  outputRoot: string,
): Promise<void> {
  const repairResult = await codex.repairTask({
    unit,
    workspace,
    plan: taskState.plan,
    blockingIssues: issueMessages(taskState.blockingIssues),
    staticIssues: issueMessages(taskState.staticIssues),
    runtimeIssues: issueMessages(taskState.runtimeIssues),
    skillEffectIssues: issueMessages(taskState.skillEffectIssues),
    runtimeDir: taskState.runtimeEvidence?.runtimeDir,
    runtimeLogRoot: taskState.runtimeEvidence?.runtimeLogRoot,
    runtimeLogIndexPath: taskState.runtimeEvidence?.runtimeLogIndexPath,
    runtimeLogPath: taskState.runtimeEvidence?.logFilePath,
    runtimeResultPath: taskState.runtimeEvidence?.resultPath,
    jobLogPath: taskState.runtimeEvidence?.jobLogPath,
    trialLogPath: taskState.runtimeEvidence?.trialLogPath,
    verifierStdoutPath: taskState.runtimeEvidence?.verifierStdoutPath,
    rewardPath: taskState.runtimeEvidence?.rewardPath,
    artifactManifestPath: taskState.runtimeEvidence?.artifactManifestPath,
    skillEffectResultPath: taskState.skillEffectResultPath,
    skillEffectBucket: taskState.skillEffectEvaluation?.bucket,
    withSkillLogRoot: taskState.skillEffectEvaluation?.withSkill.evidence.logsDir,
    withSkillResultPath: taskState.skillEffectEvaluation?.withSkill.evidence.resultPath,
    withSkillRewardPath: taskState.skillEffectEvaluation?.withSkill.evidence.rewardPath,
    withSkillTrajectoryPath: taskState.skillEffectEvaluation?.withSkill.evidence.trajectoryPath,
    noSkillLogRoot: taskState.skillEffectEvaluation?.noSkill.evidence.logsDir,
    noSkillResultPath: taskState.skillEffectEvaluation?.noSkill.evidence.resultPath,
    noSkillRewardPath: taskState.skillEffectEvaluation?.noSkill.evidence.rewardPath,
    noSkillTrajectoryPath: taskState.skillEffectEvaluation?.noSkill.evidence.trajectoryPath,
    threadId: taskState.repairThreadId,
  });
  taskState.repairThreadId = repairResult.threadId;
  taskState.repairRoundsUsed += 1;
  taskState.lastMutatedCycle = cycle;
  taskState.runtimePassedCycle = null;
  taskState.skillEffectAcceptedCycle = null;
  taskState.passed = false;
  await writeJson(
    path.join(workspace.artifactsDir, `${taskState.plan.derivedTaskId}.repair.${taskState.repairRoundsUsed}.json`),
    repairResult.data,
  );
  await writeJson(
    path.join(workspace.artifactsDir, `${taskState.plan.derivedTaskId}.repair.${taskState.repairRoundsUsed}.raw.json`),
    {
      threadId: repairResult.threadId,
      raw: repairResult.raw,
    },
  );
  await appendManifest(
    {
      runId: workspace.runId,
      templateId: workspace.templateId,
      derivedTaskId: taskState.plan.derivedTaskId,
      phase: "repair",
      status: "completed",
      threadId: repairResult.threadId,
      draftDir: taskState.draftDir,
      issues: [
        ...issueMessages(taskState.blockingIssues),
        ...issueMessages(taskState.staticIssues),
        ...issueMessages(taskState.runtimeIssues),
        ...issueMessages(taskState.skillEffectIssues),
      ],
    },
    outputRoot,
  );
}

async function executeFamilyGeneration(
  unit: GenerationUnit,
  options: ExecuteFamilyOptions,
): Promise<FamilyExecutionResult> {
  const pendingOrdinals = resolvePendingOrdinals(unit);
  const workspace = await createFamilyWorkspace(unit, {
    rawRoot: options.rawRoot,
  });
  const codex = new CodexTaskBuilderClient();
  const appendRunManifest = (entry: Omit<ManifestEntry, "timestamp">) => appendManifest(entry, options.outputRoot);
  const writeWorkspaceSummary = (summary: unknown) => writeRunSummary(workspace.runId, summary, options.outputRoot);
  const publishedTaskIds: string[] = [];
  const quarantinedTaskIds: string[] = [];
  const finalIssues: string[] = [];
  const skillEffectResults: FamilyExecutionResult["skillEffectResults"] = [];
  const skillEffectBucketCounts: Partial<Record<SkillEffectBucket, number>> = {};

  await appendRunManifest({
    runId: workspace.runId,
    templateId: unit.template.templateId,
    phase: "workspace",
    status: "completed",
    metadata: { rootDir: workspace.rootDir, ...buildScopeMetadata(unit, options.runtimeEnvironment) },
  });

  try {
    const familyPlanResult = await codex.planFamily(unit, workspace);
    const plannerIssues = validateFamilyPlan(familyPlanResult.data, {
      templateId: unit.template.templateId,
      skillMode: unit.skillMode,
      similarCount: pendingOrdinals.similarOrdinals.length,
      transferCount: pendingOrdinals.transferOrdinals.length,
      targetSkillDirName: unit.targetSkill?.dirName,
      targetSkillName: unit.targetSkill?.name,
    });
    const normalizedFamilyPlan = normalizeFamilyPlan(unit, familyPlanResult.data);
    const taskPlans = flattenFamilyPlan(normalizedFamilyPlan, pendingOrdinals);
    const taskPlanIssues = validateTaskPlans(taskPlans, {
      similarOrdinals: pendingOrdinals.similarOrdinals,
      transferOrdinals: pendingOrdinals.transferOrdinals,
    });
    const initialFamilyObservationIssues = collectFamilyObservationIssues(taskPlans, {
      similarCount: pendingOrdinals.similarOrdinals.length,
      transferCount: pendingOrdinals.transferOrdinals.length,
    });
    const blockingIssues = [...plannerIssues, ...taskPlanIssues, ...initialFamilyObservationIssues];

    await writeJson(path.join(workspace.artifactsDir, "family-plan.json"), normalizedFamilyPlan);
    await writeJson(path.join(workspace.artifactsDir, "family-plan.raw.json"), {
      threadId: familyPlanResult.threadId,
      raw: familyPlanResult.raw,
    });

    await appendRunManifest({
      runId: workspace.runId,
      templateId: unit.template.templateId,
      phase: "planner",
      status: blockingIssues.length === 0 ? "completed" : "failed",
      threadId: familyPlanResult.threadId,
      issues: issueMessages(blockingIssues),
      metadata: buildScopeMetadata(unit, options.runtimeEnvironment),
    });

    if (blockingIssues.length > 0) {
      const issues = issueMessages(blockingIssues);
      await writeWorkspaceSummary({
        templateId: unit.template.templateId,
        status: "failed",
        issues,
        outputRoot: options.outputRoot,
        workspace,
      });
      return {
        templateId: unit.template.templateId,
        skillMode: unit.skillMode,
        scopeSlug: unit.scopeSlug,
        targetSkillDirName: unit.targetSkill?.dirName,
        targetSkillName: unit.targetSkill?.name,
        runtimeEnvironment: options.runtimeEnvironment,
        runId: workspace.runId,
        status: "failed",
        issues,
        publishedTaskIds: [],
        quarantinedTaskIds: [],
        skillEffectResults: [],
        skillEffectBucketCounts: {},
        workspace,
      };
    }

    taskPlans.sort(compareTaskPlansForExecution);

    for (const plan of taskPlans) {
      const draftDir = await prepareDraftSkeleton(workspace, plan);
      const writerResult = await codex.writeTask(unit, workspace, plan);
      await writeJson(path.join(workspace.artifactsDir, `${plan.derivedTaskId}.writer.json`), writerResult.data);
      await writeJson(path.join(workspace.artifactsDir, `${plan.derivedTaskId}.writer.raw.json`), {
        threadId: writerResult.threadId,
        raw: writerResult.raw,
      });
      await appendRunManifest({
        runId: workspace.runId,
        templateId: unit.template.templateId,
        derivedTaskId: plan.derivedTaskId,
        phase: "writer",
        status: "completed",
        threadId: writerResult.threadId,
        draftDir,
        metadata: buildScopeMetadata(unit, options.runtimeEnvironment),
      });

      const taskState: TaskCycleState = {
        plan,
        draftDir,
        writerSummary: writerResult.data,
        repairThreadId: null,
        repairRoundsUsed: 0,
        runtimeAttemptCount: 0,
        skillEffectAttemptCount: 0,
        lastMutatedCycle: null,
        runtimePassedCycle: null,
        skillEffectAcceptedCycle: null,
        blockingIssues: [],
        staticIssues: [],
        runtimeIssues: [],
        skillEffectIssues: [],
        passed: false,
      };

      for (let cycle = 0; cycle <= options.maxRepairRounds; cycle += 1) {
        const reviewResult = await codex.reviewTaskBlocking(unit, workspace, normalizedFamilyPlan, plan);
        const reviewValidation = validateBlockingReviewResult([plan], reviewResult.data);
        await writeJson(path.join(workspace.artifactsDir, `${plan.derivedTaskId}.review.round-${cycle}.json`), reviewResult.data);
        await writeJson(path.join(workspace.artifactsDir, `${plan.derivedTaskId}.review.round-${cycle}.raw.json`), {
          threadId: reviewResult.threadId,
          raw: reviewResult.raw,
        });

        taskState.blockingIssues = reviewValidation.taskIssuesById.get(plan.derivedTaskId) ?? [];
        taskState.staticIssues = await validateDraftStatic(taskState.draftDir, plan, unit);
        taskState.runtimeIssues = [];
        taskState.skillEffectIssues = [];
        taskState.passed = false;

        const preRuntimeIssues = [...taskState.blockingIssues, ...taskState.staticIssues];
        await appendRunManifest({
          runId: workspace.runId,
          templateId: unit.template.templateId,
          derivedTaskId: plan.derivedTaskId,
          phase: "validate",
          status: preRuntimeIssues.length === 0 ? "completed" : "failed",
          draftDir: taskState.draftDir,
          issues: issueMessages(preRuntimeIssues),
          metadata: {
            ...buildScopeMetadata(unit, options.runtimeEnvironment),
            cycle,
          },
        });

        if (preRuntimeIssues.length > 0) {
          taskState.runtimeEvidence = undefined;
          taskState.skillEffectEvaluation = undefined;
          taskState.skillEffectResultPath = undefined;
          taskState.runtimePassedCycle = null;
          taskState.skillEffectAcceptedCycle = null;
          if (taskState.repairRoundsUsed < options.maxRepairRounds) {
            await repairTaskDraft(codex, unit, workspace, taskState, cycle, options.outputRoot);
            continue;
          }
          break;
        }

        const runtimeAttemptIndex = taskState.runtimeAttemptCount + 1;
        const runtimeResult = await runRuntimeValidation(
          workspace,
          plan,
          options.runtimeEnvironment,
          cycle,
          runtimeAttemptIndex,
        );
        taskState.runtimeAttemptCount = runtimeAttemptIndex;
        taskState.runtimeIssues = runtimeResult.issues;
        taskState.runtimeEvidence = runtimeResult.evidence;
        await writeJson(
          path.join(workspace.artifactsDir, `${plan.derivedTaskId}.runtime.cycle-${cycle}.attempt-${runtimeAttemptIndex}.json`),
          {
            passed: runtimeResult.passed,
            failureKind: runtimeResult.failureKind,
            issues: issueMessages(runtimeResult.issues),
            evidence: runtimeResult.evidence,
          },
        );
        await writeJson(path.join(workspace.artifactsDir, `${plan.derivedTaskId}.runtime.cycle-${cycle}.json`), {
          passed: runtimeResult.passed,
          failureKind: runtimeResult.failureKind,
          issues: issueMessages(runtimeResult.issues),
          evidence: runtimeResult.evidence,
        });

        if (!runtimeResult.passed) {
          taskState.runtimePassedCycle = null;
          taskState.skillEffectAcceptedCycle = null;
          taskState.skillEffectEvaluation = undefined;
          taskState.skillEffectResultPath = undefined;
          await appendRunManifest({
            runId: workspace.runId,
            templateId: unit.template.templateId,
            derivedTaskId: plan.derivedTaskId,
            phase: "validate",
            status: "failed",
            draftDir: taskState.draftDir,
            issues: issueMessages(runtimeResult.issues),
            metadata: {
              ...buildScopeMetadata(unit, options.runtimeEnvironment),
              cycle,
              runtimeAttempt: runtimeAttemptIndex,
              runtimeFailureKind: runtimeResult.failureKind,
            },
          });

          if (taskState.repairRoundsUsed < options.maxRepairRounds) {
            await repairTaskDraft(codex, unit, workspace, taskState, cycle, options.outputRoot);
            continue;
          }
          break;
        }

        taskState.runtimePassedCycle = cycle;

        if (!options.skillEffectEnabled) {
          taskState.passed = true;
          break;
        }

        const skillEffectAttemptIndex = taskState.skillEffectAttemptCount + 1;
        const skillEffectResult = await runSkillEffectEvaluation({
          workspace,
          plan,
          runtimeEnvironment: options.runtimeEnvironment,
          cycle,
          attemptIndex: skillEffectAttemptIndex,
          draftTaskDir: taskState.draftDir,
          modelName: options.skillEffectModel,
          apiKey: options.skillEffectApiKey,
          baseUrl: options.skillEffectBaseUrl,
        });
        taskState.skillEffectAttemptCount = skillEffectAttemptIndex;
        taskState.skillEffectEvaluation = skillEffectResult;
        taskState.skillEffectIssues = buildSkillEffectIssues(plan.derivedTaskId, skillEffectResult);
        taskState.skillEffectAcceptedCycle = skillEffectResult.repairRequired ? null : cycle;
        taskState.skillEffectResultPath = path.join(
          workspace.artifactsDir,
          `${plan.derivedTaskId}.skill-effect.cycle-${cycle}.attempt-${skillEffectAttemptIndex}.json`,
        );
        await writeJson(taskState.skillEffectResultPath, skillEffectResult);
        await writeJson(path.join(workspace.artifactsDir, `${plan.derivedTaskId}.skill-effect.cycle-${cycle}.json`), skillEffectResult);
        await appendRunManifest({
          runId: workspace.runId,
          templateId: unit.template.templateId,
          derivedTaskId: plan.derivedTaskId,
          phase: "skill-effect",
          status: skillEffectResult.repairRequired ? "failed" : "completed",
          draftDir: taskState.draftDir,
          issues: issueMessages(taskState.skillEffectIssues),
          metadata: {
            ...buildScopeMetadata(unit, options.runtimeEnvironment),
            cycle,
            skillEffectAttempt: skillEffectAttemptIndex,
            skillEffectBucket: skillEffectResult.bucket,
          },
        });

        if (!skillEffectResult.repairRequired) {
          taskState.passed = true;
          break;
        }

        if (taskState.repairRoundsUsed < options.maxRepairRounds) {
          await repairTaskDraft(codex, unit, workspace, taskState, cycle, options.outputRoot);
          continue;
        }
        break;
      }

      if (taskState.skillEffectEvaluation) {
        skillEffectResults.push({
          derivedTaskId: plan.derivedTaskId,
          bucket: taskState.skillEffectEvaluation.bucket,
          repairRequired: taskState.skillEffectEvaluation.repairRequired,
          withSkillPassed: taskState.skillEffectEvaluation.withSkill.passed,
          withSkillReward: taskState.skillEffectEvaluation.withSkill.evidence.reward ?? null,
          withSkillSummary: taskState.skillEffectEvaluation.withSkill.evidence.summary,
          noSkillPassed: taskState.skillEffectEvaluation.noSkill.passed,
          noSkillReward: taskState.skillEffectEvaluation.noSkill.evidence.reward ?? null,
          noSkillSummary: taskState.skillEffectEvaluation.noSkill.evidence.summary,
        });
        recordSkillEffectBucketCount(skillEffectBucketCounts, taskState.skillEffectEvaluation.bucket);
      }

      if (taskState.passed) {
        const materializeResult = await sanitizeAndCopyTask({
          sourceDraftDir: taskState.draftDir,
          templateId: unit.template.templateId,
          scopeSlug: unit.scopeSlug,
          taskName: plan.derivedTaskId,
          rawRoot: options.rawRoot,
          targetRoot: options.finalRoot,
        });
        publishedTaskIds.push(plan.derivedTaskId);
        upsertPublishedTask(unit, buildPublishedTaskInfo(plan, materializeResult.targetTaskDir));
        await appendRunManifest({
          runId: workspace.runId,
          templateId: unit.template.templateId,
          derivedTaskId: plan.derivedTaskId,
          phase: "publish",
          status: "completed",
          draftDir: taskState.draftDir,
          publishedDir: materializeResult.targetTaskDir,
          metadata: {
            ...buildScopeMetadata(unit, options.runtimeEnvironment),
            publishDisposition: materializeResult.disposition,
          },
        });

        if (taskState.skillEffectEvaluation) {
          const bucketResult = await sanitizeAndCopyTask({
            sourceDraftDir: taskState.draftDir,
            templateId: unit.template.templateId,
            scopeSlug: unit.scopeSlug,
            taskName: plan.derivedTaskId,
            rawRoot: options.rawRoot,
            targetRoot: buildSkillEffectBucketRoot(options.finalRoot, taskState.skillEffectEvaluation.bucket),
          });
          await appendRunManifest({
            runId: workspace.runId,
            templateId: unit.template.templateId,
            derivedTaskId: plan.derivedTaskId,
            phase: "skill-effect-bucket",
            status: "completed",
            draftDir: taskState.draftDir,
            publishedDir: bucketResult.targetTaskDir,
            metadata: {
              ...buildScopeMetadata(unit, options.runtimeEnvironment),
              skillEffectBucket: taskState.skillEffectEvaluation.bucket,
              publishDisposition: bucketResult.disposition,
              bucketTarget: "final",
            },
          });
        }
        continue;
      }

      const quarantineIssues = [
        ...issueMessages(taskState.blockingIssues),
        ...issueMessages(taskState.staticIssues),
        ...issueMessages(taskState.runtimeIssues),
        ...issueMessages(taskState.skillEffectIssues),
      ];
      const quarantineResult = await sanitizeAndCopyTask({
        sourceDraftDir: taskState.draftDir,
        templateId: unit.template.templateId,
        scopeSlug: unit.scopeSlug,
        taskName: plan.derivedTaskId,
        rawRoot: options.rawRoot,
        targetRoot: options.quarantineRoot,
      });
      quarantinedTaskIds.push(plan.derivedTaskId);
      finalIssues.push(...quarantineIssues);
      await appendRunManifest({
        runId: workspace.runId,
        templateId: unit.template.templateId,
        derivedTaskId: plan.derivedTaskId,
        phase: "publish",
        status: "failed",
        draftDir: taskState.draftDir,
        publishedDir: quarantineResult.targetTaskDir,
        issues: quarantineIssues,
        metadata: {
          ...buildScopeMetadata(unit, options.runtimeEnvironment),
          publishDisposition: quarantineResult.disposition,
        },
      });

      if (taskState.skillEffectEvaluation) {
        const bucketResult = await sanitizeAndCopyTask({
          sourceDraftDir: taskState.draftDir,
          templateId: unit.template.templateId,
          scopeSlug: unit.scopeSlug,
          taskName: plan.derivedTaskId,
          rawRoot: options.rawRoot,
          targetRoot: buildSkillEffectBucketRoot(options.quarantineRoot, taskState.skillEffectEvaluation.bucket),
        });
        await appendRunManifest({
          runId: workspace.runId,
          templateId: unit.template.templateId,
          derivedTaskId: plan.derivedTaskId,
          phase: "skill-effect-bucket",
          status: "failed",
          draftDir: taskState.draftDir,
          publishedDir: bucketResult.targetTaskDir,
          metadata: {
            ...buildScopeMetadata(unit, options.runtimeEnvironment),
            skillEffectBucket: taskState.skillEffectEvaluation.bucket,
            publishDisposition: bucketResult.disposition,
            bucketTarget: "quarantine",
          },
        });
      }
    }

    const status: FamilyExecutionResult["status"] = quarantinedTaskIds.length === 0 ? "completed" : "failed";
    const summary = {
      templateId: unit.template.templateId,
      templateRelativePath: unit.template.templateRelativePath,
      skillMode: unit.skillMode,
      scopeSlug: unit.scopeSlug,
      targetSkillDirName: unit.targetSkill?.dirName,
      targetSkillName: unit.targetSkill?.name,
      runtimeEnvironment: options.runtimeEnvironment,
      status,
      issues: uniqueStrings(finalIssues),
      publishedTaskIds,
      quarantinedTaskIds,
      skillEffectResults,
      skillEffectBucketCounts,
      outputRoot: options.outputRoot,
      workspace,
      finalDirs: publishedTaskIds.map((taskId) =>
        buildMaterializedTaskDir({
          targetRoot: options.finalRoot,
          templateId: unit.template.templateId,
          scopeSlug: unit.scopeSlug,
          taskName: taskId,
        }),
      ),
      quarantineDirs: quarantinedTaskIds.map((taskId) =>
        buildMaterializedTaskDir({
          targetRoot: options.quarantineRoot,
          templateId: unit.template.templateId,
          scopeSlug: unit.scopeSlug,
          taskName: taskId,
        }),
      ),
    };
    await writeWorkspaceSummary(summary);

    return {
      templateId: unit.template.templateId,
      skillMode: unit.skillMode,
      scopeSlug: unit.scopeSlug,
      targetSkillDirName: unit.targetSkill?.dirName,
      targetSkillName: unit.targetSkill?.name,
      runtimeEnvironment: options.runtimeEnvironment,
      runId: workspace.runId,
      status,
      issues: summary.issues,
      publishedTaskIds,
      quarantinedTaskIds,
      skillEffectResults,
      skillEffectBucketCounts,
      workspace,
    };
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await appendRunManifest({
      runId: workspace.runId,
      templateId: unit.template.templateId,
      phase: "family",
      status: "failed",
      issues: [message],
      metadata: buildScopeMetadata(unit, options.runtimeEnvironment),
    });
    await writeWorkspaceSummary({
      templateId: unit.template.templateId,
      status: "failed",
      issues: uniqueStrings([...finalIssues, message]),
      publishedTaskIds,
      quarantinedTaskIds,
      skillEffectResults,
      skillEffectBucketCounts,
      outputRoot: options.outputRoot,
      workspace,
      finalDirs: publishedTaskIds.map((taskId) =>
        buildMaterializedTaskDir({
          targetRoot: options.finalRoot,
          templateId: unit.template.templateId,
          scopeSlug: unit.scopeSlug,
          taskName: taskId,
        }),
      ),
      quarantineDirs: quarantinedTaskIds.map((taskId) =>
        buildMaterializedTaskDir({
          targetRoot: options.quarantineRoot,
          templateId: unit.template.templateId,
          scopeSlug: unit.scopeSlug,
          taskName: taskId,
        }),
      ),
    });
    return {
      templateId: unit.template.templateId,
      skillMode: unit.skillMode,
      scopeSlug: unit.scopeSlug,
      targetSkillDirName: unit.targetSkill?.dirName,
      targetSkillName: unit.targetSkill?.name,
      runtimeEnvironment: options.runtimeEnvironment,
      runId: workspace.runId,
      status: "failed",
      issues: uniqueStrings([...finalIssues, message]),
      publishedTaskIds,
      quarantinedTaskIds,
      skillEffectResults,
      skillEffectBucketCounts,
      workspace,
    };
  }
}

async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function loop(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => loop()));
  return results;
}

function assertNoLegacyOptions(options: Options): void {
  const legacyKeys = [
    "source-root",
    "source-task-id",
    "target-skill-dir",
    "raw-root",
    "final-root",
    "quarantine-root",
    "runs-root",
  ].filter((key) => key in options);
  if (legacyKeys.length > 0) {
    throw new Error(`检测到旧参数 ${legacyKeys.map((key) => `--${key}`).join(", ")}；当前版本只支持 template + skill-dir + output-root 模式`);
  }
}

async function loadUnitsForCommand(
  options: Options,
  finalRoot: string,
): Promise<{
  units: GenerationUnit[];
  discoveredUnitCount: number;
  skippedCount: number;
}> {
  const templateRoot = getStringOption(options, "template-root", TEMPLATE_ROOT)!;
  const templateRelativePath = getStringOption(options, "template");
  if (!templateRelativePath) {
    throw new Error("generate-family 命令需要 --template <relative-path>");
  }

  const skillDirs = getStringArrayOption(options, "skill-dir");
  if (skillDirs.length === 0) {
    throw new Error("generate-family 命令至少需要一个 --skill-dir <path>");
  }

  const skillMode = getSkillModeOption(options);
  const similarCount = getNumberOption(options, "similar-count", 1);
  const transferCount = getNumberOption(options, "transfer-count", 3);
  if (similarCount < 0 || transferCount < 0) {
    throw new Error("similar-count 和 transfer-count 不能小于 0");
  }
  if (similarCount + transferCount === 0) {
    throw new Error("similar-count 和 transfer-count 不能同时为 0");
  }

  const template = await discoverTaskTemplate(templateRelativePath, templateRoot);
  const inputSkills = await discoverInputSkills(skillDirs);
  let units = buildGenerationUnits(template, inputSkills, {
    skillMode,
    similarCount,
    transferCount,
  });

  const scopeSlug = getStringOption(options, "scope-slug");
  if (scopeSlug) {
    units = units.filter((unit) => unit.scopeSlug === scopeSlug);
  }

  const hydratedUnits = await Promise.all(
    units.map(async (unit) => {
      const publishedState = await inspectPublishedFamily(unit, finalRoot);
      return applyPublishedFamilyState(unit, publishedState);
    }),
  );
  const limit = getNumberOption(options, "limit", 0);
  const selected = selectExecutableUnits(hydratedUnits, limit);
  return {
    units: selected.executableUnits,
    discoveredUnitCount: hydratedUnits.length,
    skippedCount: selected.skippedCount,
  };
}

async function ensureRoots(options: ExecuteFamilyOptions): Promise<void> {
  await ensureDir(options.outputRoot);
  await ensureDir(options.rawRoot);
  await ensureDir(options.finalRoot);
  await ensureDir(options.quarantineRoot);
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "inventory") {
    assertNoLegacyOptions(options);
    await inventory(getStringOption(options, "template-root", TEMPLATE_ROOT)!);
    return;
  }

  if (command === "batch") {
    throw new Error("batch 已移除；当前版本只支持显式的 template + --skill-dir 输入。后续如需批处理，请通过配置文件模式支持。");
  }

  if (command === "review") {
    throw new Error("review 已移除；当前版本聚焦从 template + skills 直接生成任务，不再保留旧 workspace reviewer 重跑入口。");
  }

  if (command !== "generate-family") {
    throw new Error(`不支持的命令: ${command ?? "(missing)"}`);
  }

  assertNoLegacyOptions(options);
  const runtimeEnvironment = resolveRuntimeEnvironment();
  const skillEffectEnabled = !getFlagOption(options, "skip-skill-effect-gate");
  const skillEffectModel = getStringOption(options, "skill-effect-model", "openai/gpt-5.4")!;
  const outputRoot = getStringOption(options, "output-root", DEFAULT_OUTPUT_ROOT)!;
  const executeOptions: ExecuteFamilyOptions = {
    outputRoot,
    rawRoot: buildRawRoot(outputRoot),
    finalRoot: buildFinalRoot(outputRoot),
    quarantineRoot: buildQuarantineRoot(outputRoot),
    runtimeEnvironment,
    maxRepairRounds: getNumberOption(options, "max-repair-rounds", 2),
    skillEffectEnabled,
    skillEffectModel,
    skillEffectApiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
    skillEffectBaseUrl: process.env.OPENAI_BASE_URL?.trim() || undefined,
  };
  await ensureRoots(executeOptions);

  const preflight = await runRuntimePreflight(runtimeEnvironment);
  if (!preflight.ok) {
    throw new Error(preflight.summary);
  }

  if (executeOptions.skillEffectEnabled) {
    const skillEffectPreflight = await runSkillEffectPreflight(runtimeEnvironment);
    if (!skillEffectPreflight.ok) {
      throw new Error(skillEffectPreflight.summary);
    }
  }

  const loaded = await loadUnitsForCommand(options, executeOptions.finalRoot);
  const units = loaded.units;
  if (units.length === 0) {
    console.log(
      JSON.stringify(
        {
          status: "empty",
          units: 0,
          discoveredUnitCount: loaded.discoveredUnitCount,
          skippedCount: loaded.skippedCount,
          outputRoot: executeOptions.outputRoot,
          rawRoot: executeOptions.rawRoot,
          finalRoot: executeOptions.finalRoot,
          quarantineRoot: executeOptions.quarantineRoot,
        },
        null,
        2,
      ),
    );
    return;
  }

  const concurrency = getNumberOption(options, "concurrency", 1);
  const results = await runPool(units, concurrency, async (unit, index) => {
    console.log(
      `[${index + 1}/${units.length}] 开始 ${unit.template.templateId}/${unit.scopeSlug} pending-similar=${unit.pendingSimilarOrdinals.length}/${unit.similarCount} pending-transfer=${unit.pendingTransferOrdinals.length}/${unit.transferCount}`,
    );
    const result = await executeFamilyGeneration(unit, executeOptions);
    console.log(`[${index + 1}/${units.length}] 完成 ${unit.template.templateId}/${unit.scopeSlug} status=${result.status}`);
    return result;
  });

  const skillEffectBucketCounts: Partial<Record<SkillEffectBucket, number>> = {};
  for (const result of results) {
    for (const [bucket, count] of Object.entries(result.skillEffectBucketCounts)) {
      const typedBucket = bucket as SkillEffectBucket;
      skillEffectBucketCounts[typedBucket] = (skillEffectBucketCounts[typedBucket] ?? 0) + (count ?? 0);
    }
  }

  const summary = {
    runtimeEnvironment,
    unitCount: results.length,
    discoveredUnitCount: loaded.discoveredUnitCount,
    successCount: results.filter((result) => result.status === "completed").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    skippedCount: loaded.skippedCount,
    publishedTaskCount: results.reduce((sum, result) => sum + result.publishedTaskIds.length, 0),
    quarantinedTaskCount: results.reduce((sum, result) => sum + result.quarantinedTaskIds.length, 0),
    skillEffectEnabled: executeOptions.skillEffectEnabled,
    skillEffectModel: executeOptions.skillEffectModel,
    skillEffectBucketCounts,
    outputRoot: executeOptions.outputRoot,
    rawRoot: executeOptions.rawRoot,
    finalRoot: executeOptions.finalRoot,
    quarantineRoot: executeOptions.quarantineRoot,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

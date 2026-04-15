import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { GenerationUnit, SkillInfo, TaskTemplate } from "../src/discovery.js";
import {
  appendManifest,
  buildManifestPath,
  buildRunSummaryPath,
  writeRunSummary,
} from "../src/manifest.js";
import { sanitizeAndCopyTask } from "../src/materialize.js";
import { inspectPublishedFamily, selectExecutableUnits } from "../src/published.js";
import {
  flattenFamilyPlan,
  type BlockingReviewResult,
  type DerivedTaskPlan,
  type FamilyPlan,
} from "../src/schema.js";
import {
  buildSkillEffectBucket,
  buildSkillEffectBucketRoot,
  isAcceptedSkillEffectBucket,
  isRepairRequiredSkillEffectBucket,
  prepareNoSkillVariant,
  stripSkillCopyLines,
} from "../src/skill_effect.js";
import {
  buildFinalRoot,
  buildQuarantineRoot,
  buildRawRoot,
  ensureDir,
  pathExists,
  readText,
  writeText,
} from "../src/utils.js";
import {
  validateBlockingReviewResult,
  validateDraftStatic,
  validateFamilyPlan,
  validateTaskPlans,
} from "../src/validate.js";

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-task-builder-v2-"));

async function createSkillFixture(dirName: string, name: string): Promise<SkillInfo> {
  const sourceDir = path.join(fixtureRoot, "skills", dirName);
  await ensureDir(sourceDir);
  await writeText(path.join(sourceDir, "SKILL.md"), `---\nname: "${name}"\n---\n`);
  await writeText(path.join(sourceDir, "notes.txt"), `${name}\n`);
  return {
    name,
    dirName,
    relativeDir: dirName,
    sourceDir,
    skillMdPath: path.join(sourceDir, "SKILL.md"),
  };
}

const nodeConnectSkill = await createSkillFixture("01__node-connect", "Node Connect");
const sessionLogsSkill = await createSkillFixture("03__session-logs", "Session Logs");

const template: TaskTemplate = {
  templateId: "tools__debugging",
  templateRelativePath: "tools/debugging",
  sourceDir: path.join(fixtureRoot, "template", "tools", "debugging"),
  taskTomlPath: path.join(fixtureRoot, "template", "tools", "debugging", "task.toml"),
  instructionPath: path.join(fixtureRoot, "template", "tools", "debugging", "instruction.md"),
  environmentDir: path.join(fixtureRoot, "template", "tools", "debugging", "environment"),
  solutionDir: path.join(fixtureRoot, "template", "tools", "debugging", "solution"),
  testsDir: path.join(fixtureRoot, "template", "tools", "debugging", "tests"),
  templateSkillsDir: path.join(fixtureRoot, "template", "tools", "debugging", "environment", "skills"),
  metadata: {
    id: "debugging-template",
    name: "Debugging Template",
    difficulty: "hard",
    category: "debugging",
    tags: ["debugging"],
  },
  referenceSkills: [],
};

const perSkillUnit: GenerationUnit = {
  template,
  inputSkills: [nodeConnectSkill],
  skillMode: "per-skill",
  targetSkill: nodeConnectSkill,
  scopeSlug: nodeConnectSkill.dirName,
  scopeLabel: nodeConnectSkill.name,
  similarCount: 1,
  transferCount: 1,
  pendingSimilarOrdinals: [1],
  pendingTransferOrdinals: [1],
  finalFamilyDir: "/tmp/final/tools__debugging/01__node-connect",
  publishedTasks: [],
};

const allSkillUnit: GenerationUnit = {
  template,
  inputSkills: [nodeConnectSkill, sessionLogsSkill],
  skillMode: "all",
  targetSkill: null,
  scopeSlug: "all-skills",
  scopeLabel: "All input skills",
  similarCount: 1,
  transferCount: 1,
  pendingSimilarOrdinals: [1],
  pendingTransferOrdinals: [1],
  finalFamilyDir: "/tmp/final/tools__debugging/all-skills",
  publishedTasks: [],
};

const plan: DerivedTaskPlan = {
  derivedTaskId: "transfer1",
  taskRole: "transfer",
  roleOrdinal: 1,
  title: "Transfer 1",
  goal: "Repair the failing service.",
  primaryOutputFile: "incident-summary.json",
  difficulty: "hard",
  category: "debugging",
  skillBenefitRationale: "Requires the injected debugging workflow.",
  templateId: template.templateId,
  skillMode: "per-skill",
  targetSkillDirName: nodeConnectSkill.dirName,
  targetSkillName: nodeConnectSkill.name,
};

async function makeDraftFixture(
  unit: GenerationUnit,
  taskPlan: DerivedTaskPlan,
  options: {
    sourceTemplateId?: string;
    instructionText?: string;
    dockerfile?: string;
    mutateInjectedSkill?: boolean;
    visibleSkillOverride?: SkillInfo[];
  } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-builder-draft-"));
  const visibleSkills = options.visibleSkillOverride ?? unit.inputSkills;

  await ensureDir(path.join(root, "environment", "skills"));
  for (const skill of visibleSkills) {
    await fs.cp(skill.sourceDir, path.join(root, "environment", "skills", skill.dirName), { recursive: true, force: true });
  }
  if (options.mutateInjectedSkill) {
    await writeText(
      path.join(root, "environment", "skills", visibleSkills[0]!.dirName, "notes.txt"),
      "mutated\n",
    );
  }

  await ensureDir(path.join(root, "solution"));
  await ensureDir(path.join(root, "tests"));
  await writeText(path.join(root, "plan.json"), `${JSON.stringify(taskPlan, null, 2)}\n`);
  await writeText(
    path.join(root, "task.toml"),
    `version = "1.0"

[metadata]
id = "${taskPlan.derivedTaskId}"
name = "${taskPlan.taskRole === "similar" ? "Similar" : "Transfer"} ${taskPlan.roleOrdinal} | Fixture"
description = "Fixture task."
author_name = "Test Author"
author_email = "test@example.com"
difficulty = "${taskPlan.difficulty}"
category = "${taskPlan.category}"
tags = ["debugging", "fixture"]
primary_output_file = "${taskPlan.primaryOutputFile}"
source_template_id = "${options.sourceTemplateId ?? taskPlan.templateId}"
task_role = "${taskPlan.taskRole}"

[environment]
cpus = 2
memory_mb = 2048
storage_mb = 5120
gpus = 0
`,
  );
  await writeText(path.join(root, "instruction.md"), options.instructionText ?? "Repair the system.\n");
  await writeText(
    path.join(root, "environment", "Dockerfile"),
    options.dockerfile ?? "FROM ubuntu:24.04\nWORKDIR /root\nCOPY skills /root/.codex/skills\n",
  );
  await writeText(path.join(root, "solution", "solve.sh"), "#!/bin/bash\n");
  await writeText(path.join(root, "tests", "test.sh"), "#!/bin/bash\nmkdir -p /logs/verifier\n");
  await writeText(path.join(root, "tests", "test_outputs.py"), "def test_ok():\n    assert True\n");
  return root;
}

{
  const familyPlan: FamilyPlan = {
    templateId: template.templateId,
    skillMode: "per-skill",
    targetSkillDirName: nodeConnectSkill.dirName,
    targetSkillName: nodeConnectSkill.name,
    familyTheme: "Debugging family",
    similarTasks: [
      {
        title: "Similar 1",
        goal: "A",
        primaryOutputFile: "similar.json",
        difficulty: "hard",
        category: "debugging",
        skillBenefitRationale: "A",
      },
    ],
    transferTasks: [
      {
        title: "Transfer 1",
        goal: "B",
        primaryOutputFile: "transfer.json",
        difficulty: "hard",
        category: "debugging",
        skillBenefitRationale: "B",
      },
    ],
  };

  assert.deepEqual(
    validateFamilyPlan(familyPlan, {
      templateId: template.templateId,
      skillMode: "per-skill",
      similarCount: 1,
      transferCount: 1,
      targetSkillDirName: nodeConnectSkill.dirName,
      targetSkillName: nodeConnectSkill.name,
    }),
    [],
  );

  const taskPlans = flattenFamilyPlan(familyPlan);
  assert.equal(taskPlans[0]?.templateId, template.templateId);
  assert.deepEqual(validateTaskPlans(taskPlans, { similarOrdinals: [1], transferOrdinals: [1] }), []);
}

{
  const blockingReview: BlockingReviewResult = {
    taskResults: [
      {
        derivedTaskId: plan.derivedTaskId,
        blockingPass: false,
        blockingIssues: ["instruction.md leaked the shipped skill name"],
      },
    ],
  };
  const validation = validateBlockingReviewResult([plan], blockingReview);
  assert.equal(validation.taskIssuesById.get(plan.derivedTaskId)?.[0]?.scope, "reviewer");
  assert.match(
    validation.taskIssuesById.get(plan.derivedTaskId)?.[0]?.message ?? "",
    /leaked the shipped skill name/,
  );
}

{
  const cleanDraft = await makeDraftFixture(perSkillUnit, plan);
  try {
    const issues = await validateDraftStatic(cleanDraft, plan, perSkillUnit);
    assert.deepEqual(
      issues.map((issue) => issue.message),
      [],
    );
  } finally {
    await fs.rm(cleanDraft, { recursive: true, force: true });
  }
}

{
  const wrongMetadataDraft = await makeDraftFixture(perSkillUnit, plan, {
    sourceTemplateId: "wrong-template",
  });
  try {
    const issues = await validateDraftStatic(wrongMetadataDraft, plan, perSkillUnit);
    assert.ok(issues.some((issue) => issue.message.includes("metadata.source_template_id=wrong-template")));
  } finally {
    await fs.rm(wrongMetadataDraft, { recursive: true, force: true });
  }
}

{
  const mutatedSkillDraft = await makeDraftFixture(perSkillUnit, plan, {
    mutateInjectedSkill: true,
  });
  try {
    const issues = await validateDraftStatic(mutatedSkillDraft, plan, perSkillUnit);
    assert.ok(issues.some((issue) => issue.message.includes("与输入 skill 不一致")));
  } finally {
    await fs.rm(mutatedSkillDraft, { recursive: true, force: true });
  }
}

{
  const allModePlan: DerivedTaskPlan = {
    ...plan,
    derivedTaskId: "similar1",
    taskRole: "similar",
    roleOrdinal: 1,
    primaryOutputFile: "all-mode-summary.json",
    skillMode: "all",
    targetSkillDirName: "",
    targetSkillName: "",
  };
  const allModeDraft = await makeDraftFixture(allSkillUnit, allModePlan);
  try {
    const issues = await validateDraftStatic(allModeDraft, allModePlan, allSkillUnit);
    assert.deepEqual(issues, []);
  } finally {
    await fs.rm(allModeDraft, { recursive: true, force: true });
  }
}

{
  const outputRoot = path.join(fixtureRoot, "output");
  await appendManifest(
    {
      runId: "run-1",
      templateId: template.templateId,
      phase: "workspace",
      status: "completed",
    },
    outputRoot,
  );
  await writeRunSummary("run-1", { ok: true }, outputRoot);
  assert.equal(await pathExists(buildManifestPath(outputRoot)), true);
  assert.equal(await pathExists(buildRunSummaryPath(outputRoot, "run-1")), true);
  const manifestText = await readText(buildManifestPath(outputRoot));
  assert.match(manifestText, /"templateId":"tools__debugging"/);
}

{
  const outputRoot = path.join(fixtureRoot, "materialize-output");
  const rawRoot = buildRawRoot(outputRoot);
  const finalRoot = buildFinalRoot(outputRoot);
  const quarantineRoot = buildQuarantineRoot(outputRoot);
  await Promise.all([ensureDir(rawRoot), ensureDir(finalRoot), ensureDir(quarantineRoot)]);

  const sourceDraftDir = path.join(rawRoot, "run-1", template.templateId, nodeConnectSkill.dirName, "transfer1");
  await ensureDir(sourceDraftDir);
  await writeText(path.join(sourceDraftDir, "task.toml"), "x\n");
  await writeText(path.join(sourceDraftDir, "instruction.md"), "x\n");
  await ensureDir(path.join(sourceDraftDir, "environment"));
  await ensureDir(path.join(sourceDraftDir, "solution"));
  await ensureDir(path.join(sourceDraftDir, "tests"));
  await writeText(path.join(sourceDraftDir, "plan.json"), "{}\n");

  const result = await sanitizeAndCopyTask({
    sourceDraftDir,
    templateId: template.templateId,
    scopeSlug: nodeConnectSkill.dirName,
    taskName: "transfer1",
    rawRoot,
    targetRoot: finalRoot,
  });
  assert.equal(result.disposition, "created");
  assert.equal(
    result.targetTaskDir,
    path.join(finalRoot, template.templateId, nodeConnectSkill.dirName, "transfer1"),
  );
}

{
  const finalRoot = path.join(fixtureRoot, "published-final");
  const familyDir = path.join(finalRoot, template.templateId, nodeConnectSkill.dirName, "transfer1");
  await ensureDir(path.join(familyDir, "tests"));
  await writeText(path.join(familyDir, "plan.json"), "{}\n");
  await writeText(path.join(familyDir, "instruction.md"), "x\n");
  await writeText(path.join(familyDir, "task.toml"), "x\n");
  await writeText(path.join(familyDir, "tests", "test_outputs.py"), "x\n");

  const state = await inspectPublishedFamily(perSkillUnit, finalRoot);
  assert.equal(state.finalFamilyDir, path.join(finalRoot, template.templateId, nodeConnectSkill.dirName));
  assert.deepEqual(state.pendingSimilarOrdinals, [1]);
  assert.deepEqual(state.pendingTransferOrdinals, []);

  const selected = selectExecutableUnits([
    { ...perSkillUnit, pendingSimilarOrdinals: [1], pendingTransferOrdinals: [] },
    { ...perSkillUnit, scopeSlug: "done", pendingSimilarOrdinals: [], pendingTransferOrdinals: [] },
  ]);
  assert.equal(selected.executableUnits.length, 1);
  assert.equal(selected.skippedCount, 1);
}

{
  const stripped = stripSkillCopyLines("FROM ubuntu:24.04\nCOPY skills /root/.codex/skills\nRUN echo ok\n");
  assert.equal(stripped.removedCount, 1);
  assert.match(stripped.text, /RUN echo ok/);
  assert.equal(buildSkillEffectBucket(true, false), "with_skill_pass__no_skill_fail");
  assert.equal(isAcceptedSkillEffectBucket("with_skill_pass__no_skill_fail"), true);
  assert.equal(isAcceptedSkillEffectBucket("with_skill_fail__no_skill_fail"), false);
  assert.equal(isRepairRequiredSkillEffectBucket("with_skill_fail__no_skill_fail"), true);
  assert.equal(isRepairRequiredSkillEffectBucket("with_skill_fail__no_skill_pass"), true);
  assert.equal(
    buildSkillEffectBucketRoot("/tmp/output/final", "with_skill_pass__no_skill_fail"),
    "/tmp/output/final/_skill_effect_buckets/with_skill_pass__no_skill_fail",
  );
}

{
  const sourceTaskDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-no-skill-source-"));
  const targetTaskDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-no-skill-target-"));
  try {
    await ensureDir(path.join(sourceTaskDir, "environment"));
    await writeText(
      path.join(sourceTaskDir, "environment", "Dockerfile"),
      "FROM ubuntu:24.04\nCOPY skills /root/.codex/skills\nRUN echo ok\n",
    );
    const prepared = await prepareNoSkillVariant({
      sourceTaskDir,
      targetTaskDir,
    });
    const dockerfile = await readText(path.join(prepared.targetTaskDir, "environment", "Dockerfile"));
    assert.equal(prepared.removedCopyLines, 1);
    assert.ok(!dockerfile.includes("COPY skills /root/.codex/skills"));
  } finally {
    await fs.rm(sourceTaskDir, { recursive: true, force: true });
    await fs.rm(targetTaskDir, { recursive: true, force: true });
  }
}

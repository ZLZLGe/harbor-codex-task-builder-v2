import assert from "node:assert/strict";
import {
  buildBlockingReviewerPrompt,
  buildFamilyPlannerPrompt,
  buildRepairPrompt,
  buildTaskBuilderBrief,
  buildTaskWriterPrompt,
} from "../src/prompts.js";
import type { DerivedTaskPlan, FamilyPlan } from "../src/schema.js";
import { buildGenerationUnits, type GenerationUnit, type SkillInfo, type TaskTemplate } from "../src/discovery.js";

const debugSkill: SkillInfo = {
  name: "Node Connect",
  dirName: "01__node-connect",
  relativeDir: "01__node-connect",
  sourceDir: "/tmp/skills/01__node-connect",
  skillMdPath: "/tmp/skills/01__node-connect/SKILL.md",
};

const sessionSkill: SkillInfo = {
  name: "Session Logs",
  dirName: "03__session-logs",
  relativeDir: "03__session-logs",
  sourceDir: "/tmp/skills/03__session-logs",
  skillMdPath: "/tmp/skills/03__session-logs/SKILL.md",
};

const template: TaskTemplate = {
  templateId: "tools__debugging",
  templateRelativePath: "tools/debugging",
  sourceDir: "/tmp/template/tools/debugging",
  taskTomlPath: "/tmp/template/tools/debugging/task.toml",
  instructionPath: "/tmp/template/tools/debugging/instruction.md",
  environmentDir: "/tmp/template/tools/debugging/environment",
  solutionDir: "/tmp/template/tools/debugging/solution",
  testsDir: "/tmp/template/tools/debugging/tests",
  templateSkillsDir: "/tmp/template/tools/debugging/environment/skills",
  metadata: {
    id: "debugging-template",
    name: "Debugging Template",
    difficulty: "hard",
    category: "debugging",
    tags: ["debugging", "node"],
  },
  referenceSkills: [debugSkill],
};

const unit: GenerationUnit = {
  template,
  inputSkills: [debugSkill],
  skillMode: "per-skill",
  targetSkill: debugSkill,
  scopeSlug: "01__node-connect",
  scopeLabel: "Node Connect",
  similarCount: 2,
  transferCount: 3,
  pendingSimilarOrdinals: [1, 2],
  pendingTransferOrdinals: [1, 2, 3],
  finalFamilyDir: "/tmp/output/final/tools__debugging/01__node-connect",
  publishedTasks: [],
};

const historyAwareUnit: GenerationUnit = {
  ...unit,
  pendingSimilarOrdinals: [2],
  publishedTasks: [
    {
      derivedTaskId: "similar1",
      taskRole: "similar",
      roleOrdinal: 1,
      taskDir: "/tmp/output/final/tools__debugging/01__node-connect/similar1",
      planPath: "/tmp/output/final/tools__debugging/01__node-connect/similar1/plan.json",
      instructionPath: "/tmp/output/final/tools__debugging/01__node-connect/similar1/instruction.md",
      taskTomlPath: "/tmp/output/final/tools__debugging/01__node-connect/similar1/task.toml",
      testOutputsPath: "/tmp/output/final/tools__debugging/01__node-connect/similar1/tests/test_outputs.py",
      environmentDir: "/tmp/output/final/tools__debugging/01__node-connect/similar1/environment",
    },
  ],
};

const plan: DerivedTaskPlan = {
  derivedTaskId: "similar1",
  taskRole: "similar",
  roleOrdinal: 1,
  title: "Debugging Similar 1",
  goal: "Repair the failing dashboard service.",
  primaryOutputFile: "incident-summary.json",
  difficulty: "hard",
  category: "debugging",
  skillBenefitRationale: "Requires the injected debugging workflow.",
  templateId: template.templateId,
  skillMode: "per-skill",
  targetSkillDirName: debugSkill.dirName,
  targetSkillName: debugSkill.name,
};

const familyPlan: FamilyPlan = {
  templateId: template.templateId,
  skillMode: "per-skill",
  targetSkillDirName: debugSkill.dirName,
  targetSkillName: debugSkill.name,
  familyTheme: "Debugging production regressions",
  similarTasks: [
    {
      title: plan.title,
      goal: plan.goal,
      primaryOutputFile: plan.primaryOutputFile,
      difficulty: plan.difficulty,
      category: plan.category,
      skillBenefitRationale: plan.skillBenefitRationale,
    },
    {
      title: "Debugging Similar 2",
      goal: "Repair a second failing dashboard scenario.",
      primaryOutputFile: "dashboard-summary.json",
      difficulty: "hard",
      category: "debugging",
      skillBenefitRationale: "Uses the same debugging workflow in a nearby scenario.",
    },
  ],
  transferTasks: [
    {
      title: "CLI Transfer 1",
      goal: "Repair a CLI startup failure.",
      primaryOutputFile: "cli-summary.json",
      difficulty: "hard",
      category: "debugging",
      skillBenefitRationale: "Moves the debugging workflow into CLI startup traces.",
    },
    {
      title: "Worker Transfer 2",
      goal: "Repair a worker timeout failure.",
      primaryOutputFile: "worker-summary.json",
      difficulty: "hard",
      category: "debugging",
      skillBenefitRationale: "Moves the debugging workflow into async worker diagnostics.",
    },
    {
      title: "Queue Transfer 3",
      goal: "Repair a queue processing regression.",
      primaryOutputFile: "queue-summary.json",
      difficulty: "hard",
      category: "debugging",
      skillBenefitRationale: "Moves the debugging workflow into queue failure triage.",
    },
  ],
};

const brief = buildTaskBuilderBrief(unit);
const plannerPrompt = buildFamilyPlannerPrompt(unit);
const writerPrompt = buildTaskWriterPrompt(unit, plan);
const blockingReviewerPrompt = buildBlockingReviewerPrompt(unit, familyPlan, plan);
const historyPlannerPrompt = buildFamilyPlannerPrompt(historyAwareUnit);
const historyWriterPrompt = buildTaskWriterPrompt(historyAwareUnit, plan);
const historyBlockingReviewerPrompt = buildBlockingReviewerPrompt(historyAwareUnit, familyPlan, plan);
const repairPrompt = buildRepairPrompt({
  unit,
  plan,
  blockingIssues: ["reviewer:similar1 instruction.md leaked the skill name"],
  staticIssues: ["static:similar1 task.toml metadata.source_template_id is wrong"],
  runtimeIssues: ["runtime:similar1 harbor verifier reward=0 < 1.0"],
  skillEffectIssues: ["skill-effect:similar1 with_skill pass / no_skill pass"],
});

const allModeUnit = buildGenerationUnits(template, [debugSkill, sessionSkill], {
  skillMode: "all",
  similarCount: 1,
  transferCount: 1,
})[0];
const allModeBrief = buildTaskBuilderBrief(allModeUnit!);
const allModePlannerPrompt = buildFamilyPlannerPrompt(allModeUnit!);

assert.equal(allModeUnit?.scopeSlug, "all-skills");

assert.match(brief, /模板目录: template_source\//);
assert.match(brief, /输入 skills 目录: input_skills\//);
assert.match(brief, /drafts\/<task_name>\/environment\/skills\/ 由系统从 input_skills\/ 预注入/);
assert.match(brief, /这些 injected skills 是只读 payload/);
assert.match(brief, /template_source\/environment\/skills\/ 里的内容只作为模板上下文参考/);
assert.match(brief, /最终 shipped skills 只由 input_skills\/ 决定/);
assert.doesNotMatch(brief, /builder_refs\/harbor/);
assert.match(brief, /只需要检查 final-root 下已经发布的 sibling tasks/);

assert.match(plannerPrompt, /完整检查 template_source\/ 和 input_skills\//);
assert.doesNotMatch(plannerPrompt, /builder_refs\/harbor/);
assert.match(plannerPrompt, /templateId: tools__debugging/);
assert.match(plannerPrompt, /完整检查当前目标输入 shipped skill 的目录/);
assert.match(plannerPrompt, /input_skills\/ 才是最终 shipped skill 来源/);
assert.match(historyPlannerPrompt, /已发布 Harbor family 目录/);

assert.match(writerPrompt, /template_source\/、input_skills\/、当前 task 的 plan\.json blueprint/);
assert.doesNotMatch(writerPrompt, /builder_refs\/harbor/);
assert.match(writerPrompt, /metadata\.source_template_id 必须等于 "tools__debugging"/);
assert.match(writerPrompt, /environment\/skills\/ 中只能保留一个 shipped skill/);
assert.match(writerPrompt, /这些 injected skills 是只读 payload/);
assert.match(writerPrompt, /不是当前任务必须参考的去重对象/);
assert.match(writerPrompt, /只以 final-root 下已经发布的同 family 任务为准/);
assert.match(writerPrompt, /不得把 skills 复制到普通运行时路径/);
assert.match(writerPrompt, /唯一允许语句是 COPY skills \/root\/\.codex\/skills/);
assert.match(writerPrompt, /不要再添加任何把 skills\/ 或 \/root\/\.codex\/skills 复制、移动、同步、软链接到其他目录/);
assert.match(historyWriterPrompt, /已发布 Harbor family 目录/);

assert.match(blockingReviewerPrompt, /单题 blocking 审查/);
assert.match(blockingReviewerPrompt, /writer 不应改写 injected skill payload/);
assert.match(blockingReviewerPrompt, /taskResults 中只返回当前这个任务/);
assert.match(blockingReviewerPrompt, /已发布 sibling \/ 历史任务/);
assert.doesNotMatch(blockingReviewerPrompt, /builder_refs\/harbor/);
assert.match(historyBlockingReviewerPrompt, /已发布 Harbor family 目录/);

assert.match(repairPrompt, /不要修改 template_source\/、input_skills\/、artifacts\//);
assert.doesNotMatch(repairPrompt, /builder_refs\//);
assert.match(repairPrompt, /不要修改 environment\/skills\/ 下 injected skill 的内容/);
assert.match(repairPrompt, /metadata\.source_template_id/);
assert.match(repairPrompt, /blocking reviewer:/);
assert.match(repairPrompt, /唯一允许语句是 COPY skills \/root\/\.codex\/skills/);
assert.doesNotMatch(repairPrompt, /family:/);

assert.match(allModeBrief, /当前 family 需要保留全部输入 skills 的关键能力点和实际解题收益/);
assert.match(allModePlannerPrompt, /完整检查当前全部输入 shipped skills 的目录/);

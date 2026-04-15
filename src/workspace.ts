import path from "node:path";
import type { GenerationUnit, SkillInfo } from "./discovery.js";
import type { DerivedTaskPlan } from "./schema.js";
import { buildTaskBuilderBrief, relativeDraftPath } from "./prompts.js";
import {
  buildRawRoot,
  copyDir,
  DEFAULT_OUTPUT_ROOT,
  ensureDir,
  makeRunId,
  writeJson,
  writeText,
} from "./utils.js";

export type FamilyWorkspace = {
  runId: string;
  templateId: string;
  templateRelativePath: string;
  skillMode: "all" | "per-skill";
  inputSkills: SkillInfo[];
  targetSkill: SkillInfo | null;
  scopeSlug: string;
  rootDir: string;
  templateSourceDir: string;
  inputSkillsDir: string;
  draftsDir: string;
  artifactsDir: string;
  briefPath: string;
};

async function copyInputSkills(skills: SkillInfo[], targetDir: string): Promise<void> {
  await ensureDir(targetDir);
  for (const skill of skills) {
    await copyDir(skill.sourceDir, path.join(targetDir, skill.dirName));
  }
}

export async function createFamilyWorkspace(
  unit: GenerationUnit,
  options: {
    rawRoot?: string;
    runId?: string;
  } = {},
): Promise<FamilyWorkspace> {
  const template = unit.template;
  const runId = options.runId ?? makeRunId(`${template.templateId}-${unit.scopeSlug}`);
  const rawRoot = options.rawRoot ?? buildRawRoot(DEFAULT_OUTPUT_ROOT);
  const rootDir = path.join(rawRoot, runId, template.templateId, unit.scopeSlug);
  const templateSourceDir = path.join(rootDir, "template_source");
  const inputSkillsDir = path.join(rootDir, "input_skills");
  const draftsDir = path.join(rootDir, "drafts");
  const artifactsDir = path.join(rootDir, "artifacts");
  const briefPath = path.join(rootDir, "TASK_BUILDER_BRIEF.md");

  await ensureDir(rootDir);
  await ensureDir(draftsDir);
  await ensureDir(artifactsDir);
  await copyDir(template.sourceDir, templateSourceDir);
  await copyInputSkills(unit.inputSkills, inputSkillsDir);
  await writeText(briefPath, `${buildTaskBuilderBrief(unit)}\n`);
  await writeJson(path.join(artifactsDir, "generation-unit.json"), unit);

  return {
    runId,
    templateId: template.templateId,
    templateRelativePath: template.templateRelativePath,
    skillMode: unit.skillMode,
    inputSkills: unit.inputSkills,
    targetSkill: unit.targetSkill,
    scopeSlug: unit.scopeSlug,
    rootDir,
    templateSourceDir,
    inputSkillsDir,
    draftsDir,
    artifactsDir,
    briefPath,
  };
}

export async function prepareDraftSkeleton(
  workspace: FamilyWorkspace,
  plan: DerivedTaskPlan,
): Promise<string> {
  const draftDir = path.join(workspace.rootDir, relativeDraftPath(plan.derivedTaskId));
  await ensureDir(path.join(draftDir, "environment"));
  await ensureDir(path.join(draftDir, "solution"));
  await ensureDir(path.join(draftDir, "tests"));
  await copyDir(workspace.inputSkillsDir, path.join(draftDir, "environment", "skills"));
  await writeJson(path.join(draftDir, "plan.json"), plan);
  return draftDir;
}

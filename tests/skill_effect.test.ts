import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSkillEffectBucket,
  buildSkillEffectIssues,
  isAcceptedSkillEffectBucket,
  type AgentRunEvidence,
  type AgentRunResult,
  type SkillEffectEvaluationResult,
} from "../src/skill_effect.js";
import { writeSkillEffectResultArtifact } from "../src/skill_effect_artifacts.js";
import { pathExists, readText } from "../src/utils.js";

function makeRunResult(
  variant: "with_skill" | "no_skill",
  comparisonStatus: AgentRunResult["comparisonStatus"],
  comparisonReason: string,
): AgentRunResult {
  return {
    variant,
    passed: comparisonStatus === "pass",
    comparisonStatus,
    comparisonReason,
    issues: comparisonStatus === "pass" ? [] : [`${variant}:${comparisonReason}`],
    failureKind: comparisonStatus === "valid_reward_fail" ? "harbor-reward" : comparisonStatus === "invalid_fail" ? "harbor-task" : undefined,
    evidence: {
      variant,
      variantTaskDir: `/tmp/${variant}`,
      logsDir: `/tmp/${variant}/logs`,
      runtimeLogRoot: `/tmp/${variant}/logs`,
      logFilePath: `/tmp/${variant}/logs/harbor-run.log`,
      jobDir: `/tmp/${variant}/logs/job`,
      command: ["harbor", "run"],
      reward: comparisonStatus === "pass" ? 1 : 0,
      summary: comparisonReason,
    },
  };
}

function makeEvaluation(
  withSkillStatus: AgentRunResult["comparisonStatus"],
  noSkillStatus: AgentRunResult["comparisonStatus"],
): SkillEffectEvaluationResult {
  const withSkill = makeRunResult("with_skill", withSkillStatus, `with:${withSkillStatus}`);
  const noSkill = makeRunResult("no_skill", noSkillStatus, `no:${noSkillStatus}`);
  const bucket = buildSkillEffectBucket(withSkill.comparisonStatus, noSkill.comparisonStatus);
  return {
    bucket,
    repairRequired: !isAcceptedSkillEffectBucket(bucket),
    pairRoot: "/tmp/pair",
    withSkill,
    noSkill,
  };
}

{
  const evaluation = makeEvaluation("pass", "valid_reward_fail");
  assert.equal(evaluation.bucket, "with_skill_pass__no_skill_fail");
  assert.equal(evaluation.repairRequired, false);
  assert.deepEqual(buildSkillEffectIssues("similar1", evaluation), []);
}

{
  const evaluation = makeEvaluation("pass", "invalid_fail");
  assert.equal(evaluation.bucket, "with_skill_pass__no_skill_invalid_fail");
  assert.equal(evaluation.repairRequired, true);
  const issues = buildSkillEffectIssues("similar1", evaluation);
  assert.ok(issues.some((issue) => issue.message.includes("no_skill invalid fail")));
}

{
  const evaluation = makeEvaluation("pass", "pass");
  assert.equal(evaluation.bucket, "with_skill_pass__no_skill_pass");
  assert.equal(evaluation.repairRequired, true);
}

{
  const evaluation = makeEvaluation("invalid_fail", "valid_reward_fail");
  assert.equal(evaluation.bucket, "with_skill_fail__no_skill_fail");
  assert.equal(evaluation.repairRequired, true);
}

{
  const evaluation = makeEvaluation("invalid_fail", "pass");
  assert.equal(evaluation.bucket, "with_skill_fail__no_skill_pass");
  assert.equal(evaluation.repairRequired, true);
}

{
  const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-effect-artifacts-"));
  const evaluation = makeEvaluation("pass", "valid_reward_fail");
  const withSkillMetrics: NonNullable<AgentRunEvidence["metrics"]> = {
    totalDurationSec: 120,
    environmentSetupSec: 10,
    agentSetupSec: 5,
    agentExecutionSec: 90,
    verifierSec: 15,
    totalTokens: 1234,
  };
  const noSkillMetrics: NonNullable<AgentRunEvidence["metrics"]> = {
    totalDurationSec: 80,
    environmentSetupSec: 8,
    agentSetupSec: 4,
    agentExecutionSec: 60,
    verifierSec: 8,
    totalTokens: 567,
  };
  evaluation.withSkill.evidence.metrics = withSkillMetrics;
  evaluation.noSkill.evidence.metrics = noSkillMetrics;
  const resultPath = await writeSkillEffectResultArtifact({
    artifactsDir,
    derivedTaskId: "similar1",
    cycle: 3,
    attemptIndex: 2,
    result: evaluation,
  });

  assert.equal(
    resultPath,
    path.join(artifactsDir, "similar1.skill-effect.cycle-3.attempt-2.json"),
  );
  assert.equal(await pathExists(resultPath), true);
  assert.equal(
    await pathExists(path.join(artifactsDir, "similar1.skill-effect.cycle-3.json")),
    false,
  );
  const saved = JSON.parse(await readText(resultPath)) as SkillEffectEvaluationResult;
  assert.deepEqual(saved.withSkill.evidence.metrics, withSkillMetrics);
  assert.deepEqual(saved.noSkill.evidence.metrics, noSkillMetrics);
  assert.deepEqual(
    saved,
    JSON.parse(JSON.stringify(evaluation)) as SkillEffectEvaluationResult,
  );
}

import assert from "node:assert/strict";
import {
  buildSkillEffectBucket,
  buildSkillEffectIssues,
  isAcceptedSkillEffectBucket,
  type AgentRunResult,
  type SkillEffectEvaluationResult,
} from "../src/skill_effect.js";

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

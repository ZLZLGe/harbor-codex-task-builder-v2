import assert from "node:assert/strict";
import { CodexTaskBuilderClient } from "../src/codex.js";
import type { FamilyPlan } from "../src/schema.js";
import { parseNonNegativeInteger } from "../src/utils.js";

type FakeThreadBehavior = {
  threadId?: string | null;
  finalResponse?: string;
  error?: Error;
};

function buildFakeCodex(args: {
  startBehaviors?: FakeThreadBehavior[];
  resumeBehaviors?: FakeThreadBehavior[];
}): {
  codex: {
    startThread: (_options?: unknown) => { id: string | null; run: () => Promise<{ items: unknown[]; finalResponse: string; usage: null }> };
    resumeThread: (
      threadId: string,
      _options?: unknown,
    ) => { id: string | null; run: () => Promise<{ items: unknown[]; finalResponse: string; usage: null }> };
  };
  startCallCount: () => number;
  resumeThreadIds: () => string[];
} {
  const startBehaviors = [...(args.startBehaviors ?? [])];
  const resumeBehaviors = [...(args.resumeBehaviors ?? [])];
  let startCalls = 0;
  const resumeIds: string[] = [];

  function buildThread(behavior: FakeThreadBehavior | undefined, fallbackThreadId: string | null) {
    assert.ok(behavior, "缺少 fake thread behavior");
    return {
      id: behavior.threadId ?? fallbackThreadId,
      async run() {
        if (behavior.error) {
          throw behavior.error;
        }
        return {
          items: [],
          finalResponse: behavior.finalResponse ?? "",
          usage: null,
        };
      },
    };
  }

  return {
    codex: {
      startThread() {
        startCalls += 1;
        return buildThread(startBehaviors.shift(), `start-thread-${startCalls}`);
      },
      resumeThread(threadId: string) {
        resumeIds.push(threadId);
        return buildThread(resumeBehaviors.shift(), threadId);
      },
    },
    startCallCount: () => startCalls,
    resumeThreadIds: () => [...resumeIds],
  };
}

const familyPlan: FamilyPlan = {
  templateId: "tools__debugging",
  skillMode: "per-skill",
  targetSkillDirName: "01__node-connect",
  targetSkillName: "node-connect",
  familyTheme: "Debugging family",
  similarTasks: [
    {
      title: "Investigate connection failures",
      goal: "Fix the connection issue",
      primaryOutputFile: "report.txt",
      difficulty: "medium",
      category: "debugging",
      skillBenefitRationale: "The skill helps narrow the root cause quickly",
    },
  ],
  transferTasks: [],
};

const unit = {
  template: {
    templateId: "tools__debugging",
    templateRelativePath: "tools/debugging",
    metadata: {
      difficulty: "hard",
      category: "debugging",
      tags: ["network"],
    },
  },
  inputSkills: [
    {
      name: "node-connect",
      dirName: "01__node-connect",
    },
  ],
  skillMode: "per-skill",
  targetSkill: {
    name: "node-connect",
    dirName: "01__node-connect",
  },
  scopeSlug: "01__node-connect",
  similarCount: 1,
  transferCount: 0,
  pendingSimilarOrdinals: [1],
  pendingTransferOrdinals: [],
  finalFamilyDir: "/tmp/final/tools__debugging/01__node-connect",
  publishedTasks: [],
} as const;

const workspace = {
  rootDir: "/tmp/codex-task-builder-workspace",
} as const;

const plan = {
  derivedTaskId: "similar1",
  taskRole: "similar",
  roleOrdinal: 1,
  title: "Investigate connection failures",
  goal: "Fix the connection issue",
  primaryOutputFile: "report.txt",
  difficulty: "medium",
  category: "debugging",
  skillBenefitRationale: "The skill helps narrow the root cause quickly",
  templateId: "tools__debugging",
  skillMode: "per-skill",
  targetSkillDirName: "01__node-connect",
  targetSkillName: "node-connect",
} as const;

const originalWarn = console.warn;
console.warn = () => {};

try {
  assert.equal(parseNonNegativeInteger(undefined, "--codex-run-retries", 3), 3);
  assert.equal(parseNonNegativeInteger("0", "--codex-run-retries", 3), 0);
  assert.equal(parseNonNegativeInteger("3", "--codex-run-retries", 3), 3);
  assert.throws(
    () => parseNonNegativeInteger("-1", "--codex-run-retries", 3),
    /--codex-run-retries 必须是 >= 0 的整数/,
  );
  assert.throws(
    () => parseNonNegativeInteger("1.5", "--codex-run-retries", 3),
    /--codex-run-retries 必须是 >= 0 的整数/,
  );

  {
    const fakeCodex = buildFakeCodex({
      startBehaviors: [{ error: new Error("plan failure") }],
    });
    const sleeps: number[] = [];
    const client = new CodexTaskBuilderClient({
      codexRunRetries: 0,
      codex: fakeCodex.codex,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await assert.rejects(() => client.planFamily(unit as never, workspace as never), /plan failure/);
    assert.equal(fakeCodex.startCallCount(), 1);
    assert.deepEqual(sleeps, []);
  }

  {
    const fakeCodex = buildFakeCodex({
      startBehaviors: [
        { error: new Error("plan failure 1") },
        { error: new Error("plan failure 2") },
        { error: new Error("plan failure 3") },
        {
          threadId: "plan-thread-4",
          finalResponse: JSON.stringify(familyPlan),
        },
      ],
    });
    const sleeps: number[] = [];
    const client = new CodexTaskBuilderClient({
      codexRunRetries: 3,
      codex: fakeCodex.codex,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.planFamily(unit as never, workspace as never);
    assert.equal(result.threadId, "plan-thread-4");
    assert.equal(result.data.familyTheme, familyPlan.familyTheme);
    assert.equal(fakeCodex.startCallCount(), 4);
    assert.deepEqual(sleeps, [2_000, 4_000, 8_000]);
  }

  {
    const fakeCodex = buildFakeCodex({
      startBehaviors: [
        { error: new Error("write failure 1") },
        { error: new Error("write failure 2") },
        { error: new Error("write failure 3") },
        { error: new Error("write failure 4") },
      ],
    });
    const sleeps: number[] = [];
    const client = new CodexTaskBuilderClient({
      codexRunRetries: 3,
      codex: fakeCodex.codex,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await assert.rejects(() => client.writeTask(unit as never, workspace as never, plan as never), /write failure 4/);
    assert.equal(fakeCodex.startCallCount(), 4);
    assert.deepEqual(sleeps, [2_000, 4_000, 8_000]);
  }

  {
    const fakeCodex = buildFakeCodex({
      startBehaviors: [
        { error: new Error("review failure") },
        {
          threadId: "review-thread-2",
          finalResponse: JSON.stringify({
            taskResults: [
              {
                derivedTaskId: "similar1",
                blockingPass: true,
                blockingIssues: [],
              },
            ],
          }),
        },
      ],
    });
    const sleeps: number[] = [];
    const client = new CodexTaskBuilderClient({
      codexRunRetries: 3,
      codex: fakeCodex.codex,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.reviewTaskBlocking(unit as never, workspace as never, familyPlan, plan as never);
    assert.equal(result.threadId, "review-thread-2");
    assert.equal(result.data.taskResults[0]?.blockingPass, true);
    assert.equal(fakeCodex.startCallCount(), 2);
    assert.deepEqual(sleeps, [2_000]);
  }

  {
    const fakeCodex = buildFakeCodex({
      resumeBehaviors: [
        { error: new Error("repair failure") },
        {
          threadId: "persisted-thread",
          finalResponse: JSON.stringify({
            summary: "Fixed the draft",
            repairReason: "Retry succeeded",
            changedFiles: ["instruction.md"],
          }),
        },
      ],
    });
    const sleeps: number[] = [];
    const client = new CodexTaskBuilderClient({
      codexRunRetries: 3,
      codex: fakeCodex.codex,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.repairTask({
      unit: unit as never,
      workspace: workspace as never,
      plan: plan as never,
      blockingIssues: [],
      staticIssues: [],
      runtimeIssues: [],
      skillEffectIssues: [],
      threadId: "persisted-thread",
    });
    assert.equal(result.threadId, "persisted-thread");
    assert.equal(result.data.changedFiles[0], "instruction.md");
    assert.deepEqual(fakeCodex.resumeThreadIds(), ["persisted-thread", "persisted-thread"]);
    assert.equal(fakeCodex.startCallCount(), 0);
    assert.deepEqual(sleeps, [2_000]);
  }
} finally {
  console.warn = originalWarn;
}

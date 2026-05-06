import { promises as fs } from "node:fs";
import path from "node:path";
import type { GenerationUnit, PublishedTaskInfo } from "./discovery.js";
import { parseCanonicalTaskName, pathExists } from "./utils.js";

export type PublishedFamilyState = {
  finalFamilyDir: string;
  publishedTasks: PublishedTaskInfo[];
  pendingTaskOrdinals: number[];
};

function buildOrdinalRange(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => index + 1);
}

function parsePublishedVariantDirName(value: string): { derivedTaskId: string; taskOrdinal: number } | null {
  const match = /^(task[1-9]\d*)__with_skill$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const derivedTaskId = match[1]!;
  const parsed = parseCanonicalTaskName(derivedTaskId);
  if (!parsed) {
    return null;
  }

  return {
    derivedTaskId,
    taskOrdinal: parsed.taskOrdinal,
  };
}

export async function inspectPublishedFamily(
  unit: Pick<GenerationUnit, "template" | "scopeSlug" | "taskCount">,
  finalRoot: string,
): Promise<PublishedFamilyState> {
  const finalFamilyDir = path.join(finalRoot, unit.template.templateId, unit.scopeSlug);
  const publishedTasks: PublishedTaskInfo[] = [];
  const existingTaskOrdinals = new Set<number>();

  if (await pathExists(finalFamilyDir)) {
    const entries = await fs.readdir(finalFamilyDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const parsed = parsePublishedVariantDirName(entry.name);
      if (!parsed) {
        continue;
      }

      const taskDir = path.join(finalFamilyDir, entry.name);
      const taskInfo: PublishedTaskInfo = {
        derivedTaskId: parsed.derivedTaskId,
        taskOrdinal: parsed.taskOrdinal,
        taskDir,
        planPath: path.join(taskDir, "plan.json"),
        instructionPath: path.join(taskDir, "instruction.md"),
        taskTomlPath: path.join(taskDir, "task.toml"),
        testOutputsPath: path.join(taskDir, "tests", "test_outputs.py"),
        environmentDir: path.join(taskDir, "environment"),
      };
      publishedTasks.push(taskInfo);
      existingTaskOrdinals.add(parsed.taskOrdinal);
    }
  }

  publishedTasks.sort((left, right) => left.taskOrdinal - right.taskOrdinal);

  return {
    finalFamilyDir,
    publishedTasks,
    pendingTaskOrdinals: buildOrdinalRange(unit.taskCount).filter((ordinal) => !existingTaskOrdinals.has(ordinal)),
  };
}

export function applyPublishedFamilyState(unit: GenerationUnit, state: PublishedFamilyState): GenerationUnit {
  return {
    ...unit,
    finalFamilyDir: state.finalFamilyDir,
    publishedTasks: state.publishedTasks,
    pendingTaskOrdinals: state.pendingTaskOrdinals,
  };
}

export function hasPendingTasks(unit: Pick<GenerationUnit, "pendingTaskOrdinals">): boolean {
  return unit.pendingTaskOrdinals.length > 0;
}

export function selectExecutableUnits<T extends Pick<GenerationUnit, "pendingTaskOrdinals">>(
  units: T[],
  limit = 0,
): {
  executableUnits: T[];
  skippedCount: number;
} {
  const executableCandidates = units.filter((unit) => hasPendingTasks(unit));
  const executableUnits = limit > 0 ? executableCandidates.slice(0, limit) : executableCandidates;
  return {
    executableUnits,
    skippedCount: units.length - executableUnits.length,
  };
}

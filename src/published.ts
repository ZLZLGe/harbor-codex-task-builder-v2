import { promises as fs } from "node:fs";
import path from "node:path";
import type { GenerationUnit, PublishedTaskInfo } from "./discovery.js";
import { parseCanonicalTaskName, pathExists } from "./utils.js";

export type PublishedFamilyState = {
  finalFamilyDir: string;
  publishedTasks: PublishedTaskInfo[];
  pendingSimilarOrdinals: number[];
  pendingTransferOrdinals: number[];
};

function buildOrdinalRange(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => index + 1);
}

function comparePublishedTasks(left: PublishedTaskInfo, right: PublishedTaskInfo): number {
  if (left.taskRole !== right.taskRole) {
    return left.taskRole === "similar" ? -1 : 1;
  }
  return left.roleOrdinal - right.roleOrdinal;
}

export async function inspectPublishedFamily(
  unit: Pick<GenerationUnit, "template" | "scopeSlug" | "similarCount" | "transferCount">,
  finalRoot: string,
): Promise<PublishedFamilyState> {
  const finalFamilyDir = path.join(finalRoot, unit.template.templateId, unit.scopeSlug);
  const publishedTasks: PublishedTaskInfo[] = [];
  const existingSimilarOrdinals = new Set<number>();
  const existingTransferOrdinals = new Set<number>();

  if (await pathExists(finalFamilyDir)) {
    const entries = await fs.readdir(finalFamilyDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const parsed = parseCanonicalTaskName(entry.name);
      if (!parsed) {
        continue;
      }

      const taskDir = path.join(finalFamilyDir, entry.name);
      const taskInfo: PublishedTaskInfo = {
        derivedTaskId: entry.name,
        taskRole: parsed.taskRole,
        roleOrdinal: parsed.roleOrdinal,
        taskDir,
        planPath: path.join(taskDir, "plan.json"),
        instructionPath: path.join(taskDir, "instruction.md"),
        taskTomlPath: path.join(taskDir, "task.toml"),
        testOutputsPath: path.join(taskDir, "tests", "test_outputs.py"),
        environmentDir: path.join(taskDir, "environment"),
      };
      publishedTasks.push(taskInfo);
      if (parsed.taskRole === "similar") {
        existingSimilarOrdinals.add(parsed.roleOrdinal);
      } else {
        existingTransferOrdinals.add(parsed.roleOrdinal);
      }
    }
  }

  publishedTasks.sort(comparePublishedTasks);

  return {
    finalFamilyDir,
    publishedTasks,
    pendingSimilarOrdinals: buildOrdinalRange(unit.similarCount).filter((ordinal) => !existingSimilarOrdinals.has(ordinal)),
    pendingTransferOrdinals: buildOrdinalRange(unit.transferCount).filter(
      (ordinal) => !existingTransferOrdinals.has(ordinal),
    ),
  };
}

export function applyPublishedFamilyState(unit: GenerationUnit, state: PublishedFamilyState): GenerationUnit {
  return {
    ...unit,
    finalFamilyDir: state.finalFamilyDir,
    publishedTasks: state.publishedTasks,
    pendingSimilarOrdinals: state.pendingSimilarOrdinals,
    pendingTransferOrdinals: state.pendingTransferOrdinals,
  };
}

export function hasPendingTasks(
  unit: Pick<GenerationUnit, "pendingSimilarOrdinals" | "pendingTransferOrdinals">,
): boolean {
  return unit.pendingSimilarOrdinals.length + unit.pendingTransferOrdinals.length > 0;
}

export function selectExecutableUnits<T extends Pick<GenerationUnit, "pendingSimilarOrdinals" | "pendingTransferOrdinals">>(
  units: T[],
  limit = 0,
): {
  executableUnits: T[];
  skippedCount: number;
} {
  const executableUnits = units.filter((unit) => hasPendingTasks(unit));
  return {
    executableUnits: limit > 0 ? executableUnits.slice(0, limit) : executableUnits,
    skippedCount: units.length - executableUnits.length,
  };
}

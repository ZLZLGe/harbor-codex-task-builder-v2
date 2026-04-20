import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export const REPO_ROOT = "/Users/leviviya/Documents/Harbor";
export const TEMPLATE_ROOT = path.join(REPO_ROOT, "template");
export const DEFAULT_OUTPUT_ROOT = path.join(REPO_ROOT, "codex_task_builder_v2_runs");

export function buildRawRoot(outputRoot: string): string {
  return path.join(outputRoot, "raw");
}

export function buildFinalRoot(outputRoot: string): string {
  return path.join(outputRoot, "final");
}

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type StreamingCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function appendWithLimit(current: string, next: string, maxChars: number): string {
  const joined = current + next;
  return joined.length <= maxChars ? joined : joined.slice(-maxChars);
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf-8");
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function copyDir(source: string, target: string): Promise<void> {
  await ensureDir(path.dirname(target));
  await fs.cp(source, target, { recursive: true, force: true });
}

export async function copyFile(source: string, target: string): Promise<void> {
  await ensureDir(path.dirname(target));
  await fs.copyFile(source, target);
}

export async function removePath(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}

export function makeRunId(sourceTaskId: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${slugify(sourceTaskId)}-${suffix}`;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function dedent(text: string): string {
  const lines = text.replace(/^\n/, "").split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^ */)?.[0].length ?? 0);
  const trim = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(trim)).join("\n").trimEnd();
}

export function parseJsonWithFallback<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      return JSON.parse(fenced[1]) as T;
    }
    throw new Error(`无法解析结构化输出: ${raw}`);
  }
}

export function parseNonNegativeInteger(value: string | undefined, optionLabel: string, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionLabel} 必须是 >= 0 的整数`);
  }
  return parsed;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

export async function runStreamingCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    logFilePath?: string;
    outputBufferLimitChars?: number;
    heartbeatIntervalMs?: number;
    onHeartbeat?: (() => void | Promise<void>) | null;
    onStdout?: ((chunk: string) => void | Promise<void>) | null;
    onStderr?: ((chunk: string) => void | Promise<void>) | null;
  } = {},
): Promise<StreamingCommandResult> {
  const outputBufferLimitChars = options.outputBufferLimitChars ?? 200_000;
  if (options.logFilePath) {
    await writeText(options.logFilePath, "");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const heartbeatTimer =
      options.heartbeatIntervalMs && options.onHeartbeat
        ? setInterval(() => {
            void Promise.resolve(options.onHeartbeat?.());
          }, options.heartbeatIntervalMs)
        : null;

    const handleChunk = (channel: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = chunk.toString();
      if (channel === "stdout") {
        stdout = appendWithLimit(stdout, text, outputBufferLimitChars);
        void Promise.resolve(options.onStdout?.(text));
      } else {
        stderr = appendWithLimit(stderr, text, outputBufferLimitChars);
        void Promise.resolve(options.onStderr?.(text));
      }
      if (options.logFilePath) {
        void fs.appendFile(options.logFilePath, text, "utf-8");
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => handleChunk("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => handleChunk("stderr", chunk));
    child.on("error", (error) => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

export async function listDirectories(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function formatIssueList(issues: string[]): string {
  return issues.map((issue) => `- ${issue}`).join("\n");
}

export function isSubPath(parentPath: string, targetPath: string): boolean {
  const relative = path.relative(parentPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertPathWithinRoots(targetPath: string, roots: string[], label: string): void {
  if (roots.some((root) => isSubPath(root, targetPath))) {
    return;
  }
  throw new Error(`${label} 不在受管路径内: ${targetPath}`);
}

export function canonicalTaskName(taskRole: "similar" | "transfer", roleOrdinal: number): string {
  return `${taskRole}${roleOrdinal}`;
}

export function parseCanonicalTaskName(
  value: string,
): { taskRole: "similar" | "transfer"; roleOrdinal: number } | null {
  const match = /^(similar|transfer)([1-9]\d*)$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const roleOrdinal = Number(match[2]);
  if (!Number.isInteger(roleOrdinal) || roleOrdinal <= 0) {
    return null;
  }

  return {
    taskRole: match[1] as "similar" | "transfer",
    roleOrdinal,
  };
}

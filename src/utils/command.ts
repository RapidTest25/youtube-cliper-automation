// ============================================================
// Shell command execution wrapper
// ============================================================

import { spawn } from "node:child_process";
import { logger } from "./logger.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run an external command and capture its output.
 */
export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; silent?: boolean },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    logger.debug(`$ ${command} ${args.join(" ")}`);

    const proc = spawn(command, args, {
      cwd: options?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      if (!options?.silent) logger.debug(text.trim());
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (!options?.silent) logger.debug(text.trim());
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Check whether a CLI command is available on the system.
 */
export async function checkCommand(command: string): Promise<boolean> {
  try {
    const result = await runCommand("which", [command], { silent: true });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { spawn } from "child_process";
import { homedir } from "os";

export interface LogReadParams {
  job_id: string;
  action: "tail" | "head" | "grep" | "cat";
  lines?: number;
  pattern?: string;
}

export interface LogReadResult {
  success: boolean;
  job_id: string;
  action: string;
  output: string;
  error?: string;
}

export async function logRead(params: LogReadParams): Promise<LogReadResult> {
  const { job_id, action, lines = 50, pattern } = params;

  const logFile = join(homedir(), "linux-mcp-bg", "logs", `${job_id}.log`);

  if (!existsSync(logFile)) {
    return {
      success: false,
      job_id,
      action,
      output: "",
      error: `Log file not found: ${logFile}`,
    };
  }

  try {
    switch (action) {
      case "tail": {
        return await runCommand("tail", ["-n", String(lines), logFile], job_id, action);
      }

      case "head": {
        return await runCommand("head", ["-n", String(lines), logFile], job_id, action);
      }

      case "grep": {
        if (!pattern) {
          return {
            success: false,
            job_id,
            action,
            output: "",
            error: "pattern required for grep action",
          };
        }
        return await runCommand("grep", ["-i", pattern, logFile], job_id, action);
      }

      case "cat": {
        const content = readFileSync(logFile, "utf8");
        return {
          success: true,
          job_id,
          action,
          output: content,
        };
      }

      default:
        return {
          success: false,
          job_id,
          action,
          output: "",
          error: `unknown action: ${action}`,
        };
    }
  } catch (e: any) {
    return {
      success: false,
      job_id,
      action,
      output: "",
      error: e.message,
    };
  }
}

function runCommand(
  cmd: string,
  args: string[],
  jobId: string,
  action: string
): Promise<LogReadResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      output += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({
          success: true,
          job_id: jobId,
          action,
          output: output.trim(),
        });
      } else {
        resolve({
          success: false,
          job_id: jobId,
          action,
          output: output.trim(),
          error: stderr.trim() || `exit code: ${code}`,
        });
      }
    });

    proc.on("error", (e) => {
      resolve({
        success: false,
        job_id: jobId,
        action,
        output: "",
        error: e.message,
      });
    });
  });
}

export const logReadToolDefinition = {
  name: "log_read",
  description:
    "Read logs from background jobs. Actions: tail (last N lines), head (first N lines), grep (search), cat (full). " +
    "Works without daemon - reads log files directly.",
  inputSchema: {
    type: "object" as const,
    properties: {
      job_id: {
        type: "string",
        description: "Job ID to read logs from"
      },
      action: {
        type: "string",
        enum: ["tail", "head", "grep", "cat"],
        description: "Log reading action"
      },
      lines: {
        type: "number",
        description: "Number of lines for tail/head (default: 50)"
      },
      pattern: {
        type: "string",
        description: "Search pattern for grep action"
      },
    },
    required: ["job_id", "action"],
  },
};
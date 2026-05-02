import { homedir } from "os";
import { daemonRequest, ensureDaemon, isDaemonRunning } from "./daemon-manager.js";

export interface ShellBackgroundParams {
  action: "start" | "status" | "stop" | "list";
  command?: string;
  job_id?: string;
  working_dir?: string;
}

export interface ShellBackgroundResult {
  success: boolean;
  action: string;
  job_id?: string;
  pid?: number;
  log_file?: string;
  status?: string;
  command?: string;
  working_dir?: string;
  start_time?: number;
  end_time?: number;
  jobs?: Array<{
    id: string;
    command: string;
    status: string;
    pid: number | null;
    start_time: number | null;
  }>;
  error?: string;
}

export async function shellBackground(
  params: ShellBackgroundParams
): Promise<ShellBackgroundResult> {
  const { action } = params;

  try {
    const running = await isDaemonRunning();
    if (!running) {
      await ensureDaemon();
    }
  } catch (e: any) {
    return {
      success: false,
      action,
      error: `Background daemon not running. Start it first or run: node $(which linux-system-mcp | xargs dirname)/daemon/server.js`,
    };
  }

  try {
    switch (action) {
      case "start": {
        if (!params.command) {
          return { success: false, action, error: "command required for start" };
        }
        const workingDir = params.working_dir || homedir();
        const result = await daemonRequest({
          action: "start",
          command: params.command,
          working_dir: workingDir,
        });
        return {
          success: result.success,
          action,
          job_id: result.job_id,
          pid: result.pid,
          log_file: result.log_file,
        };
      }

      case "status": {
        if (!params.job_id) {
          return { success: false, action, error: "job_id required for status" };
        }
        const result = await daemonRequest({
          action: "status",
          job_id: params.job_id,
        });
        if (result.error) {
          return { success: false, action, error: result.error };
        }
        return {
          success: true,
          action,
          job_id: result.id,
          command: result.command,
          status: result.status,
          pid: result.pid,
          log_file: result.log_file,
          working_dir: result.working_dir,
          start_time: result.start_time,
          end_time: result.end_time,
        };
      }

      case "stop": {
        if (!params.job_id) {
          return { success: false, action, error: "job_id required for stop" };
        }
        const result = await daemonRequest({
          action: "stop",
          job_id: params.job_id,
        });
        return {
          success: result.success,
          action,
          job_id: result.job_id,
          status: result.status,
        };
      }

      case "list": {
        const result = await daemonRequest({ action: "list" });
        return {
          success: true,
          action,
          jobs: result.jobs.map((j: any) => ({
            id: j.id,
            command: j.command,
            status: j.status,
            pid: j.pid,
            start_time: j.start_time,
          })),
        };
      }

      default:
        return { success: false, action, error: `unknown action: ${action}` };
    }
  } catch (e: any) {
    return { success: false, action, error: e.message };
  }
}

export const shellBackgroundToolDefinition = {
  name: "shell_background",
  description:
    "Run shell commands in background using daemon. Actions: start (returns job_id), status, stop, list. " +
    "Requires daemon to be running - if not running, returns error. Use for long-running tasks.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["start", "status", "stop", "list"],
        description: "Action to perform"
      },
      command: {
        type: "string",
        description: "Command to run in background (for start action)"
      },
      job_id: {
        type: "string",
        description: "Job ID (for status/stop actions)"
      },
      working_dir: {
        type: "string",
        description: "Working directory (for start action, default: home)"
      },
    },
    required: ["action"],
  },
};
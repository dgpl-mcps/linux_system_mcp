import { createServer } from "net";
import { spawn } from "child_process";
import { createWriteStream, existsSync, readFileSync } from "fs";
import { mkdirSync, appendFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import {
  createJob,
  startJob,
  stopJob,
  getJob,
  listJobs,
  deleteJob,
} from "./db.js";

const SOCKET_PATH = join(homedir(), "linux-mcp-bg", "daemon.sock");
const LOGS_DIR = join(homedir(), "linux-mcp-bg", "logs");

function ensureDirs() {
  if (!existsSync(dirname(SOCKET_PATH))) {
    mkdirSync(dirname(SOCKET_PATH), { recursive: true });
  }
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

interface Request {
  action: string;
  job_id?: string;
  command?: string;
  working_dir?: string;
}

function generateId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function handleRequest(req: Request): Promise<string> {
  switch (req.action) {
    case "start": {
      if (!req.command) {
        return JSON.stringify({ error: "command required" });
      }
      const id = generateId();
      const workingDir = req.working_dir || homedir();
      createJob(id, req.command, workingDir);

      const logFile = join(LOGS_DIR, `${id}.log`);
      const logStream = createWriteStream(logFile);

      const proc = spawn(
        "/bin/bash",
        ["-c", req.command],
        {
          cwd: workingDir,
          stdio: ["ignore", logStream, logStream],
          detached: true,
        }
      );

      proc.unref();
      startJob(id, proc.pid!);

      return JSON.stringify({
        success: true,
        job_id: id,
        pid: proc.pid,
        log_file: logFile,
      });
    }

    case "status": {
      if (!req.job_id) {
        return JSON.stringify({ error: "job_id required" });
      }
      const job = getJob(req.job_id);
      if (!job) {
        return JSON.stringify({ error: "job not found" });
      }
      return JSON.stringify(job);
    }

    case "stop": {
      if (!req.job_id) {
        return JSON.stringify({ error: "job_id required" });
      }
      const job = getJob(req.job_id);
      if (!job) {
        return JSON.stringify({ error: "job not found" });
      }
      if (job.pid) {
        try {
          process.kill(job.pid, "SIGTERM");
          setTimeout(() => {
            try {
              process.kill(job.pid!, "SIGKILL");
            } catch {}
          }, 1000);
        } catch {}
      }
      stopJob(req.job_id, 1);
      return JSON.stringify({ success: true, job_id: req.job_id, status: "stopped" });
    }

    case "list": {
      const jobs = listJobs();
      return JSON.stringify({ jobs });
    }

    case "delete": {
      if (!req.job_id) {
        return JSON.stringify({ error: "job_id required" });
      }
      const job = getJob(req.job_id);
      if (job?.log_file && existsSync(job.log_file)) {
        try {
          unlinkSync(job.log_file);
        } catch {}
      }
      deleteJob(req.job_id);
      return JSON.stringify({ success: true, job_id: req.job_id });
    }

    default:
      return JSON.stringify({ error: "unknown action" });
  }
}

async function main() {
  ensureDirs();

  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH);
  }

  const server = createServer(async (socket) => {
    let buffer = "";
    
    socket.on("error", () => {});
    
    socket.on("data", (data) => {
      buffer += data.toString();
    });
    
    socket.on("end", async () => {
      try {
        const req = JSON.parse(buffer) as Request;
        const response = await handleRequest(req);
        if (!socket.destroyed) {
          socket.write(response);
        }
      } catch (e) {
        if (!socket.destroyed) {
          socket.write(JSON.stringify({ error: "invalid request" }));
        }
      } finally {
        if (!socket.destroyed) {
          socket.end();
        }
      }
    });
  });

  server.listen(SOCKET_PATH, () => {
    console.log(`Daemon listening on ${SOCKET_PATH}`);
  });

  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
}

main().catch(console.error);
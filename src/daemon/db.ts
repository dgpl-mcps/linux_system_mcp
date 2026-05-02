import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const DB_PATH = join(homedir(), "linux-mcp-bg", "jobs.db");

function ensureDbDir() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    ensureDbDir();
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    initSchema();
  }
  return db;
}

function initSchema() {
  const database = db!;
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      pid INTEGER,
      status TEXT DEFAULT 'pending',
      log_file TEXT,
      working_dir TEXT,
      start_time INTEGER,
      end_time INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
  `);
}

export interface Job {
  id: string;
  command: string;
  pid: number | null;
  status: "pending" | "running" | "stopped" | "completed" | "failed";
  log_file: string | null;
  working_dir: string | null;
  start_time: number | null;
  end_time: number | null;
}

export function createJob(id: string, command: string, workingDir: string): Job {
  const logFile = join(homedir(), "linux-mcp-bg", "logs", `${id}.log`);
  const logDir = dirname(logFile);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO jobs (id, command, log_file, working_dir, status, start_time)
    VALUES (?, ?, ?, ?, 'pending', NULL)
  `);
  stmt.run(id, command, logFile, workingDir);

  return {
    id,
    command,
    pid: null,
    status: "pending",
    log_file: logFile,
    working_dir: workingDir,
    start_time: null,
    end_time: null,
  };
}

export function startJob(id: string, pid: number): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE jobs SET pid = ?, status = 'running', start_time = ? WHERE id = ?
  `);
  stmt.run(pid, Date.now(), id);
}

export function stopJob(id: string, exitCode: number = 0): void {
  const db = getDb();
  const status = exitCode === 0 ? "completed" : "failed";
  const stmt = db.prepare(`
    UPDATE jobs SET status = ?, end_time = ? WHERE id = ?
  `);
  stmt.run(status, Date.now(), id);
}

export function getJob(id: string): Job | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM jobs WHERE id = ?");
  const row = stmt.get(id) as Job | undefined;
  return row || null;
}

export function listJobs(status?: string): Job[] {
  const db = getDb();
  if (status) {
    const stmt = db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC");
    return stmt.all(status) as Job[];
  }
  const stmt = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC");
  return stmt.all() as Job[];
}

export function deleteJob(id: string): void {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM jobs WHERE id = ?");
  stmt.run(id);
}

export function jobExists(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare("SELECT 1 FROM jobs WHERE id = ?");
  return !!stmt.get(id);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
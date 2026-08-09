import fs from "fs";

export interface NativeSystemStats {
  memTotalMb?: number;
  memFreeMb?: number;
  memAvailableMb?: number;
  cpuModel?: string;
  cpuCores?: number;
  loadAverage?: number[];
  displayModes?: string[];
}

export function readNativeProcMeminfo(): { memTotalMb?: number; memFreeMb?: number; memAvailableMb?: number } {
  try {
    const raw = fs.readFileSync("/proc/meminfo", "utf8");
    const totalMatch = raw.match(/MemTotal:\s+(\d+)\s+kB/);
    const freeMatch = raw.match(/MemFree:\s+(\d+)\s+kB/);
    const availMatch = raw.match(/MemAvailable:\s+(\d+)\s+kB/);

    return {
      memTotalMb: totalMatch ? Math.round(parseInt(totalMatch[1], 10) / 1024) : undefined,
      memFreeMb: freeMatch ? Math.round(parseInt(freeMatch[1], 10) / 1024) : undefined,
      memAvailableMb: availMatch ? Math.round(parseInt(availMatch[1], 10) / 1024) : undefined,
    };
  } catch {
    return {};
  }
}

export function readNativeProcCpuinfo(): { cpuModel?: string; cpuCores?: number } {
  try {
    const raw = fs.readFileSync("/proc/cpuinfo", "utf8");
    const modelMatch = raw.match(/model name\s+:\s+(.+)/);
    const coreMatches = raw.match(/^processor\s+:/gm);

    return {
      cpuModel: modelMatch ? modelMatch[1].trim() : undefined,
      cpuCores: coreMatches ? coreMatches.length : undefined,
    };
  } catch {
    return {};
  }
}

export function readNativeProcLoadavg(): number[] {
  try {
    const raw = fs.readFileSync("/proc/loadavg", "utf8").trim();
    const parts = raw.split(/\s+/).slice(0, 3).map(Number);
    return parts;
  } catch {
    return [];
  }
}

export function readNativeDisplayModes(): string[] {
  const modes: string[] = [];
  try {
    const drmPath = "/sys/class/drm";
    if (!fs.existsSync(drmPath)) return modes;

    const dirs = fs.readdirSync(drmPath);
    for (const d of dirs) {
      const modeFile = `${drmPath}/${d}/modes`;
      if (fs.existsSync(modeFile)) {
        try {
          const raw = fs.readFileSync(modeFile, "utf8").trim();
          const firstLine = raw.split("\n")[0];
          if (firstLine && !modes.includes(firstLine)) {
            modes.push(firstLine);
          }
        } catch {}
      }
    }
  } catch {}
  return modes;
}

export function readNativeSystemStats(): NativeSystemStats {
  const mem = readNativeProcMeminfo();
  const cpu = readNativeProcCpuinfo();
  const load = readNativeProcLoadavg();
  const displays = readNativeDisplayModes();

  return {
    ...mem,
    ...cpu,
    loadAverage: load,
    displayModes: displays,
  };
}

import { readFileSync, existsSync, readdirSync } from "fs";
import { cpus, loadavg, uptime } from "os";

export const systemInfoToolDefinition = {
    name: "system_info",
    description: "Get current system metrics (CPU load, memory usage, uptime, battery status).",
    inputSchema: {
        type: "object" as const,
        properties: {},
    },
};

export async function systemInfo(): Promise<any> {
    const result: any = {
        uptime_seconds: Math.floor(uptime()),
        load_average: loadavg(),
        cpus: cpus().length,
    };

    // Memory info
    try {
        const meminfo = readFileSync("/proc/meminfo", "utf8");
        const mem: Record<string, string> = {};
        for (const line of meminfo.split("\n")) {
            const [key, value] = line.split(":");
            if (key && value) {
                mem[key.trim()] = value.trim();
            }
        }
        result.memory = {
            total: mem["MemTotal"],
            free: mem["MemFree"],
            available: mem["MemAvailable"],
            swap_total: mem["SwapTotal"],
            swap_free: mem["SwapFree"],
        };
    } catch {
        result.memory = "unavailable";
    }

    // Battery info
    try {
        const p = "/sys/class/power_supply";
        if (existsSync(p)) {
            const supplies = readdirSync(p);
            const bat = supplies.find((s) => s.startsWith("BAT") || s.startsWith("macsmc-battery"));
            if (bat) {
                const type = readFileSync(`${p}/${bat}/type`, "utf8").trim();
                if (type === "Battery") {
                    const cap = readFileSync(`${p}/${bat}/capacity`, "utf8").trim();
                    const status = readFileSync(`${p}/${bat}/status`, "utf8").trim();
                    result.battery = { capacity_percent: Number(cap), status };
                }
            } else {
                result.battery = "no battery detected";
            }
        }
    } catch {
        result.battery = "unavailable";
    }

    return result;
}

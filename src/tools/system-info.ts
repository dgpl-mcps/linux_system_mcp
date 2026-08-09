import { readNativeSystemStats } from "../utils/native-sysinfo.js";
import { detectScreenGeometry } from "../utils/input-detect.js";

export interface LinuxSystemInfoResult {
  execution_policies: {
    default_timeout_sec: number;
    recommended_max_timeout_sec: number;
    unlimited_timeout_val: number;
    timeout_rule: string;
  };
  display_geometry_and_scaling: {
    canvas_resolution: string;
    coordinate_scaling: string;
    display_modes?: string[];
  };
  hardware_and_proc: {
    cpu_model?: string;
    cpu_cores?: number;
    mem_total_mb?: number;
    mem_available_mb?: number;
    load_average?: number[];
  };
  mouse_guidelines: {
    sensitivity_and_speed: string;
    location_rule: string;
    backends: string;
  };
  security_and_system: {
    package_management: string;
    cuda_acceleration: string;
  };
}

export function getLinuxSystemInfo(): LinuxSystemInfoResult {
  const geom = detectScreenGeometry();
  const sys = readNativeSystemStats();

  return {
    execution_policies: {
      default_timeout_sec: 30,
      recommended_max_timeout_sec: 600,
      unlimited_timeout_val: 0,
      timeout_rule: "Pass timeout: 0 for unlimited duration on heavy builds/installs. Default is 30s.",
    },
    display_geometry_and_scaling: {
      canvas_resolution: geom.geometryString,
      coordinate_scaling: "1:1 pixel canvas mapping",
      display_modes: sys.displayModes && sys.displayModes.length > 0 ? sys.displayModes : undefined,
    },
    hardware_and_proc: {
      cpu_model: sys.cpuModel,
      cpu_cores: sys.cpuCores,
      mem_total_mb: sys.memTotalMb,
      mem_available_mb: sys.memAvailableMb,
      load_average: sys.loadAverage,
    },
    mouse_guidelines: {
      sensitivity_and_speed: "Use duration (100-300ms) & steps (5-10) for movement sensitivity and smooth cursor positioning.",
      location_rule: "Always verify window focus and exact target location before sending click actions.",
      backends: "ydotool, xdotool, wtype, dotool, and native-uinput pure Node.js kernel fallback.",
    },
    security_and_system: {
      package_management: "Strict official distribution packages only (pacman -Syu). No automated AUR updates.",
      cuda_acceleration: "NVIDIA RTX 2050 (4GB VRAM) CUDA offload via Ollama container.",
    },
  };
}

export const linuxSystemInfoToolDefinition = {
  name: "linux_system_info",
  description:
    "Get system execution policies (timeouts, 0=unlimited), dynamic display geometry, live /proc hardware specs (RAM/CPU/Load), mouse sensitivity guidelines, and security policies.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

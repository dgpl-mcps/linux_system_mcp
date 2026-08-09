import { execSync } from "child_process";

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
    compositor: string;
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
  let displayGeometry = "1920x1080";
  try {
    const xrandrOut = execSync("xdpyinfo | grep -i dimensions 2>/dev/null || xrandr 2>/dev/null | grep '*'").toString().trim();
    if (xrandrOut) displayGeometry = xrandrOut;
  } catch { /* fallback */ }

  return {
    execution_policies: {
      default_timeout_sec: 30,
      recommended_max_timeout_sec: 600,
      unlimited_timeout_val: 0,
      timeout_rule: "Pass timeout: 0 for unlimited duration on heavy builds/installs. Default is 30s.",
    },
    display_geometry_and_scaling: {
      canvas_resolution: "1920x1080 pixels",
      coordinate_scaling: "1:1 pixel canvas mapping",
      compositor: "KDE Plasma 6 (KWin Wayland)",
    },
    mouse_guidelines: {
      sensitivity_and_speed: "Use duration (100-300ms) & steps (5-10) for movement sensitivity and smooth cursor positioning.",
      location_rule: "Always verify window focus and exact target location before sending click actions.",
      backends: "ydotool (kernel uinput for Wayland) primary, xdotool fallback.",
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
    "Get system execution policies (timeouts, 0=unlimited), display geometry (1920x1080), scaling rules, mouse sensitivity guidelines, and security policies.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

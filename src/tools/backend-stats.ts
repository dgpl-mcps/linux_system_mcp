import { execSync } from "child_process";
import { getDialogManager } from "../utils/dialog-backend.js";

export interface GetDialogBackendStatsParams {}

export interface GetDialogBackendStatsResult {
  availableDialogBackends: { name: string; available: boolean }[];
  availableNotifyBackends: string[];
  stats: {
    dialog: Record<string, { success: number; failures: number; consecutiveFailures: number }>;
    notify: Record<string, { success: number; failures: number; consecutiveFailures: number }>;
  };
  timeout_policy: {
    default_seconds: number;
    recommended_max_seconds: number;
    unlimited_seconds: number;
    rule: string;
  };
  display_and_gui: {
    screen_resolution: string;
    display_geometry: string;
    wayland_compositor: string;
    mouse_input_backends: string;
    coordinate_scaling_rule: string;
  };
  security_and_system: {
    package_management: string;
    ai_gpu_acceleration: string;
    container_runtime: string;
  };
}

export async function getDialogBackendStats(
  _params: GetDialogBackendStatsParams
): Promise<GetDialogBackendStatsResult> {
  const manager = getDialogManager();
  const stats = manager.getStats();
  const dialogBackends = manager.getAvailableDialogBackends();
  const notifyBackends = manager.getAvailableNotifyBackends();

  let displayGeometry = "1920x1080";
  try {
    const xrandrOut = execSync("xdpyinfo | grep -i dimensions 2>/dev/null || xrandr 2>/dev/null | grep '*'").toString().trim();
    if (xrandrOut) displayGeometry = xrandrOut;
  } catch { /* fallback */ }

  return {
    availableDialogBackends: dialogBackends,
    availableNotifyBackends: notifyBackends,
    stats,
    timeout_policy: {
      default_seconds: 30,
      recommended_max_seconds: 600,
      unlimited_seconds: 0,
      rule: "Pass timeout: 0 for unlimited duration on heavy tasks/builds. Default is 30s.",
    },
    display_and_gui: {
      screen_resolution: "1920x1080 pixels",
      display_geometry: displayGeometry,
      wayland_compositor: "KDE Plasma 6 (KWin Wayland)",
      mouse_input_backends: "ydotool (kernel uinput for Wayland) & xdotool",
      coordinate_scaling_rule: "Screen canvas (1920x1080) maps 1:1 to display geometry. Always verify window focus before sending click actions.",
    },
    security_and_system: {
      package_management: "Strict official distribution packages only (pacman -Syu). No automated AUR updates.",
      ai_gpu_acceleration: "NVIDIA RTX 2050 (4GB VRAM) CUDA offload via Ollama container.",
      container_runtime: "Docker with --restart=no & Waydroid Android 13 on AMD iGPU.",
    },
  };
}

export const getDialogBackendStatsToolDefinition = {
  name: "get_dialog_backend_stats",
  description:
    "[meta] Get system execution policies, display geometry, resolution scaling rules, Wayland backends, and dialog statistics.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};
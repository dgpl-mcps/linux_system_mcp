import { getDialogManager } from "../utils/dialog-backend.js";

export interface GetDialogBackendStatsParams {}

export interface GetDialogBackendStatsResult {
  availableDialogBackends: { name: string; available: boolean }[];
  availableNotifyBackends: string[];
  stats: {
    dialog: Record<string, { success: number; failures: number; consecutiveFailures: number }>;
    notify: Record<string, { success: number; failures: number; consecutiveFailures: number }>;
  };
}

export async function getDialogBackendStats(
  _params: GetDialogBackendStatsParams
): Promise<GetDialogBackendStatsResult> {
  const manager = getDialogManager();
  const stats = manager.getStats();
  const dialogBackends = manager.getAvailableDialogBackends();
  const notifyBackends = manager.getAvailableNotifyBackends();

  return {
    availableDialogBackends: dialogBackends,
    availableNotifyBackends: notifyBackends,
    stats,
  };
}

export const getDialogBackendStatsToolDefinition = {
  name: "get_dialog_backend_stats",
  description:
    "[meta] Get statistics about dialog and notification backends. " +
    "Returns available backends, success/failure counts, and blacklisted backends. " +
    "Useful for debugging or monitoring system dialog capabilities.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};
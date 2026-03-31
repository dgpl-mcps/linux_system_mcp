import { getDialogManager, Urgency } from "../utils/dialog-backend.js";

export interface NotifyParams {
  title: string;
  message: string;
  urgency?: Urgency;
  timeout?: number;
}

export interface NotifyResult {
  success: boolean;
  /** The detected/configured backend (kdialog, zenity, notify-send-only). */
  backend: string;
  /** The backend that actually delivered the notification (may differ from `backend` when fallbacks fire). */
  method: string;
}

export async function notify(params: NotifyParams): Promise<NotifyResult> {
  const manager = getDialogManager();

  try {
    const method = await manager.notify({
      title: params.title,
      message: params.message,
      urgency: params.urgency || "normal",
      timeout: params.timeout,
    });

    return {
      success: method !== "stderr",
      backend: manager.getBackend(),
      method,
    };
  } catch (error) {
    return {
      success: false,
      backend: manager.getBackend(),
      method: "error",
    };
  }
}

export const notifyToolDefinition = {
  name: "notify",
  description:
    "Send a desktop notification to the user. The notification appears in the system tray/notification area. Use this for informational messages, alerts, or status updates that don't require a response. Keywords: notification, alert, inform user, desktop message. Chain this after long-running shell_execute tasks to alert the user that the job is complete, or after system_info to warn them about resource usage.",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description: "The notification title",
      },
      message: {
        type: "string",
        description: "The notification message body",
      },
      urgency: {
        type: "string",
        enum: ["low", "normal", "critical"],
        description: "Notification urgency level (default: normal)",
      },
      timeout: {
        type: "number",
        description: "How long to show the notification in seconds (default: 5)",
      },
    },
    required: ["title", "message"],
  },
};

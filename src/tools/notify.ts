import { getDialogManager, Urgency } from "../utils/dialog-backend.js";

export interface NotifyParams {
  title: string;
  message: string;
  urgency?: Urgency;
  timeout?: number;
}

export interface NotifyResult {
  success: boolean;
  backend: string;
}

export async function notify(params: NotifyParams): Promise<NotifyResult> {
  const manager = getDialogManager();

  try {
    await manager.notify({
      title: params.title,
      message: params.message,
      urgency: params.urgency || "normal",
      timeout: params.timeout,
    });

    return {
      success: true,
      backend: manager.getBackend(),
    };
  } catch (error) {
    return {
      success: false,
      backend: manager.getBackend(),
    };
  }
}

export const notifyToolDefinition = {
  name: "notify",
  description:
    "Send a desktop notification to the user. The notification appears in the system tray/notification area. Use this for informational messages that don't require a response.",
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

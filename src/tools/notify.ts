import { getDialogManager, Urgency } from "../utils/dialog-backend.js";
import { sendNativeDbusNotification, isNativeDbusAvailable } from "../utils/native-dbus.js";

export interface NotifyParams {
  title: string;
  message: string;
  urgency?: Urgency;
  timeout?: number;
}

export interface NotifyResult {
  success: boolean;
  /** The detected/configured backend (kdialog, zenity, notify-send-only, native-dbus). */
  backend: string;
  /** The backend that actually delivered the notification. */
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

    if (method !== "stderr") {
      return {
        success: true,
        backend: manager.getBackend(),
        method,
      };
    }
  } catch {}

  // Fallback to pure Node.js D-Bus UNIX socket notification
  if (isNativeDbusAvailable()) {
    const sent = await sendNativeDbusNotification({
      summary: params.title,
      body: params.message,
    });

    if (sent) {
      return {
        success: true,
        backend: "native-dbus",
        method: "native-dbus-socket",
      };
    }
  }

  return {
    success: false,
    backend: manager.getBackend(),
    method: "error",
  };
}

export const notifyToolDefinition = {
  name: "notify",
  description:
    "Send a desktop notification to the user. Uses system tray/notification area. Features pure Node.js D-Bus UNIX socket fallback when notify-send/zenity/kdialog are missing.",
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

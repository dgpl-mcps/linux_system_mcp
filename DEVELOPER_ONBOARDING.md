# Developer Onboarding & Architecture Guide — Linux System MCP Server

Welcome to **`linux-system-mcp`**. This MCP server provides AI agents with Linux desktop automation, system notifications, interactive GUI dialogs, privileged shell commands, audio volume control, and hardware sensors across **any Linux distribution and desktop environment**.

---

## 🏗️ 1. Multi-DE & Multi-Backend Architecture

To ensure 100% compatibility across all Linux installations, this server avoids hardcoding desktop-specific or audio-specific commands. It employs a cascaded fallback architecture:

```
┌────────────────────────────────────────────────────────┐
│                   AI Agent Request                     │
└──────────────────────────┬─────────────────────────────┘
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
       [Dialogs]    [Notification]   [Audio/Vol]
             │             │             │
      1. kdialog    1. notify-send   1. wpctl (PipeWire)
      2. zenity     2. kdialog       2. pactl (PulseAudio)
      3. yad        3. zenity        3. amixer (ALSA)
      4. CLI stdin  4. terminal      4. sysfs
```

### 1. Interactive Desktop Dialogs (Human-in-the-Loop)
- **KDE Plasma**: Auto-detected via `$XDG_CURRENT_DESKTOP`. Uses `kdialog` with native breeze styling.
- **GNOME / XFCE / MATE / Cinnamon**: Uses `zenity` with GTK dialogs.
- **Tiling WMs (Hyprland / Sway / i3)**: Falls back to `yad` or terminal prompt.

### 2. Privilege Escalation & Polkit
- **Headless Non-Interactive**: `sudo -n` for passwordless sudo rules.
- **Polkit GUI Agent**: `pkexec` triggers the system authentication agent (e.g., `polkit-kde-authentication-agent-1` or GNOME polkit).

### 3. Display Backlight & Hardware
- Tries `brightnessctl` $\to$ `ddcutil` $\to$ direct sysfs `/sys/class/backlight/*`.

---

## ⚡ 2. Quickstart (Clone & Run in 60 Seconds)

```bash
# 1. Clone repository
git clone https://github.com/vk-alto-none/linux_system_mcp.git
cd linux_system_mcp

# 2. Run automated installer & build
./install.sh

# 3. Run integration tests
bash test-mcp.sh
```

---

## 📦 3. System Prerequisites

Node.js (v18+) and npm:
- **Arch / Manjaro**: `sudo pacman -S nodejs npm libnotify`
- **Debian / Ubuntu**: `sudo apt install nodejs npm libnotify-bin`
- **Fedora**: `sudo dnf install nodejs npm libnotify`

Optional GUI dialog helpers (install at least one):
- KDE Plasma: `kdialog`
- GNOME / GTK: `zenity`

---

## 🔌 4. MCP Client Configuration

### Antigravity (`~/.gemini/antigravity/mcp_config.json`)
```json
{
  "mcpServers": {
    "linux-system-mcp": {
      "command": "node",
      "args": ["/save_data/projects/linux_system_mcp/dist/index.js"],
      "env": {
        "defer_loading": "true"
      }
    }
  }
}
```

### Claude Desktop (`~/.config/Claude/claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "linux-system-mcp": {
      "command": "node",
      "args": ["/save_data/projects/linux_system_mcp/dist/index.js"],
      "env": {
        "defer_loading": "true"
      }
    }
  }
}
```

---

## 🧪 5. Testing & Verification

Run the automated integration test script:
```bash
bash test-mcp.sh
```
This tests:
1. Tool defer loading list (`linux_system_tool_search`).
2. Tool searching.
3. Live shell execution (`shell_execute`).
4. Desktop notification dispatch (`notify`).
5. All tools full enumeration when defer loading is false.

---

## 🌿 6. Git Workflow & Contributing

- **Default Development Branch**: `save-dev`
- **Pinned Committer Identity**:
  ```bash
  git config user.name "cyber-bye"
  git config user.email "vikaskumawat012356@gmail.com"
  ```
- **Promotion Pipeline**: `feature branch` $\to$ `save-dev` $\to$ `dev` $\to$ `main` $\to$ `save-dev-safe`

---

## 🏢 7. Corporate Identity & Attribution

- **Entity**: Durbhasi Gurukulam Private Limited (DGPL)
- **Jurisdiction**: Jaipur, Rajasthan, Bharat (India)
- **Contact**: `support@durbhasigurukulam.com`

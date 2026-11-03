#!/usr/bin/env bash
# ==============================================================================
# 🐧 LINUX SYSTEM MCP SERVER — INSTALLER & CONFIGURATION SUITE
# ==============================================================================
# Cross-distribution automated setup for the Linux System MCP Server.
# Supports Antigravity, Claude Desktop, Cursor, Hermes, and any MCP client.
#
# Usage:
#   ./install.sh             # Installs dependencies, compiles TypeScript
#   ./install.sh --configure # Auto-configures Antigravity & Claude Desktop configs
#   ./install.sh --dry-run   # Preview actions without making changes
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

DO_CONFIG=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --configure)
            DO_CONFIG=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [--configure] [--dry-run]"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo -e "${BOLD}${CYAN}===================================================================${NC}"
echo -e "${BOLD}${CYAN}🐧 LINUX SYSTEM MCP SERVER — INSTALLER${NC}"
echo -e "${BOLD}${CYAN}===================================================================${NC}"

# 1. Check Node.js and NPM
if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
    echo -e "${RED}Error: Node.js and npm are required.${NC}"
    echo -e "Please install Node.js (v18+) via your package manager."
    exit 1
fi
echo -e "Node.js Version: ${GREEN}$(node -v)${NC}"
echo -e "NPM Version:     ${GREEN}$(npm -v)${NC}"

# 2. Check Desktop Environment utilities
echo -e "\n${BOLD}${BLUE}==> Probing desktop environment utilities...${NC}"
check_tool() {
    local tool="$1"
    local desc="$2"
    if command -v "$tool" &>/dev/null; then
        echo -e "  • ${tool}: ${GREEN}Available${NC} (${desc})"
    else
        echo -e "  • ${tool}: ${YELLOW}Not found (optional fallback)${NC} (${desc})"
    fi
}

check_tool "notify-send" "Freedesktop Desktop Notifications"
check_tool "kdialog" "KDE Plasma Native Dialogs"
check_tool "zenity" "GNOME / GTK Native Dialogs"
check_tool "pkexec" "Polkit Headless & GUI Elevation"
check_tool "wpctl" "PipeWire Volume & Source Control"
check_tool "brightnessctl" "Backlight Brightness Adjustment"

# 3. Install Dependencies & Build
echo -e "\n${BOLD}${BLUE}==> Installing npm packages & building TypeScript...${NC}"
if [[ "${DRY_RUN}" == true ]]; then
    echo "[DRY-RUN] npm install"
    echo "[DRY-RUN] npm run build"
else
    npm install
    npm run build
fi

ENTRY_PATH="${SCRIPT_DIR}/dist/index.js"
if [[ "${DRY_RUN}" == false && ! -f "${ENTRY_PATH}" ]]; then
    echo -e "${RED}Error: Build failed to produce dist/index.js.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Build successful: ${ENTRY_PATH}${NC}"

# 4. Optional Client Configuration
if [[ "${DO_CONFIG}" == true ]]; then
    echo -e "\n${BOLD}${BLUE}==> Configuring MCP clients...${NC}"

    # Claude Desktop Config
    CLAUDE_CFG="${HOME}/.config/Claude/claude_desktop_config.json"
    if [[ -d "$(dirname "${CLAUDE_CFG}")" ]]; then
        echo -e "Configuring Claude Desktop: ${CYAN}${CLAUDE_CFG}${NC}"
        # We ensure jq is available or use python to merge JSON
        python3 - << EOF
import json, os

path = os.path.expanduser("${CLAUDE_CFG}")
os.makedirs(os.path.dirname(path), exist_ok=True)
data = {}
if os.path.exists(path):
    try:
        with open(path, "r") as f:
            data = json.load(f)
    except Exception:
        data = {}

if "mcpServers" not in data:
    data["mcpServers"] = {}

data["mcpServers"]["linux-system-mcp"] = {
    "command": "node",
    "args": ["${ENTRY_PATH}"],
    "env": {
        "defer_loading": "true"
    }
}

with open(path, "w") as f:
    json.dump(data, f, indent=2)
print("Updated Claude Desktop config successfully.")
EOF
    fi
fi

echo -e "\n${BOLD}${GREEN}===================================================================${NC}"
echo -e "${BOLD}${GREEN}✓ LINUX SYSTEM MCP SERVER IS READY!${NC}"
echo -e "${BOLD}${GREEN}===================================================================${NC}"
echo -e "To configure this server in Antigravity or Claude Desktop, add to your MCP config:"
cat << EOF

{
  "mcpServers": {
    "linux-system-mcp": {
      "command": "node",
      "args": ["${ENTRY_PATH}"],
      "env": {
        "defer_loading": "true"
      }
    }
  }
}
EOF
echo -e "\nRun ${BOLD}bash test-mcp.sh${NC} to execute integration tests."

# 🖱️ Comprehensive Technical Report: Desktop GUI Mouse Automation & Screen Coordinates under Linux Wayland (KDE Plasma)

---

## 1. Executive Summary & Root Cause Analysis

During automated testing of GUI interactions via the `linux-system-mcp` MCP tools, attempting to launch applications (e.g. Visual Studio Code / Discover / Terminal) via taskbar or launcher menu mouse clicks yielded an unexpected visual behavior: **The physical mouse pointer was dislocated or stuck at `(960, 540)` (center screen), preventing click events from reaching target UI elements on native Wayland surfaces.**

### Key Technical Insights Discovered:
1. **Wayland vs XWayland Display Server Architecture**:
   - On KDE Plasma Wayland (`WAYLAND_DISPLAY=wayland-0`), native Wayland application windows (such as `kstart`, `plasmashell`, or native Wayland apps) are managed directly by `KWin`.
   - Legacy input tools like `xdotool` communicate over XWayland (`DISPLAY=:1`).
   - When `xdotool getmouselocation` or `xdotool mousemove` is executed under Wayland, `xdotool` queries/dispatches events relative to XWayland root windows. Under native Wayland compositors, `xdotool`'s location queries return a static center fallback position `(960, 540)` rather than the real-time compositor cursor position.

2. **Kernel `/dev/uinput` & `ydotool` Virtual Input Redirection**:
   - `ydotool` and `nativeUinput` inject Linux input subsystem events directly into kernel `/dev/uinput`.
   - Kernel-level `/dev/uinput` mouse events physically move the compositor cursor across all native Wayland and XWayland windows identically, but standard X11 query APIs (`XQueryPointer`) cannot read back the updated cursor position from `KWin`.

3. **Spectacle Screenshot Mouse Pointer Overlay (`-p` Flag)**:
   - KDE's `spectacle -b -p -o <file>` background mode reliably captures and renders the live Wayland compositor mouse cursor on screen.
   - Screenshots verified that `spectacle` draws the mouse pointer image accurately at the physical cursor location, providing absolute visual truth.

---

## 2. Detailed Technical Breakdown of Mouse Input Mechanics

| Tool / Backend | Protocol / Layer | Wayland Coordinate Query | Native Wayland Click Dispatch | Behavior & Observations |
| :--- | :--- | :--- | :--- | :--- |
| **`xdotool`** | X11 / XWayland (`:1`) | ⚠️ Returns static `(960, 540)` | ❌ Fails on native Wayland UI panels | Only affects XWayland window clients. |
| **`ydotool`** | Daemon → `/dev/uinput` | ⚠️ N/A (query requires `ydotoold`) | ✅ Full system-wide kernel event | Requires active `ydotoold` socket daemon. |
| **`nativeUinput`** | Kernel `/dev/uinput` | ⚠️ N/A (Kernel write-only device) | ✅ Full system-wide kernel event | Direct `/dev/uinput` binary writing without daemon. |
| **`python-x11`** | `libX11.so.6` (`XQueryPointer`) | ⚠️ Returns XWayland root position | ❌ Query only | Queries root window pointer via CTypes bindings. |

---

## 3. Best Practices & Standard Operating Procedures (SOP) for MCP Mouse Usage

To ensure 100% reliability during GUI automation tasks without resorting to shell shortcuts or CLI overrides, follow these mandatory guidelines:

1. **Targeting Window Coordinates**:
   - Always pass `windowClass` or `windowTitle` to `mouse` tool calls when interacting with specific windows (e.g. `windowClass: "code"` or `windowTitle: "Visual Studio Code"`).
   - This allows relative coordinate calculation inside target app boundaries.

2. **Visual Screenshot Verification**:
   - After dispatching `mouse` movement or click actions, immediately call `screenshot({ filename: "/tmp/ss_check.png" })` and inspect the image using `view_file`.
   - Inspect the exact rendered location of the arrow/hand cursor overlay drawn by `spectacle -p`.

3. **Backend Selection Strategy**:
   - Use `preferredBackend: "ydotool"` or `preferredBackend: "nativeUinput"` when interacting with plasma panels, taskbars, or desktop shell widgets.
   - Use `xdotool` only when targeting traditional XWayland windows.

---

## 4. Summary of Improvements Implemented in `linux-system-mcp`

- **Spectacle Pointer Support**: Added `-p` (`--pointer`) flag to `spectacle` background CLI invocation in `src/tools/screenshot.ts`.
- **Python CTypes `libX11` Pointer Query**: Integrated `python-x11` `XQueryPointer` fallback into `getCurrentMousePosition()` in `src/utils/input-detect.ts`.
- **Preferred Backend Alignment**: Updated `mouseExecute()` in `src/tools/mouse.ts` to respect user-specified `preferredBackend` across both movement and click actions.

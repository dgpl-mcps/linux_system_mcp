# 📈 `linux_system_mcp` — Improvements & Engineering Log

> **Repository:** `/save_data/01_PROJECTS/mcp_servers/linux_system_mcp`  
> **Maintainer:** DGPL (Durbhasi Gurukulam Private Limited)  
> **Standards:** DGPL-LAW-MCP-001, DGPL-LAW-TRUTH-001, DGPL-LAW-AUTO-001 (PAE), Rule 2 (Modular Architecture)

---

## 🚀 Milestone: Multi-Term Lexical Tokenization & Quoted Phrase Tool Discovery (November 2026)

### 1. Problem Statement & Context
- In previous versions, `linux_system_tool_search` used naive single-string substring matching (`t.name.includes(query) || t.description.includes(query)`).
- When a calling agent searched for multiple concepts simultaneously (e.g. `sudo shell` or `mouse keyboard`), the server returned 0 results because no tool contained the verbatim concatenated string `"sudo shell"`.
- This caused false-negative discovery loops where AI agents wrongly concluded tools were missing.
- Furthermore, exact quoted phrases (e.g., `"sudo shell"` vs `"sudo1 shell1" "sudo2 shell2"`) could not be searched atomically, and results were formatted as flat unstructured text rather than structured objects with term-level keys.

---

### 2. Architectural Breakthroughs & Innovations

1. **Stateful Lexer Scanner (`src/utils/tool-search.ts` - `parseSearchQuery`)**:
   - Supports space-delimited multi-word search (`sudo shell` $\to$ `["sudo", "shell"]`).
   - Supports double quotes (`"sudo shell"`) and single quotes (`'sudo shell'`) as atomic exact phrases.
   - Supports multiple quoted phrases: `"sudo1 shell1" "sudo2 shell2"` $\to$ `["sudo1 shell1", "sudo2 shell2"]`.
   - Supports mixed syntax: `notify "shell execute" keyboard` $\to$ `["notify", "shell execute", "keyboard"]`.
   - Recovers gracefully from unclosed quotes, handles escaped quotes (`\"`), trims whitespace, and deduplicates terms case-insensitively while preserving original order.

2. **Per-Term Search & Space-Normalized Identifier Resolution**:
   - Evaluates each term independently across tool names and descriptions.
   - Normalizes underscores (`name.replace(/_/g, " ")`), seamlessly bridging natural language queries (e.g. `"shell execute"`) to snake_case tool names (`shell_execute`).

3. **Structured Aggregated Data Contract (Option A)**:
   - Output format provides top-level `summary` metadata alongside a `results` dictionary where each searched term is an explicit key containing its match count and tools:
     ```json
     {
       "summary": {
         "total_terms": 2,
         "total_unique_matches": 2,
         "counts": { "sudo": 1, "shell": 1 }
       },
       "results": {
         "sudo": { "count": 1, "tools": [ ... ] },
         "shell": { "count": 1, "tools": [ ... ] }
       }
     }
     ```
   - Each tool entry retains `name`, `description`, and full `inputSchema` so the agent can inspect parameters and execute calls immediately.

4. **Self-Matching Shield (`DGPL-LAW-MCP-001`)**:
   - Explicitly filters out `linux_system_tool_search` from candidate search tools (`ALL_TOOLS.filter(t => t.name !== "linux_system_tool_search")`).
   - Prevents the meta-tool's own description and query examples from polluting search results.

---

### 3. Empirical Verification & Zero-Simulation Audit

A dedicated empirical test harness was established in `tests/verify_tool_search.mjs` verifying 13 test cases across 5 dimensions:
- **Dimension 1 (Boundary & Negative)**: Empty query, whitespace query, nonexistent term handling.
- **Dimension 2 (Unquoted Multi-Word)**: `sudo shell` separated into `sudo` and `shell`, verifying both keys and matched tool arrays.
- **Dimension 3 (Quoted Phrase Preservation)**: `"sudo shell"` exact phrase verification; multiple quotes `"sudo1 shell1" "sudo2 shell2"`.
- **Dimension 4 (Mixed Syntax & Resilience)**: Mixed unquoted and quoted tokens, single quotes, unclosed quotes, case-insensitive deduplication.
- **Dimension 5 (Live Stdio JSON-RPC MCP Server)**: Live execution against `node dist/index.js` verifying valid JSON-RPC 2.0 output and schema compliance.

**Test Results:** `13/13 PASSED` (`npm test`).

---

### 4. Incidents & Forensic Lessons Learned

1. **Meta-Tool Self-Matching Pollution Bug**:
   - *Symptom*: In live server tests, querying `"sudo shell"` returned 1 match instead of 0.
   - *Forensic Cause*: The meta-tool `linux_system_tool_search` was in `ALL_TOOLS`, and its own description contained the example string `"sudo shell"`.
   - *Fix*: Excluded the meta-tool from the candidate tool array (`searchableTools = ALL_TOOLS.filter(t => t.name !== "linux_system_tool_search")`).

2. **Quoted Phrase Continuous Substring Fallacy**:
   - *Symptom*: Testing `"mouse click"` in live server returned count 0 against real `mouse` tool.
   - *Forensic Cause*: The `mouse` tool description contained `move/click/scroll/drag/position` (slash-separated words), not the continuous phrase `"mouse click"`.
   - *Fix*: Enforced strict exact-substring semantics for quotes and updated live tests to verify authentic multi-word strings (`"shell execute"` and `"desktop notification"`).

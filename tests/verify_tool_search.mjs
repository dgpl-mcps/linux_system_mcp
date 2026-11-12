#!/usr/bin/env node
/**
 * Empirical Verification Harness for Tool Search Engine
 * Complies with DGPL-LAW-TRUTH-001 (Zero Simulation) and 5-Dimension Testing
 */

import assert from "node:assert";
import { execSync } from "node:child_process";
import { parseSearchQuery, searchTools } from "../dist/utils/tool-search.js";

console.log("======================================================");
console.log("🚀 STARTING EMPIRICAL TOOL SEARCH VERIFICATION HARNESS");
console.log("======================================================\n");

// Mock / Sample toolset for unit verification
const SAMPLE_TOOLS = [
  {
    name: "linux_system_tool_search",
    description: "Search for available tools by keyword or phrase",
    inputSchema: { type: "object" },
  },
  {
    name: "sudo_execute",
    description: "Execute commands with elevated sudo privileges via pkexec or sudo",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
  },
  {
    name: "shell_execute",
    description: "Execute arbitrary shell commands in the host environment",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
  },
  {
    name: "notify",
    description: "Send desktop notification to the user",
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
  },
  {
    name: "mouse",
    description: "Automate mouse click, move, and scroll actions",
    inputSchema: { type: "object", properties: { action: { type: "string" } } },
  },
  {
    name: "keyboard",
    description: "Simulate keyboard keystrokes and typing",
    inputSchema: { type: "object", properties: { keys: { type: "string" } } },
  },
];

let totalTests = 0;
let passedTests = 0;

function runTest(testName, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ [PASS] ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] ${testName}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ------------------------------------------------------------------
// Dimension 1: Negative / Boundary Tests
// ------------------------------------------------------------------
runTest("Dimension 1: Empty or whitespace query parsing", () => {
  assert.deepStrictEqual(parseSearchQuery(""), []);
  assert.deepStrictEqual(parseSearchQuery("   "), []);
  assert.deepStrictEqual(parseSearchQuery("\t  \n "), []);

  const res = searchTools(SAMPLE_TOOLS, "");
  assert.strictEqual(res.summary.total_terms, 0);
  assert.strictEqual(res.summary.total_unique_matches, 0);
  assert.deepStrictEqual(res.results, {});
});

runTest("Dimension 1: Non-existent term returns count 0 and empty tools array", () => {
  const res = searchTools(SAMPLE_TOOLS, "nonexistent_term_404");
  assert.strictEqual(res.summary.total_terms, 1);
  assert.strictEqual(res.summary.total_unique_matches, 0);
  assert.strictEqual(res.summary.counts["nonexistent_term_404"], 0);
  assert.ok("nonexistent_term_404" in res.results);
  assert.strictEqual(res.results["nonexistent_term_404"].count, 0);
  assert.deepStrictEqual(res.results["nonexistent_term_404"].tools, []);
});

// ------------------------------------------------------------------
// Dimension 2: Unquoted Multi-Word Search (Separated & Aggregated)
// ------------------------------------------------------------------
runTest("Dimension 2: 'sudo shell' parses into two terms and aggregates separate results", () => {
  const tokens = parseSearchQuery("sudo shell");
  assert.deepStrictEqual(tokens, ["sudo", "shell"]);

  const res = searchTools(SAMPLE_TOOLS, "sudo shell");
  assert.strictEqual(res.summary.total_terms, 2);
  assert.ok(res.summary.counts["sudo"] >= 1, "sudo should have at least 1 match");
  assert.ok(res.summary.counts["shell"] >= 1, "shell should have at least 1 match");

  // Validate that 'sudo' and 'shell' are keys in results
  assert.ok("sudo" in res.results);
  assert.ok("shell" in res.results);

  // Check that sudo matches sudo_execute
  const sudoNames = res.results["sudo"].tools.map((t) => t.name);
  assert.ok(sudoNames.includes("sudo_execute"));

  // Check that shell matches shell_execute
  const shellNames = res.results["shell"].tools.map((t) => t.name);
  assert.ok(shellNames.includes("shell_execute"));
});

// ------------------------------------------------------------------
// Dimension 3: Quoted Phrase Preservation (Exact Unit)
// ------------------------------------------------------------------
runTest("Dimension 3: '\"sudo shell\"' treated as a single string", () => {
  const tokens = parseSearchQuery('"sudo shell"');
  assert.deepStrictEqual(tokens, ["sudo shell"]);

  const res = searchTools(SAMPLE_TOOLS, '"sudo shell"');
  assert.strictEqual(res.summary.total_terms, 1);
  assert.ok("sudo shell" in res.results);
  // None of the tools contain verbatim "sudo shell", so count should be 0
  assert.strictEqual(res.results["sudo shell"].count, 0);
});

runTest("Dimension 3: Multiple quoted phrases '\"sudo1 shell1\" \"sudo2 shell2\"'", () => {
  const tokens = parseSearchQuery('"sudo1 shell1" "sudo2 shell2"');
  assert.deepStrictEqual(tokens, ["sudo1 shell1", "sudo2 shell2"]);

  const res = searchTools(SAMPLE_TOOLS, '"sudo1 shell1" "sudo2 shell2"');
  assert.strictEqual(res.summary.total_terms, 2);
  assert.ok("sudo1 shell1" in res.results);
  assert.ok("sudo2 shell2" in res.results);
  assert.strictEqual(res.results["sudo1 shell1"].count, 0);
  assert.strictEqual(res.results["sudo2 shell2"].count, 0);
});

runTest("Dimension 3: Multiple quoted phrases matching real tools '\"shell execute\" \"mouse click\"'", () => {
  const tokens = parseSearchQuery('"shell execute" "mouse click"');
  assert.deepStrictEqual(tokens, ["shell execute", "mouse click"]);

  const res = searchTools(SAMPLE_TOOLS, '"shell execute" "mouse click"');
  assert.strictEqual(res.summary.total_terms, 2);
  assert.ok(res.results["shell execute"].count >= 1);
  assert.ok(res.results["mouse click"].count >= 1);

  const shellNames = res.results["shell execute"].tools.map((t) => t.name);
  assert.ok(shellNames.includes("shell_execute"));

  const mouseNames = res.results["mouse click"].tools.map((t) => t.name);
  assert.ok(mouseNames.includes("mouse"));
});

// ------------------------------------------------------------------
// Dimension 4: Mixed Syntax & Resilience
// ------------------------------------------------------------------
runTest("Dimension 4: Mixed unquoted and quoted 'notify \"shell execute\" keyboard'", () => {
  const tokens = parseSearchQuery('notify "shell execute" keyboard');
  assert.deepStrictEqual(tokens, ["notify", "shell execute", "keyboard"]);

  const res = searchTools(SAMPLE_TOOLS, 'notify "shell execute" keyboard');
  assert.strictEqual(res.summary.total_terms, 3);
  assert.ok("notify" in res.results);
  assert.ok("shell execute" in res.results);
  assert.ok("keyboard" in res.results);

  assert.ok(res.results["notify"].count >= 1);
  assert.ok(res.results["shell execute"].count >= 1);
  assert.ok(res.results["keyboard"].count >= 1);
});

runTest("Dimension 4: Single quotes support ''sudo shell''", () => {
  const tokens = parseSearchQuery("'sudo shell' notify");
  assert.deepStrictEqual(tokens, ["sudo shell", "notify"]);
});

runTest("Dimension 4: Unclosed quotes recovery '\"sudo shell'", () => {
  const tokens = parseSearchQuery('"sudo shell');
  assert.deepStrictEqual(tokens, ["sudo shell"]);
});

runTest("Dimension 4: Case-insensitive deduplication 'sudo SUDO sudo'", () => {
  const tokens = parseSearchQuery("sudo SUDO sudo");
  assert.deepStrictEqual(tokens, ["sudo"]);
});

// ------------------------------------------------------------------
// Dimension 5: Live stdio JSON-RPC MCP Server Verification
// ------------------------------------------------------------------
runTest("Dimension 5: Live stdio JSON-RPC MCP Server execution for 'sudo shell'", () => {
  const rpcInput = JSON.stringify({
    jsonrpc: "2.0",
    id: 101,
    method: "tools/call",
    params: {
      name: "linux_system_tool_search",
      arguments: {
        query: "sudo shell",
      },
    },
  });

  const output = execSync(
    `echo '${rpcInput}' | timeout 5 node dist/index.js 2>/dev/null`,
    { encoding: "utf-8" }
  );

  const parsed = JSON.parse(output.trim());
  assert.strictEqual(parsed.id, 101);
  assert.ok(parsed.result && parsed.result.content && parsed.result.content[0]);

  const searchData = JSON.parse(parsed.result.content[0].text);
  assert.ok(searchData.summary, "Must have summary object");
  assert.ok(searchData.results, "Must have results object");

  // Must have 'sudo' and 'shell' keys
  assert.ok("sudo" in searchData.results, "Must have 'sudo' key in results");
  assert.ok("shell" in searchData.results, "Must have 'shell' key in results");

  assert.ok(searchData.results["sudo"].count > 0, "sudo must have matches");
  assert.ok(searchData.results["shell"].count > 0, "shell must have matches");

  // Validate tool structure in sudo results
  const sudoTool = searchData.results["sudo"].tools[0];
  assert.ok(sudoTool.name, "Tool must have name");
  assert.ok(sudoTool.description, "Tool must have description");
  assert.ok(sudoTool.inputSchema, "Tool must have inputSchema");

  console.log("   --> Summary counts from live server:", JSON.stringify(searchData.summary.counts));
});

runTest("Dimension 5: Live stdio JSON-RPC MCP Server execution for '\"sudo shell\"'", () => {
  const rpcInput = JSON.stringify({
    jsonrpc: "2.0",
    id: 102,
    method: "tools/call",
    params: {
      name: "linux_system_tool_search",
      arguments: {
        query: '"sudo shell"',
      },
    },
  });

  const output = execSync(
    `echo '${rpcInput}' | timeout 5 node dist/index.js 2>/dev/null`,
    { encoding: "utf-8" }
  );

  const parsed = JSON.parse(output.trim());
  const searchData = JSON.parse(parsed.result.content[0].text);

  assert.strictEqual(searchData.summary.total_terms, 1);
  assert.ok("sudo shell" in searchData.results, "Must have exact 'sudo shell' key");
  assert.strictEqual(searchData.results["sudo shell"].count, 0, "Must have 0 matches for exact 'sudo shell'");
});

runTest("Dimension 5: Live stdio JSON-RPC MCP Server execution for '\"shell execute\" \"desktop notification\"'", () => {
  const rpcInput = JSON.stringify({
    jsonrpc: "2.0",
    id: 103,
    method: "tools/call",
    params: {
      name: "linux_system_tool_search",
      arguments: {
        query: '"shell execute" "desktop notification"',
      },
    },
  });

  const output = execSync(
    `echo '${rpcInput}' | timeout 5 node dist/index.js 2>/dev/null`,
    { encoding: "utf-8" }
  );

  const parsed = JSON.parse(output.trim());
  const searchData = JSON.parse(parsed.result.content[0].text);

  assert.strictEqual(searchData.summary.total_terms, 2);
  assert.ok("shell execute" in searchData.results);
  assert.ok("desktop notification" in searchData.results);
  assert.ok(searchData.results["shell execute"].count >= 1);
  assert.ok(searchData.results["desktop notification"].count >= 1);
  console.log("   --> Summary counts for multi-quoted live search:", JSON.stringify(searchData.summary.counts));
});

console.log("\n======================================================");
console.log(`📊 ALL VERIFICATION TESTS COMPLETED: ${passedTests}/${totalTests} PASSED`);
console.log("======================================================");

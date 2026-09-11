/**
 * Test Verifier & Error Extraction for Swarm Judge Loop.
 *
 * Parses test runner output (Jest/Vitest, PyTest, Cargo Test, Go Test)
 * and formats actionable diagnostic summaries for re-queued task prompts.
 */

export interface ParsedFailure {
  summary: string;
  failedTests: string[];
  stackTrace?: string;
}

/**
 * Extracts failed assertions, filenames, line numbers, and error messages
 * from test execution logs.
 */
export function extractTestDiagnostics(log: string): ParsedFailure {
  const lines = log.split("\n");
  const failedTests: string[] = [];
  const stackLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Jest / Vitest: ✕ test name or FAIL path/to/test.ts
    if (/^\s*(✕|FAIL|●)\s+(.+)/.test(line)) {
      failedTests.push(line.trim());
    }
    // PyTest: FAILED path/to/test.py::test_func - Error
    else if (/^FAILED\s+(.+)/.test(line)) {
      failedTests.push(line.trim());
    }
    // Cargo Test: test test_name ... FAILED
    else if (/^test\s+(.+)\s+\.\.\.\s+FAILED/.test(line)) {
      failedTests.push(line.trim());
    }
    // Go Test: --- FAIL: TestName (0.00s)
    else if (/^--- FAIL:\s+(.+)/.test(line)) {
      failedTests.push(line.trim());
    }

    // Capture error traces / assertions (Error:, AssertionError:, expected, received)
    if (/^\s*(Error:|AssertionError:|Expected:|Received:|assert\s|panic:)/i.test(line)) {
      stackLines.push(lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 6)).join("\n"));
    }
  }

  const summary = failedTests.length > 0
    ? `Failed ${failedTests.length} test(s):\n${failedTests.slice(0, 5).join("\n")}`
    : "Verification test suite failed with non-zero exit code.";

  const stackTrace = stackLines.length > 0
    ? stackLines.slice(0, 3).join("\n---\n")
    : lines.slice(-20).join("\n"); // fallback to tail of log

  return { summary, failedTests, stackTrace };
}

/**
 * Injects test diagnostics into the re-queued task prompt for the next round.
 */
export function formatTestFailurePrompt(originalPrompt: string, diagnostics: ParsedFailure, round: number): string {
  return [
    originalPrompt,
    "",
    `[Judge Feedback - Round ${round} Tests Failed]:`,
    diagnostics.summary,
    "",
    "Diagnostic Stack Trace / Compiler Output:",
    "```",
    diagnostics.stackTrace,
    "```",
    "Please fix the code in your worktree to resolve these test failures.",
  ].join("\n");
}

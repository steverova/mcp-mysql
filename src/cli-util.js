import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Is this module being run directly (node src/x.js)?
 * In a compiled binary it returns false: commands are invoked from the CLI.
 */
export function isEntryPoint(moduleUrl) {
  if (process.env.MCP_MYSQL_ENTRY === "bin") return false;

  const input = process.argv[1];
  if (!input) return false;
  try {
    return path.resolve(input) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

// Runs a CLI task and turns errors into an exit code.
export async function runCli(task) {
  try {
    await task();
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}

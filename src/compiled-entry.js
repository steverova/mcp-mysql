/**
 * Marks that the process is driven by the CLI.
 * It is imported as the FIRST module of the bin so that src/ modules do not
 * self-execute when imported (in a compiled binary import.meta.url does not
 * distinguish modules, and every file would look like the entry point).
 */
process.env.MCP_MYSQL_ENTRY = "bin";

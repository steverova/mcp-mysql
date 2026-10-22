/**
 * Marca que el proceso lo gobierna el CLI.
 * Se importa como PRIMER módulo del bin: así los módulos de src/ no se
 * auto-ejecutan al ser importados (en un binario compilado import.meta.url
 * no distingue módulos, y todos parecerían el punto de entrada).
 */
process.env.MCP_MYSQL_ENTRY = "bin";

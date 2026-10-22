import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ¿Este módulo se está ejecutando directamente (node src/x.js)?
 * En un binario compilado devuelve false: los comandos se invocan desde el CLI.
 */
export function esEntrada(urlModulo) {
  if (process.env.MCP_MYSQL_ENTRY === "bin") return false;

  const entrada = process.argv[1];
  if (!entrada) return false;
  try {
    return path.resolve(entrada) === fileURLToPath(urlModulo);
  } catch {
    return false;
  }
}

/** Ejecuta una tarea de CLI y traduce el error a código de salida. */
export async function arrancar(tarea) {
  try {
    await tarea();
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}

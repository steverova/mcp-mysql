#!/usr/bin/env node
/**
 * Compila el CLI como binario único con Bun.
 *
 *   node scripts/build.mjs              → solo la plataforma actual
 *   node scripts/build.mjs --all        → Windows, Linux y macOS
 *   node scripts/build.mjs --target=bun-linux-x64
 *
 * Los binarios quedan en dist/ (ignorado por git: se adjuntan a un release).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRADA = path.join(RAIZ, "bin", "mysql-mcp.js");
const SALIDA = path.join(RAIZ, "dist");

const TODOS = {
  windows: { target: "bun-windows-x64", nombre: "mysql-mcp-windows-x64.exe" },
  linux: { target: "bun-linux-x64", nombre: "mysql-mcp-linux-x64" },
  "darwin-arm64": { target: "bun-darwin-arm64", nombre: "mysql-mcp-darwin-arm64" },
  "darwin-x64": { target: "bun-darwin-x64", nombre: "mysql-mcp-darwin-x64" },
};

const actual =
  process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64"
      : "linux";

const argumentos = process.argv.slice(2);
const pedido = argumentos.find((a) => a.startsWith("--target="));

let objetivos;
if (pedido) {
  const target = pedido.split("=")[1];
  const encontrado = Object.values(TODOS).find((o) => o.target === target);
  if (!encontrado) {
    console.error(`Target desconocido: ${target}`);
    console.error(`Válidos: ${Object.values(TODOS).map((o) => o.target).join(", ")}`);
    process.exit(1);
  }
  objetivos = [encontrado];
} else if (argumentos.includes("--all")) {
  objetivos = Object.values(TODOS);
} else {
  objetivos = [TODOS[actual]];
}

try {
  const version = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error("bun no está instalado");
  console.log(`bun ${version.stdout.trim()}`);
} catch {
  console.error("Se necesita Bun para compilar: https://bun.sh");
  process.exit(1);
}

fs.mkdirSync(SALIDA, { recursive: true });

const versionPaquete = JSON.parse(
  fs.readFileSync(path.join(RAIZ, "package.json"), "utf8").replace(/^\uFEFF/, ""),
).version;
console.log(`mcp-mysql v${versionPaquete} → ${objetivos.length} binario(s)\n`);

let fallos = 0;

for (const { target, nombre } of objetivos) {
  const destino = path.join(SALIDA, nombre);
  console.log(`→ ${nombre}  (${target})`);

  const resultado = spawnSync(
    "bun",
    ["build", ENTRADA, "--compile", "--target", target, "--outfile", destino],
    { cwd: RAIZ, stdio: "inherit" },
  );

  if (resultado.status !== 0) {
    console.error(`  FALLO al compilar ${nombre}`);
    fallos++;
    continue;
  }

  const { size } = fs.statSync(destino);
  console.log(`  OK  ${(size / 1024 / 1024).toFixed(1)} MB\n`);
}

if (fallos) {
  console.error(`${fallos} binario(s) fallidos`);
  process.exit(1);
}
console.log(`Binarios en ${SALIDA}`);

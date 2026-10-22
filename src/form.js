#!/usr/bin/env node
/**
 * Abre el formulario de conexiones sin pasar por OpenCode.
 * Útil cuando el agente no está disponible o tras un reinicio.
 *
 *   npm run form
 */
import { abrirFormulario } from "./webform.js";
import { loadStore, storePath } from "./store.js";

const store = loadStore();
const existentes = Object.keys(store.connections);

let alGuardar;
const espera = new Promise((resolve) => {
  alGuardar = resolve;
});

console.log(`Archivo: ${storePath()}`);
if (existentes.length) console.log(`Guardadas: ${existentes.join(", ")}`);
console.log("");

const formulario = await abrirFormulario({
  conexiones: existentes,
  prefill: { nombre: process.env.MCP_MYSQL_DEFAULT_NAME || store.active || "" },
  onDone: (resultado) => alGuardar(resultado),
});

console.log(`Formulario: ${formulario.url}`);
if (!formulario.navegador_abierto) {
  console.log("Abre esa URL en el navegador (no se pudo abrir automáticamente).");
}
console.log("Esperando a que guardes… (Ctrl+C para cancelar)");
console.log("");

const resultado = await espera;

if (resultado.ok) {
  const credenciales = resultado.credentials;
  console.log(`Guardada "${resultado.nombre}": ${credenciales.user}@${credenciales.host}:${credenciales.port}/${credenciales.database || "(sin base)"}`);
  process.exit(0);
}

console.log("Cerrado sin guardar.");
process.exit(1);

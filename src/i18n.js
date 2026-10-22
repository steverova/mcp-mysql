/**
 * i18n: the language comes from the system; texts live in locales/<language>.json.
 *
 * Priority:
 *   1. MCP_MYSQL_LANG=es|en
 *   2. LC_ALL / LC_MESSAGES / LANG / LANGUAGE
 *   3. The OS regional settings (Intl)
 *   4. English
 */
import es from "./locales/es.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };

const DICTIONARIES = { es, en };

function detectar() {
  const forzado = (process.env.MCP_MYSQL_LANG || "").trim().toLowerCase();
  if (forzado === "es" || forzado === "en") return forzado;

  for (const value of [
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    process.env.LANGUAGE,
    process.env.LC_CTYPE,
  ]) {
    if (!value) continue;
    const base = String(value).toLowerCase().split(/[.:_-]/)[0];
    if (base === "es") return "es";
    if (base === "en") return "en";
  }

  try {
    const base = (Intl.DateTimeFormat().resolvedOptions().locale || "").toLowerCase().split("-")[0];
    if (base === "es") return "es";
    if (base === "en") return "en";
  } catch {
    // No Intl available: use the default.
  }

  return "en";
}

export const LANGUAGE = detectar();
export const currentLanguage = () => LANGUAGE;

/**
 * Translates a key. Parameters are interpolated with {name}.
 * If the key is missing in the active language, Spanish is used and, if missing too,
 * the key itself is returned (visible in development, never breaks).
 */
export function t(key, params = {}) {
  const dictionary = DICTIONARIES[LANGUAGE] || DICTIONARIES.en;
  const texto = dictionary[key] ?? DICTIONARIES.es[key] ?? key;

  return String(texto).replace(/\{(\w+)\}/g, (coincidencia, name) =>
    params[name] !== undefined ? String(params[name]) : coincidencia,
  );
}

/**
 * SQL text utilities that respect string literals and quoted identifiers.
 *
 * Why this file exists: MySQL lets a `;`, a `--`, a `#` or a `/*` live inside
 * a string. A naive regex splits `SELECT 'a;b'` in two or eats `'hola--mundo'`
 * as a comment. Everything here walks the text once, character by character,
 * and never reads the inside of `'...'`, `"..."` or `` `...` `` as SQL.
 *
 * Notes:
 *  - MySQL comments: `-- ` (dash dash + space/control), `# ...` and `/* ... *\/`.
 *  - Version comments `/*! ... *\/` are executable, so they are preserved.
 *  - Escapes inside literals: backslash (`\'`) and doubled quote (`''`).
 *    Backticks only use the doubled form.
 */

const QUOTES = new Set(["'", '"', "`"]);

/** Copies a quoted run starting at `start`; returns the index after it. */
function copyQuoted(text, start, write) {
  const quote = text[start];
  write(quote);
  let i = start + 1;
  while (i < text.length) {
    const character = text[i];
    if (character === "\\" && quote !== "`") {
      // Escape sequence: copy both characters, never interpret them.
      write(character);
      if (i + 1 < text.length) write(text[i + 1]);
      i += 2;
      continue;
    }
    if (character === quote) {
      if (text[i + 1] === quote) {
        // Doubled quote inside the literal: the literal continues.
        write(character);
        write(character);
        i += 2;
        continue;
      }
      write(character);
      return i + 1;
    }
    write(character);
    i++;
  }
  return i;
}

/**
 * Removes comments, keeping literals byte for byte.
 * `--` only starts a comment when followed by whitespace, exactly like MySQL.
 */
export function stripComments(sql) {
  const text = String(sql ?? "");
  let out = "";
  let i = 0;

  while (i < text.length) {
    const character = text[i];

    if (QUOTES.has(character)) {
      i = copyQuoted(text, i, (piece) => {
        out += piece;
      });
      continue;
    }

    if (character === "-" && text[i + 1] === "-") {
      const next = text[i + 2];
      if (next === undefined || /\s/.test(next)) {
        while (i < text.length && text[i] !== "\n") i++;
        out += " ";
        continue;
      }
    }

    if (character === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      out += " ";
      continue;
    }

    if (character === "/" && text[i + 1] === "*") {
      // `/*! ... */` is executable MySQL code, not a comment.
      if (text[i + 2] === "!") {
        out += character;
        i++;
        continue;
      }
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }

    out += character;
    i++;
  }

  return out;
}

/**
 * Replaces the *content* of every literal/identifier with nothing, keeping the
 * quotes: `SELECT 'insert' FROM t` -> `SELECT '' FROM t`.
 * Used for keyword detection so a literal cannot impersonate SQL.
 */
export function maskLiterals(sql) {
  const text = String(sql ?? "");
  let out = "";
  let i = 0;

  while (i < text.length) {
    const character = text[i];
    if (QUOTES.has(character)) {
      const quote = character;
      out += quote;
      i++;
      while (i < text.length) {
        const inside = text[i];
        if (inside === "\\" && quote !== "`") {
          i += 2;
          continue;
        }
        if (inside === quote) {
          if (text[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += quote;
      continue;
    }
    out += character;
    i++;
  }

  return out;
}

/**
 * Splits a script at top-level semicolons. Literals and comments are skipped,
 * so `SELECT 'a;b'` is ONE statement and `SELECT 1; SELECT 2` is two.
 */
export function splitStatements(sql) {
  const text = stripComments(sql);
  const parts = [];
  let current = "";
  let i = 0;

  while (i < text.length) {
    const character = text[i];

    if (QUOTES.has(character)) {
      i = copyQuoted(text, i, (piece) => {
        current += piece;
      });
      continue;
    }

    if (character === ";") {
      parts.push(current);
      current = "";
      i++;
      continue;
    }

    current += character;
    i++;
  }

  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Canonical form used for the confirmation hash and for showing the statement
 * to the user: comments removed, runs of whitespace collapsed **outside**
 * literals, one trailing semicolon dropped. Literal content is untouched, so
 * `'uno  dos'` and `'uno dos'` remain different statements.
 */
export function normalizeSql(sql) {
  const text = stripComments(sql);
  let out = "";
  let i = 0;

  while (i < text.length) {
    const character = text[i];

    if (QUOTES.has(character)) {
      i = copyQuoted(text, i, (piece) => {
        out += piece;
      });
      continue;
    }

    if (/\s/.test(character)) {
      while (i < text.length && /\s/.test(text[i])) i++;
      out += " ";
      continue;
    }

    out += character;
    i++;
  }

  let normalized = out.trim();
  while (normalized.endsWith(";")) normalized = normalized.slice(0, -1).trimEnd();
  return normalized;
}

/** Identifier quoting for building `SHOW CREATE ...` safely. */
export function quoteIdentifier(name) {
  return "`" + String(name ?? "").replace(/`/g, "``") + "`";
}

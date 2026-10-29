/**
 * Statement classification test: reads, writes and stored routines.
 *
 *   npm run test:classify
 *
 * The interesting case is `CREATE PROCEDURE ... BEGIN ... END`: it is ONE
 * statement but needs internal semicolons, so it must be allowed while
 * chained statements (`... END; DROP TABLE x`) must still be rejected.
 */
process.env.MCP_MYSQL_LANG = "en";
process.env.MCP_MYSQL_STORE = "";

const { classify, isRoutineDefinition } = await import("../src/index.js");
const { normalizeSql } = await import("../src/sqltext.js");

let failures = 0;
const check = (name, fn, expected) => {
  let result;
  let error = null;
  try {
    result = fn();
  } catch (caught) {
    error = caught;
  }
  const ok = expected === "throw" ? Boolean(error) : result === expected;
  const detail = error ? `threw: ${error.message}` : `got: ${result}`;
  console.log(`${ok ? "OK   " : "FAIL"} ${name}${ok ? "" : ` -> ${detail}`}`);
  if (!ok) failures++;
};

const PROCEDURE = `CREATE DEFINER = 'admin'@'%' PROCEDURE ladmar_F1.SP_DEMO(
    IN p_id INT,
    OUT p_total INT
)
BEGIN
    DECLARE v_points INT DEFAULT 0;

    SELECT points INTO v_points FROM tb_game_sessions WHERE id_session = p_id;
    SET p_total = v_points + 1;
END`;

check("SELECT is a read", () => classify("SELECT 1"), "read");
check("WITH ... SELECT is a read", () => classify("WITH x AS (SELECT 1) SELECT * FROM x"), "read");
check("UPDATE is a write", () => classify("UPDATE t SET a = 1 WHERE id = 2"), "write");

check("CREATE PROCEDURE with BEGIN...END is a write", () => classify(PROCEDURE), "write");
check("...with trailing semicolon is a write", () => classify(`${PROCEDURE};`), "write");
check("...with CLI-style double semicolon is a write", () => classify(`${PROCEDURE};;`), "write");
check(
  "single-statement procedure is a write",
  () => classify("CREATE PROCEDURE p() SELECT 1"),
  "write",
);
check(
  "trigger with BEGIN...END is a write",
  () =>
    classify(
      "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END",
    ),
  "write",
);
check(
  "function with DEFINER is a write",
  () => classify("CREATE DEFINER=CURRENT_USER FUNCTION f() RETURNS INT BEGIN RETURN 1; END"),
  "write",
);

check("chained statement after END is rejected", () => classify(`${PROCEDURE}; DROP TABLE x`), "throw");
check("DROP after END with trailing ; is rejected", () => classify(`${PROCEDURE}; DROP TABLE x;`), "throw");
check("two plain statements are rejected", () => classify("UPDATE t SET a = 1; DELETE FROM t"), "throw");
check("routine without END is rejected", () => classify("CREATE PROCEDURE p() BEGIN SET @a = 1;"), "throw");
check("payload is not a routine", () => classify("CREATE TABLE x (a INT); DROP TABLE y"), "throw");
check("SET is still not allowed", () => classify("SET NAMES utf8mb4"), "throw");

// Literales: un `;` o un comentario dentro de una cadena no es SQL.
check("semicolon inside a literal is a read", () => classify("SELECT 'a;b' AS texto"), "read");
check("comment marker inside a literal is a read", () => classify("SELECT 'hola--mundo'"), "read");
check("write with a semicolon in a literal", () => classify("UPDATE t SET a = 'x;y' WHERE id = 1"), "write");
check("literal containing 'insert' is still a read", () => classify("SELECT 'insert into t values (1)'"), "read");
check("FOR UPDATE is still rejected", () => classify("SELECT * FROM t FOR UPDATE"), "throw");
check("procedure whose body has a literal with ';' is a write", () => classify("CREATE PROCEDURE p() SELECT 'a;b'"), "write");

// CALL: se ejecuta con confirmación, así que cuenta como escritura.
check("CALL is a write", () => classify("CALL sp_demo(1, @total)"), "write");
check("CALL is not a read", () => classify("CALL sp_demo()") !== "read", true);

// normalizeSql: la huella no puede ignorar el contenido de los literales.
check("hash keeps literal whitespace", () => normalizeSql("INSERT INTO t VALUES ('a    b')"), "INSERT INTO t VALUES ('a    b')");
check(
  "hash still collapses whitespace outside literals",
  () => normalizeSql("SELECT   1,\n 2"),
  "SELECT 1, 2",
);
check(
  "hash drops comments but keeps literals",
  () => normalizeSql("SELECT /* x */ 1 -- fin\n FROM t"),
  "SELECT 1 FROM t",
);

check(
  "isRoutineDefinition: procedure body",
  () => isRoutineDefinition(PROCEDURE),
  true,
);
check(
  "isRoutineDefinition: plain create table",
  () => isRoutineDefinition("CREATE TABLE t (a INT)"),
  false,
);

console.log(failures === 0 ? "\nAll classify tests passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);

import fs from "node:fs";
const rep=(f,pairs)=>{let s=fs.readFileSync(f,"utf8");for(const [a,b] of pairs){if(!s.includes(a))console.log("NO:",f,a.slice(0,50));s=s.split(a).join(b);}fs.writeFileSync(f,s,"utf8");};
rep("src/index.js",[
 ["SELECT VERSION() AS version, DATABASE() AS database, CURRENT_USER() AS user, @@hostname AS host, @@port AS port",
  "SELECT VERSION() AS version, DATABASE() AS currentDatabase, CURRENT_USER() AS dbUser, @@hostname AS host, @@port AS port"],
 ["SELECT table_schema AS schema, table_name AS table, table_type AS type,\n              engine AS engine, table_rows AS approxRows",
  "SELECT table_schema AS dbSchema, table_name AS dbTable, table_type AS dbType,\n              engine AS engine, table_rows AS approxRows"],
 ["SELECT column_name AS columna, column_type AS type, is_nullable AS nulo,\n              column_default AS por_defecto, column_key AS key, extra AS extra",
  "SELECT column_name AS dbColumn, column_type AS dbType, is_nullable AS nullable,\n              column_default AS defaultValue, column_key AS dbKey, extra AS extra"],
 ["SELECT index_name AS indice, non_unique AS no_unico, seq_in_index AS posicion,\n              column_name AS columna, index_type AS type",
  "SELECT index_name AS dbIndex, non_unique AS notUnique, seq_in_index AS position,\n              column_name AS dbColumn, index_type AS dbType"],
 ["constraint_name AS restriccion, column_name AS columna,","constraint_name AS dbConstraint, column_name AS dbColumn,"],
]);
rep("src/doctor.js",[
 ["SELECT VERSION() AS version, DATABASE() AS base, CURRENT_USER() AS user","SELECT VERSION() AS version, DATABASE() AS currentDatabase, CURRENT_USER() AS dbUser"],
 ["SELECT table_schema AS schema, COUNT(*) AS total","SELECT table_schema AS dbSchema, COUNT(*) AS total"],
 ["info.base","info.currentDatabase"],
 ["fila.schema","fila.dbSchema"],
]);
console.log("SQL corregido");

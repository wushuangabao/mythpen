const fs = require('node:fs');
const path = require('node:path');

const { openControlStore } = require('../../control-store');
const { createAtomicStore } = require('../../sqljs-atomic-store');
const { CRASH_ARTIFACTS_PATH_ENV } = require('../../testing/fault-injection');
const { getWasmBinary } = require('../../wasm-binary');

async function main() {
  const root = process.env.MYTHPEN_ATOMIC_STORE_CRASH_ROOT;
  const artifactsPath = process.env[CRASH_ARTIFACTS_PATH_ENV];
  if (!root) throw new Error('MYTHPEN_ATOMIC_STORE_CRASH_ROOT is required');
  if (!artifactsPath) throw new Error(`${CRASH_ARTIFACTS_PATH_ENV} is required`);

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const dbPath = path.join(root, 'project.mythpen.db');
  const controlDir = path.join(root, 'control');
  const beforePath = path.join(root, 'expected-before.db');
  const afterPath = path.join(root, 'expected-after.db');

  const seed = new SQL.Database();
  seed.run('PRAGMA foreign_keys = ON');
  seed.run('CREATE TABLE parents (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  seed.run('CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id))');
  seed.run("INSERT INTO parents (id, value) VALUES (1, 'before')");
  const beforeBytes = Buffer.from(seed.export());
  seed.run('PRAGMA foreign_keys = ON');
  seed.close();
  fs.writeFileSync(dbPath, beforeBytes);
  fs.writeFileSync(beforePath, beforeBytes);

  const store = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const database = store.currentConnection();
  database.run("UPDATE parents SET value = 'after' WHERE id = 1");
  database.run('INSERT INTO children (id, parent_id) VALUES (1, 1)');
  const afterBytes = Buffer.from(database.export());
  database.run('PRAGMA foreign_keys = ON');
  fs.writeFileSync(afterPath, afterBytes);
  fs.writeFileSync(artifactsPath, JSON.stringify({
    afterPath,
    beforePath,
    controlDir,
    dbPath,
  }));

  store.publish(database);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

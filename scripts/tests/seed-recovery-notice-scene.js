const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const db = require('../../server/db');
const { openControlStore } = require('../../server/control-store');
const { createAtomicStore, canonicalDatabasePath } = require('../../server/sqljs-atomic-store');
const { FAULT_POINTS, withFaults } = require('../../server/testing/fault-injection');
const { getWasmBinary } = require('../../server/wasm-binary');
const { assertDurabilitySupported, detectCapabilities } = require('../../server/platform/durability');

const projectName = 'recovery-notice-e2e';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function main() {
  const dataDir = process.env.MYTHPEN_DATA_DIR;
  assert.ok(dataDir, 'MYTHPEN_DATA_DIR is required');

  db.configureStorage({ dataDir });
  db.configureRecoveryDiagnosticsCapabilities(assertDurabilitySupported(detectCapabilities()));
  await db.initDatabase();

  const projectDb = db.createProjectDb(projectName);
  projectDb.prepare("INSERT OR REPLACE INTO project_meta (key, value) VALUES ('recovery_notice_marker', 'before')").run();
  projectDb.prepare("INSERT OR IGNORE INTO volumes (id, sort_order, title, summary) VALUES (1, 1, 'Recovery volume', '')").run();
  const projectPath = db.getProjectDbPath(projectName);
  projectDb.flush();
  db.dbExecute(
    'INSERT OR REPLACE INTO recent_projects (id, name, file_path, last_opened, word_count) VALUES (?, ?, ?, ?, ?)',
    [projectName, projectName, projectPath, new Date(0).toISOString(), 0],
  );
  db.getConfigDb().flush();
  db.closeProjectDb(projectPath);

  const dbKey = sha256(Buffer.from(canonicalDatabasePath(projectPath), 'utf8'));
  const controlDir = path.join(dataDir, 'control', 'sqlite', dbKey);
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const controlStore = openControlStore(controlDir);
  const store = createAtomicStore({ filePath: projectPath, controlStore, sqlModule: SQL });
  const connection = store.currentConnection();
  connection.run("UPDATE project_meta SET value = 'after' WHERE key = 'recovery_notice_marker'");
  await withFaults(
    { [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_REPLACE]: { throw: 'RECOVERY_NOTICE_SCENE' } },
    () => assert.throws(() => store.publish(connection), { code: 'RECOVERY_NOTICE_SCENE' }),
  );
  const prepared = controlStore.tail();
  assert.equal(prepared.type, 'sqlite.publish.prepared');
  store.close();

  db.inspectProjectDatabasesAtStartup();
  assert.equal(db.getProjectOpenState(projectPath)?.openState, 'isolated');
  const diagnostics = db.inspectRegisteredProject(projectName);
  assert.equal(diagnostics.reasonCode, 'V1_PUBLICATION_FORWARD_RECOVERABLE');
  assert.equal(diagnostics.recommendedAction, 'recover_v1_publication');

  process.stdout.write(`MYTHPEN_RECOVERY_NOTICE_SCENE ${JSON.stringify({
    controlDir,
    lockRoot: path.join(dataDir, 'locks'),
    projectName,
    projectPath,
    reasonCode: diagnostics.reasonCode,
  })}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      db.closeAllDatabases();
    } catch {
      // The caller owns the isolated scene and will remove it after the product run.
    }
  });

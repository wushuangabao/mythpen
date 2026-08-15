const fs = require('node:fs');

const { openControlStore } = require('../../control-store');
const { createProjectWriteCoordinator } = require('../../project-write-coordinator');
const { createAtomicStore } = require('../../sqljs-atomic-store');
const { CRASH_ARTIFACTS_PATH_ENV } = require('../../testing/fault-injection');
const { getWasmBinary } = require('../../wasm-binary');

const lockRoot = process.env.MYTHPEN_PROJECT_WRITE_LOCK_ROOT;
const controlDir = process.env.MYTHPEN_PROJECT_WRITE_CONTROL_DIR;
const projectPath = process.env.MYTHPEN_PROJECT_WRITE_DB_PATH;
if (!lockRoot || !controlDir || !projectPath) {
  throw new Error('project write crash fixture paths are required');
}

async function main() {
  fs.writeFileSync(
    process.env[CRASH_ARTIFACTS_PATH_ENV],
    JSON.stringify({ controlDir, lockRoot, projectPath }),
  );
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  let coordinator;
  let enforceLease = false;
  const store = createAtomicStore({
    assertWriterLease() {
      if (enforceLease) coordinator.assertProjectWriteLease(projectPath);
    },
    filePath: projectPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  coordinator = createProjectWriteCoordinator({
    lockRoot,
    recoverProject: () => store.recover(),
  });
  enforceLease = true;
  await coordinator.withProjectWrite(projectPath, () => {
    const connection = store.currentConnection();
    connection.run("UPDATE entries SET value = 'after' WHERE id = 1");
    store.publish(connection);
  });
  throw new Error('configured crash point was not reached');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

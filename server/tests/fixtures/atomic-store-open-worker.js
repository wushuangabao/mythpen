const path = require('node:path');

const { openControlStore } = require('../../control-store');
const { createAtomicStore } = require('../../sqljs-atomic-store');
const { getWasmBinary } = require('../../wasm-binary');

async function main() {
  const [, , filePath, controlDirectory] = process.argv;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  let store;
  try {
    store = createAtomicStore({
      filePath: path.resolve(filePath),
      controlStore: openControlStore(path.resolve(controlDirectory)),
      sqlModule: SQL,
    });
    process.stdout.write(`${JSON.stringify({ status: 'opened' })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ code: error?.code, status: 'rejected' })}\n`);
  } finally {
    store?.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

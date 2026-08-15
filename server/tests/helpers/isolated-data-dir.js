const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../../db');

function withIsolatedDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-test-'));
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;

  process.env.MYTHPEN_DATA_DIR = dataDir;
  db.configureStorage();

  t.after(() => {
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
    db.configureStorage();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  return { dataDir };
}

module.exports = { withIsolatedDataDir };

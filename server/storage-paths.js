const os = require('node:os');
const path = require('node:path');
const { createPathStore } = require('./path-store');

const DATA_DIR_ENV = 'MYTHPEN_DATA_DIR';
const EXPORT_DIR_ENV = 'MYTHPEN_EXPORT_DIR';
const DATA_DIR_VALUE = 'DataDir';
const EXPORT_DIR_VALUE = 'ExportDir';

function resolveStoragePaths(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const store = options.store || createPathStore();
  const dataDir = path.resolve(
    env[DATA_DIR_ENV] || store.get(DATA_DIR_VALUE) || path.join(homeDir, '.mythpen'),
  );
  const exportDir = path.resolve(
    env[EXPORT_DIR_ENV] || store.get(EXPORT_DIR_VALUE) || path.join(dataDir, 'exports'),
  );
  return {
    dataDir,
    configDbPath: path.join(dataDir, 'config.db'),
    projectsDir: path.join(dataDir, 'projects'),
    exportDir,
  };
}

module.exports = {
  DATA_DIR_ENV,
  EXPORT_DIR_ENV,
  DATA_DIR_VALUE,
  EXPORT_DIR_VALUE,
  resolveStoragePaths,
};

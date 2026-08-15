const { AsyncLocalStorage } = require('node:async_hooks');

const databaseInternals = require('../database-internals');
const testManuscriptContext = new AsyncLocalStorage();
const testManuscriptAuthorities = new WeakSet();

function isThenable(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function withTestManuscriptBootstrap(callback) {
  if (typeof callback !== 'function') throw new TypeError('Test manuscript bootstrap requires a callback');
  const authority = { active: true };
  testManuscriptAuthorities.add(authority);
  let result;
  try {
    result = testManuscriptContext.run(authority, callback);
  } finally {
    authority.active = false;
  }
  if (isThenable(result)) {
    void Promise.resolve(result).catch(() => {});
    const error = new TypeError('Test manuscript bootstrap callbacks must be synchronous');
    error.code = 'TEST_MANUSCRIPT_ASYNC_CALLBACK';
    throw error;
  }
  return result;
}

function isActive() {
  const authority = testManuscriptContext.getStore();
  return Boolean(authority?.active && testManuscriptAuthorities.has(authority));
}

databaseInternals.registerTestManuscriptBootstrapProvider(isActive);

module.exports = {
  databaseInternals: databaseInternals.databaseInternals,
  isTestManuscriptBootstrapActive: databaseInternals.isTestManuscriptBootstrapActive,
  projectWriteDiagnostics: databaseInternals.projectWriteDiagnostics,
  registerDatabaseInternals: databaseInternals.registerDatabaseInternals,
  registerProjectWriteDiagnostics: databaseInternals.registerProjectWriteDiagnostics,
  withTestManuscriptBootstrap,
};

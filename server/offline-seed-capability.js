const { AsyncLocalStorage } = require('node:async_hooks');

const context = new AsyncLocalStorage();
const authorities = new WeakSet();

function isThenable(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function withOfflineSeedBootstrap(callback) {
  if (typeof callback !== 'function') throw new TypeError('Offline seed bootstrap requires a callback');
  const authority = { active: true };
  authorities.add(authority);
  let result;
  try {
    result = context.run(authority, callback);
  } finally {
    authority.active = false;
  }
  if (isThenable(result)) {
    void Promise.resolve(result).catch(() => {});
    const error = new TypeError('Offline seed bootstrap callbacks must be synchronous');
    error.code = 'OFFLINE_SEED_ASYNC_CALLBACK';
    throw error;
  }
  return result;
}

function isOfflineSeedBootstrapActive() {
  const authority = context.getStore();
  return Boolean(authority?.active && authorities.has(authority));
}

module.exports = Object.freeze({
  isOfflineSeedBootstrapActive,
  withOfflineSeedBootstrap,
});

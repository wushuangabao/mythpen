const fs = require('node:fs');
const path = require('node:path');

function stale(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'NATIVE_DATABASE_IDENTITY_STALE';
  return error;
}

function decimalIdentity(stats) {
  return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
}

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function canonicalName(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function realpath(fsApi, value) {
  const implementation = fsApi.realpathSync?.native || fsApi.realpathSync;
  if (typeof implementation !== 'function') throw new TypeError('fsApi.realpathSync is required');
  return implementation.call(fsApi.realpathSync, value);
}

function assertNoReparseAncestor(fsApi, absolutePath) {
  const parsed = path.parse(absolutePath);
  const relative = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of relative) {
    current = path.join(current, part);
    const stats = fsApi.lstatSync(current, { bigint: true });
    if (stats.isSymbolicLink()) {
      throw stale(`Database path traverses a reparse or symbolic-link component: ${current}`);
    }
  }
}

function createDatabaseIdentityGuard({ databasePath, fsApi = fs } = {}) {
  if (typeof databasePath !== 'string' || databasePath.length === 0) {
    throw new TypeError('databasePath is required');
  }
  const requestedPath = path.resolve(databasePath);
  let descriptor;
  try {
    descriptor = fsApi.openSync(requestedPath, 'r');
    assertNoReparseAncestor(fsApi, requestedPath);
    const canonicalPath = realpath(fsApi, requestedPath);
    if (canonicalName(canonicalPath) !== canonicalName(requestedPath)) {
      throw stale('Database path must already be canonical and must not traverse a reparse point');
    }
    const handleStats = fsApi.fstatSync(descriptor, { bigint: true });
    const pathStats = fsApi.lstatSync(requestedPath, { bigint: true });
    if (
      !handleStats.isFile()
      || !pathStats.isFile()
      || pathStats.isSymbolicLink()
      || handleStats.nlink !== 1n
      || pathStats.nlink !== 1n
      || !sameIdentity(handleStats, pathStats)
    ) {
      throw stale('Database must be one single-link plain file with matching path and handle identity');
    }
    const identity = decimalIdentity(handleStats);
    let state = 'active';

    function assertCurrent() {
      if (state !== 'active') throw stale('Database identity epoch is no longer active');
      try {
        assertNoReparseAncestor(fsApi, requestedPath);
        if (canonicalName(realpath(fsApi, requestedPath)) !== canonicalName(canonicalPath)) {
          throw stale('Database canonical path changed');
        }
        const currentHandle = fsApi.fstatSync(descriptor, { bigint: true });
        const currentPath = fsApi.lstatSync(requestedPath, { bigint: true });
        if (
          !currentHandle.isFile()
          || !currentPath.isFile()
          || currentPath.isSymbolicLink()
          || currentHandle.nlink !== 1n
          || currentPath.nlink !== 1n
          || !sameIdentity(currentHandle, identity)
          || !sameIdentity(currentPath, identity)
        ) {
          throw stale('Database path, handle identity, or link count changed');
        }
        return true;
      } catch (error) {
        if (error?.code === 'NATIVE_DATABASE_IDENTITY_STALE') throw error;
        throw stale('Database identity can no longer be proven current', error);
      }
    }

    function close() {
      if (state === 'closed') return;
      if (state !== 'active') throw stale('Database identity guard disposition is unknown');
      try {
        fsApi.closeSync(descriptor);
        state = 'closed';
      } catch (error) {
        state = 'disposition_unknown';
        throw stale('Database identity handle close failed', error);
      }
    }

    return Object.freeze({ canonicalPath, identity, assertCurrent, close });
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fsApi.closeSync(descriptor);
      } catch {
        // Preserve the constructor failure; no facade has escaped yet.
      }
    }
    throw error;
  }
}

module.exports = { createDatabaseIdentityGuard };

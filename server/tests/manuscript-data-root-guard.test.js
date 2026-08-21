'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertNativeDataRootChangeAllowed,
  inspectCloudOrReparseRoot,
} = require('../manuscript/data-root-guard');

function unsupported(error, expectedDetails) {
  assert.equal(error?.code, 'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED');
  assert.equal(error.message, error.code);
  assert.equal(Object.isFrozen(error.details), true);
  assert.deepEqual(error.details, expectedDetails);
  return true;
}

test('data-root changes reject every file-authority route before any caller side effect', () => {
  for (const route of ['files', 'migrating', 'retired']) {
    let sideEffects = 0;
    assert.throws(
      () => {
        assertNativeDataRootChangeAllowed({ routes: ['sqlite', route], creationJournals: [] });
        sideEffects += 1;
      },
      (error) => unsupported(error, {
        reason: 'FILE_AUTHORITY_PROJECT_PRESENT',
        route,
      }),
    );
    assert.equal(sideEffects, 0);
  }
});

test('data-root changes reject a nonterminal creation journal and accept terminal-only state', () => {
  for (const state of [
    'file_publication_started',
    'completed',
    'creation_aborted',
    'unknown_future_state',
  ]) {
    assert.throws(
      () => assertNativeDataRootChangeAllowed({
        routes: ['sqlite'],
        creationJournals: [{ state }],
      }),
      (error) => unsupported(error, {
        reason: 'NONTERMINAL_PROJECT_CREATION_PRESENT',
        state,
      }),
    );
  }
  assert.deepEqual(
    assertNativeDataRootChangeAllowed({
      routes: ['sqlite'],
      creationJournals: [{ state: 'activated' }],
    }),
    Object.freeze({ allowed: true }),
  );
});

test('route snapshots do not invoke a poisoned array prototype', () => {
  const poisonError = new Error('poisoned Array.prototype.map must not run');
  let poisonCalls = 0;
  const poisonedPrototype = Object.create(Array.prototype);
  Object.defineProperty(poisonedPrototype, 'map', {
    configurable: false,
    get() {
      poisonCalls += 1;
      throw poisonError;
    },
  });
  const routes = ['sqlite'];
  Object.setPrototypeOf(routes, poisonedPrototype);

  assert.deepEqual(
    assertNativeDataRootChangeAllowed({ creationJournals: [], routes }),
    Object.freeze({ allowed: true }),
  );
  assert.equal(poisonCalls, 0);
});

test('creation journal snapshots reject sparse arrays without invoking prototype index getters', () => {
  let poisonCalls = 0;
  const poisonedPrototype = Object.create(Array.prototype);
  Object.defineProperty(poisonedPrototype, '0', {
    configurable: false,
    get() {
      poisonCalls += 1;
      return Object.freeze({ state: 'activated' });
    },
  });
  const creationJournals = new Array(1);
  Object.setPrototypeOf(creationJournals, poisonedPrototype);

  assert.throws(
    () => assertNativeDataRootChangeAllowed({
      creationJournals,
      routes: ['sqlite'],
    }),
    TypeError,
  );
  assert.equal(poisonCalls, 0);
});

test('cloud and reparse candidates return typed alternative-location diagnoses without mutation', (t) => {
  const oneDrive = inspectCloudOrReparseRoot('C:\\Users\\writer\\OneDrive\\Mythpen');
  assert.deepEqual(oneDrive, Object.freeze({
    allowed: false,
    alternative: 'LOCAL_NON_SYNCED_DIRECTORY',
    candidateRoot: 'C:\\Users\\writer\\OneDrive\\Mythpen',
    kind: 'ALTERNATIVE_LOCATION_REQUIRED',
    reason: 'ONEDRIVE',
  }));
  const iCloud = inspectCloudOrReparseRoot('C:\\Users\\writer\\iCloudDrive\\Mythpen');
  assert.equal(iCloud.kind, 'ALTERNATIVE_LOCATION_REQUIRED');
  assert.equal(iCloud.reason, 'ICLOUD');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-root-guard-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const target = path.join(root, 'target');
  const linked = path.join(root, 'linked');
  fs.mkdirSync(target);
  fs.symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const candidate = path.join(linked, 'Mythpen');
  const reparse = inspectCloudOrReparseRoot(candidate);
  assert.equal(reparse.kind, 'ALTERNATIVE_LOCATION_REQUIRED');
  assert.equal(reparse.reason, 'REPARSE');
  assert.equal(fs.existsSync(candidate), false);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('injected platform root evidence detects non-symlink reparse and custom cloud roots', () => {
  const calls = [];
  const reparse = inspectCloudOrReparseRoot(
    'C:\\LocalData\\Mythpen',
    Object.freeze({
      inspect(candidateRoot) {
        calls.push(candidateRoot);
        return Object.freeze({
          cloudProvider: null,
          isSymbolicLink: false,
          reparse: true,
        });
      },
    }),
  );
  assert.equal(reparse.kind, 'ALTERNATIVE_LOCATION_REQUIRED');
  assert.equal(reparse.reason, 'REPARSE');

  const customCloud = inspectCloudOrReparseRoot(
    'C:\\CorpSyncRoot\\Mythpen',
    Object.freeze({
      inspect(candidateRoot) {
        calls.push(candidateRoot);
        return Object.freeze({
          cloudProvider: 'CORP_SYNC',
          isSymbolicLink: false,
          reparse: false,
        });
      },
    }),
  );
  assert.equal(customCloud.kind, 'ALTERNATIVE_LOCATION_REQUIRED');
  assert.equal(customCloud.reason, 'CORP_SYNC');
  assert.deepEqual(calls, [
    'C:\\LocalData\\Mythpen',
    'C:\\CorpSyncRoot\\Mythpen',
  ]);
});

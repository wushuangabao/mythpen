const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const probe = require('../testing/windows-native-directory-probe');
const { WINDOWS_DIRECTORY_ENTRY_CRASH_CASES } = require('../platform/windows-native-directory-capability');

test('directory probe is a fixture-only compiled guest-local command contract', async () => {
  const build = await import('../../scripts/build-sidecars.mjs');
  const root = path.resolve(__dirname, '..', '..');
  const triple = 'x86_64-pc-windows-msvc';
  const probe = build.windowsNativeDirectoryProbeOutputPath(root, triple);
  assert.equal(path.dirname(probe), path.join(root, 'src-tauri', 'target', 'capability-probes'));
  assert.equal(path.basename(probe), `mythpen-native-directory-probe-${triple}.exe`);
  assert.deepEqual(
    build.compileWindowsNativeDirectoryProbeArguments(
      'server/testing/windows-native-directory-probe.js', probe, 'a'.repeat(40), triple,
    ).filter((value) => typeof value === 'string' && value.includes('NATIVE_ACTIVATION_MODE')),
    ['__MYTHPEN_NATIVE_ACTIVATION_MODE__="fixture_only"'],
  );
});

test('directory probe binds the queried guest volume sector instead of an allocation unit', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'testing', 'windows-native-directory-probe.js'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /bytesPerSector:\s*4096/,
    'the 4096-byte allocation unit cannot stand in for the real 512-byte sector',
  );

  const root = 'C:\\MythpenProbe\\runs\\mythpen-native-directory-vm-fc73ce56-c269-4000-b3fb-177b0f16d550';
  const queriedRoots = [];
  assert.deepEqual(probe.volumeBinding(root, {
    queryVolume(volumeRoot) {
      queriedRoots.push(volumeRoot);
      return { name: 'ntfs', bytesPerSector: 512 };
    },
  }), { name: 'NTFS', bytesPerSector: 512, rootKind: 'plain-directory' });
  assert.deepEqual(queriedRoots, ['C:\\']);
  assert.throws(
    () => probe.volumeBinding(root, { queryVolume: () => null }),
    /volume sector query is unavailable/i,
  );
  assert.throws(
    () => probe.volumeBinding(root, {
      queryVolume: () => ({ name: 'NTFS', bytesPerSector: 0 }),
    }),
    /invalid volume sector query result/i,
  );
});

test('directory probe reaches checkpoint and activation cuts only through official APIs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'testing', 'windows-native-directory-probe.js'), 'utf8');
  assert.match(source, /getBoundedControlStoreCheckpointController/);
  assert.match(source, /installCheckpoint/);
  assert.match(source, /activateNativeProjectCore/);
  assert.match(source, /createAtomicStore/);
  assert.doesNotMatch(source, /faultPoint\s*\(/);
  assert.doesNotMatch(source, /sqlite\.native\.activation\.prepared'.*payload:\s*\{\s*armId/);
});

test('directory probe preserves the five guestcontrol run-case slots for the real matrix arm id', () => {
  const argv = [
    'mythpen-native-directory-probe.exe', 'windows-native-directory-probe.js',
    'run-case', 'C:\\MythpenProbe\\runs\\mythpen-native-directory-vm-fc73ce56-c269-4000-b3fb-177b0f16d550',
    'generic-event-before-publish', 'fc73ce56-c269-4000-b3fb-177b0f16d550',
    'C:\\Mythpen-L1-Control\\directory-fc73ce56-c269-4000-b3fb-177b0f16d550',
  ];
  assert.deepEqual(probe.parseDirectoryProbeArguments(argv), {
    command: 'run-case',
    rootValue: argv[3],
    scenario: argv[4],
    armId: argv[5],
    controlDirectory: argv[6],
  });
  assert.equal(probe.parseDirectoryProbeArguments(argv.slice(0, -1)), null);
  assert.equal(probe.parseDirectoryProbeArguments([
    argv[0], argv[1], 'run-case', argv[3], argv[5], argv[4], argv[6],
  ]), null);
});

test('directory cold inspection ignores poisoned tested-root metadata and rejects invalid external control descriptors', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mythpen-directory-root-'));
  const controlDirectory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mythpen-directory-control-'));
  const armId = 'f5798c88-ada4-47a0-85dd-a1ed629c5ccb';
  const expected = {
    version: 1,
    type: 'windows.native.directory.arm.v1',
    root,
    armId,
    scenario: 'generic-event-before-publish',
    cut: 'controlstore.append.before-publish',
    binding: { binarySha256: 'a'.repeat(64) },
    externalVmResetVerified: false,
    capability: false,
  };
  try {
    fs.writeFileSync(path.join(root, `${armId}.run.json`), '\0poisoned tested-root descriptor', 'utf8');
    fs.writeFileSync(path.join(controlDirectory, `${armId}.arm.json`), JSON.stringify(expected), 'utf8');
    assert.deepEqual(probe.readDirectoryControlDescriptor(root, expected.scenario, armId, controlDirectory), expected);
    fs.unlinkSync(path.join(controlDirectory, `${armId}.arm.json`));
    assert.throws(() => probe.readDirectoryControlDescriptor(root, expected.scenario, armId, controlDirectory), /control descriptor/i);
    fs.writeFileSync(path.join(controlDirectory, `${armId}.arm.json`), JSON.stringify({ ...expected, scenario: 'retire-before-dir-fsync' }), 'utf8');
    assert.throws(() => probe.readDirectoryControlDescriptor(root, expected.scenario, armId, controlDirectory), /control descriptor/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(controlDirectory, { recursive: true, force: true });
  }
});

test('directory cold inspection has an exact control-plane argv and requires durable control writes', () => {
  const argv = [
    'mythpen-native-directory-probe.exe', 'windows-native-directory-probe.js', 'cold-inspect',
    'C:\\MythpenProbe\\runs\\mythpen-native-directory-vm-f5798c88-ada4-47a0-85dd-a1ed629c5ccb',
    'generic-event-before-publish', 'f5798c88-ada4-47a0-85dd-a1ed629c5ccb',
    'C:\\Mythpen-L1-Control\\directory-f5798c88-ada4-47a0-85dd-a1ed629c5ccb',
  ];
  assert.deepEqual(probe.parseDirectoryColdInspectionArguments(argv), {
    command: 'cold-inspect', rootValue: argv[3], scenario: argv[4], armId: argv[5], controlDirectory: argv[6],
  });
  assert.equal(probe.parseDirectoryColdInspectionArguments(argv.slice(0, -1)), null);
  assert.equal(probe.parseDirectoryColdInspectionArguments([
    argv[0], argv[1], 'cold-inspect', argv[3], argv[5], argv[4], argv[6],
  ]), null);
  const source = fs.readFileSync(path.join(__dirname, '..', 'testing', 'windows-native-directory-probe.js'), 'utf8');
  assert.match(source, /fs\.fsyncSync\(descriptor\)/);
  assert.match(source, /fsyncDirectory\(path\.dirname\(target\)\)/);
});

test('directory schema10 child frames require one canonical confined prefixed line', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mythpen-directory-schema10-'));
  const databasePath = path.join(root, 'projects', 'fixture.db');
  const prefix = 'MYTHPEN_NATIVE_DIRECTORY_SCHEMA10=';
  try {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, 'fixture');
    const frame = JSON.stringify({ databasePath });
    assert.equal(probe.parseSchema10SeedOutput(`DB initialization log\n${prefix}${frame}\nDB close log\n`, root), fs.realpathSync.native(databasePath));
    assert.throws(() => probe.parseSchema10SeedOutput(`${prefix}${frame}\n${prefix}${frame}\n`, root), /exactly one/i);
    assert.throws(() => probe.parseSchema10SeedOutput(`${prefix}${JSON.stringify({ databasePath, extra: true })}\n`, root), /canonical|exact/i);
    assert.throws(() => probe.parseSchema10SeedOutput(`${prefix}${JSON.stringify({ databasePath: path.join(root, '..', 'escape.db') })}\n`, root), /outside fixture root/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('directory retire cold recovery reopens the sole official candidate before inspection', () => {
  const { openControlStore, inspectControlStoreEvidence } = require('../control-store');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mythpen-directory-retire-'));
  const armId = '3a08be36-a209-435b-a781-0f7b7b4985fd';
  const seed = { type: 'directory.seed', payload: { armId } };
  try {
    const original = path.join(root, 'retire-control');
    const store = openControlStore(original);
    store.append(seed);

    const originalOnly = probe.recoverDirectoryRetireColdState(root, armId);
    assert.equal(originalOnly.directory, original);
    assert.deepEqual(originalOnly.events.map(({ type, payload }) => ({ type, payload })), [seed]);

    const retired = `${original}.retired-2f40b4ea-5dc1-4646-996b-d94a1941c8a3`;
    assert.equal(store.retire(retired, () => {}), retired);
    assert.throws(
      () => inspectControlStoreEvidence(retired),
      /active incarnation record cannot be read/i,
      'direct inspection must not bypass official retired-path lifecycle recovery',
    );

    const retiredOnly = probe.recoverDirectoryRetireColdState(root, armId);
    assert.equal(retiredOnly.directory, retired);
    assert.deepEqual(retiredOnly.events.map(({ type, payload }) => ({ type, payload })), [seed]);
    assert.equal(retiredOnly.secondReopenStable, true);

    fs.mkdirSync(original);
    fs.mkdirSync(`${original}.retired-40e5c2c8-a4c5-4697-b48b-313553f17cb1`);
    assert.throws(
      () => probe.recoverDirectoryRetireColdState(root, armId),
      /exactly one plain directory candidate/i,
      'an original plus retired candidates must not be hidden by original preference',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('directory compiled probe reaches real checkpoint and activation selectors only after official validation', { timeout: 40_000 }, async () => {
  const build = await import('../../scripts/build-sidecars.mjs');
  const compiled = build.buildWindowsNativeDirectoryProbe(path.resolve(__dirname, '..', '..'));
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mythpen-directory-checkpoint-'));
  try {
    for (const scenario of ['checkpoint-tail-before-publish', 'checkpoint-after-gc-old-checkpoint']) {
      const armId = scenario === 'checkpoint-tail-before-publish'
        ? 'eb1c2c2e-234c-4bce-a5ce-9ab615ad5a09'
        : '9b8cc871-4da1-4d5a-b95d-51a485de6180';
      const result = spawnSync(compiled.probe, [
        'checkpoint-self-test', path.join(root, scenario), scenario, armId,
      ], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        type: 'windows.native.directory.checkpoint-self-test.v1', scenario, armId, reached: true,
      });
    }
    for (const [scenario, armId, candidateType, selectorSeq, progressTerminalSeq, activationTypes] of [
      ['activation-prepared-before-publish', '13334a93-5bc6-422d-8b1f-881d168dd60b', 'sqlite.native.activation.prepared', 3, null, []],
      ['activation-activated-before-publish', 'b067869a-259a-4d03-ae23-2003c5c0fcd5', 'sqlite.native.activation.activated', 4, null, ['3:sqlite.native.activation.prepared']],
      ['activation-aborted-before-publish', '5a4b73f0-148f-47da-a5ec-6c7512369951', 'sqlite.native.activation.aborted', 6, 5, ['3:sqlite.native.activation.prepared']],
    ]) {
      const result = spawnSync(compiled.probe, [
        'activation-self-test', path.join(root, scenario), scenario, armId,
      ], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        type: 'windows.native.directory.activation-self-test.v1', scenario, armId, reached: true, candidateType,
        selectorSeq, evidenceTailSeq: selectorSeq - 1, progressTerminalSeq, activationTypes,
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('directory compiled probe cold-stops aborted activation rows before a new prepared candidate persists', { timeout: 45_000 }, async () => {
  const build = await import('../../scripts/build-sidecars.mjs');
  const compiled = build.buildWindowsNativeDirectoryProbe(path.resolve(__dirname, '..', '..'));
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mythpen-directory-cold-aborted-'));
  try {
    for (const [scenario, armId] of [
      ['activation-aborted-before-publish', '708b6cc0-f1d9-4b28-8f9a-86019f2b51d7'],
      ['activation-aborted-before-dir-fsync', '8ac73438-b85c-4e73-a38f-254169e0ad11'],
    ]) {
      const result = spawnSync(compiled.probe, [
        'activation-cold-self-test', path.join(root, scenario), scenario, armId,
      ], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        type: 'windows.native.directory.activation-cold-self-test.v1',
        scenario,
        armId,
        candidateType: 'sqlite.native.activation.prepared',
        candidateSeq: 7,
        activationTypes: [
          '3:sqlite.native.activation.prepared',
          '6:sqlite.native.activation.aborted',
        ],
        schemaVersion: 10,
        nativeStateAbsent: true,
        abortedCount: 1,
        activatedCount: 0,
        activationEvents: 2,
        secondReopenStable: true,
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

async function waitForArm(child, armPath, stderr, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(armPath)) return JSON.parse(fs.readFileSync(armPath, 'utf8'));
    if (child.exitCode !== null) {
      throw new Error(`probe exited before external arm: ${stderr.value}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for external arm');
}

async function terminateProbe(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('compiled Windows rollback probe runs a real transaction and remains armed for external reset', {
  skip: process.platform !== 'win32' ? 'Windows compiled capability probe' : false,
  timeout: 120_000,
}, async (t) => {
  const build = await import('../../scripts/build-sidecars.mjs');
  const repositoryRoot = path.resolve(__dirname, '..', '..');
  const compiled = build.buildWindowsNativeRollbackProbe(repositoryRoot);
  assert.equal(path.dirname(compiled.probe), path.join(repositoryRoot, 'src-tauri', 'target', 'capability-probes'));
  t.after(() => fs.rmSync(compiled.probe, { force: true }));

  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-native-rollback-vm-')),
  );
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const controlDir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-native-rollback-control-')),
  );
  t.after(() => fs.rmSync(controlDir, { force: true, recursive: true }));
  const armId = '123e4567-e89b-42d3-a456-426614174000';
  const cut = 'native.tx.after-commit-return';
  const armPath = path.join(controlDir, `${armId}.arm.json`);
  const stderr = { value: '' };
  const child = spawn(compiled.probe, ['run-transaction', root, cut, armId, controlDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr.value += chunk; });
  t.after(() => terminateProbe(child));

  const armed = await waitForArm(child, armPath, stderr);
  assert.equal(child.exitCode, null, stderr.value);
  assert.equal(armed.type, 'windows.native.rollback.arm.v2');
  assert.equal(armed.cut, cut);
  assert.equal(armed.armId, armId);
  assert.equal(armed.binding.sourceCommit, compiled.sourceCommit);
  assert.equal(armed.binding.targetTriple, compiled.triple);
  assert.equal(armed.binding.bunVersion, '1.3.14');
  assert.equal(
    armed.binding.binarySha256,
    createHash('sha256').update(fs.readFileSync(compiled.probe)).digest('hex'),
  );
  assert.equal(armed.binding.filesystem.name, 'NTFS');
  assert.ok(Number.isSafeInteger(armed.binding.filesystem.bytesPerSector));
  assert.ok(armed.binding.filesystem.bytesPerSector > 0);
  assert.deepEqual(armed.binding.pragmas, { journalMode: 'delete', synchronous: 3 });
  assert.equal(fs.existsSync(path.join(root, 'arm.json')), false);

  await terminateProbe(child);

  const inspect = spawnSync(compiled.probe, ['cold-inspect', root, armId], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout);
  const inspected = JSON.parse(inspect.stdout.trim());
  assert.equal(inspected.type, 'windows.native.rollback.cold-inspection.v2');
  assert.equal(inspected.armId, armId);
  assert.equal(inspected.cut, cut);
  assert.deepEqual(inspected.convergence, {
    outcome: 'after',
    finalSeq: 1,
    gateEmpty: true,
    sourceCount: 1,
    preparedCount: 1,
    terminalCount: 1,
    terminalType: 'sqlite.tx.committed',
  });
  assert.equal(inspected.externalVmResetVerified, false);
  assert.equal(inspected.capability, false);
});

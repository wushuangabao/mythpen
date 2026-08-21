'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { runUntilCrash } = require('../testing/crash-harness');

const FIXTURE = path.join(__dirname, 'fixtures', 'draft-conflict-crash.js');
const ROOT_ENV = 'MYTHPEN_DRAFT_CONFLICT_CRASH_ROOT';
const MODE_ENV = 'MYTHPEN_DRAFT_CONFLICT_CRASH_MODE';
const SCENARIO_ENV = 'MYTHPEN_DRAFT_CONFLICT_CRASH_SCENARIO';

const SCENARIOS = Object.freeze([
  Object.freeze({
    name: 'draft-file-fsync',
    point: 'draft-conflict.after-draft-file-fsync',
    state: 'conflict_detected',
    cleanup: 'removed',
  }),
  Object.freeze({
    name: 'external-file-fsync',
    point: 'draft-conflict.after-external-file-fsync',
    state: 'conflict_detected',
    cleanup: 'removed',
  }),
  Object.freeze({
    name: 'backup-parent-fsync',
    point: 'draft-conflict.after-backup-parent-fsync',
    state: 'decision_ready',
  }),
  Object.freeze({
    name: 'backup-durable',
    point: 'draft-conflict.after-backup-durable',
    state: 'decision_ready',
  }),
]);

for (const scenario of SCENARIOS) {
  test(`DraftConflictJournal crash recovery closes ${scenario.name}`, { concurrency: false }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `mythpen-draft-conflict-${scenario.name}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const crash = await runUntilCrash({
      script: FIXTURE,
      faults: { [scenario.point]: { crash: true } },
      env: {
        [ROOT_ENV]: root,
        [SCENARIO_ENV]: scenario.name,
      },
      timeoutMs: 20_000,
    });
    t.after(() => crash.cleanup());
    assert.equal(crash.crashPoint.name, scenario.point);

    const recovery = spawnSync(process.execPath, [FIXTURE], {
      encoding: 'utf8',
      env: {
        ...process.env,
        [ROOT_ENV]: root,
        [SCENARIO_ENV]: scenario.name,
        [MODE_ENV]: 'recover',
      },
      timeout: 20_000,
      windowsHide: true,
    });
    assert.equal(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
    const result = JSON.parse(fs.readFileSync(crash.artifacts.resultPath, 'utf8'));
    assert.equal(result.state, scenario.state);
    assert.equal(result.cleanup, scenario.cleanup);
    assert.equal(result.backupExists, scenario.cleanup !== 'removed');
    if (scenario.state === 'decision_ready') {
      assert.deepEqual(result.eventTypes.slice(-2), [
        'draft_conflict.backup_durable',
        'draft_conflict.decision_ready',
      ]);
    }
  });
}

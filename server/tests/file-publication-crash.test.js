'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { runUntilCrash } = require('../testing/crash-harness');
const { FAULT_POINTS } = require('../testing/fault-injection');

const FIXTURE = path.join(__dirname, 'fixtures', 'file-publication-crash.js');
const ROOT_ENV = 'MYTHPEN_FILE_PUBLICATION_CRASH_ROOT';
const SCENARIO_ENV = 'MYTHPEN_FILE_PUBLICATION_CRASH_SCENARIO';
const MODE_ENV = 'MYTHPEN_FILE_PUBLICATION_CRASH_MODE';

const SCENARIOS = Object.freeze([
  Object.freeze({
    name: 'assets-reserved',
    point: FAULT_POINTS.FILE_PUBLICATION_AFTER_ASSETS_RESERVED,
    finalBytes: 'before',
    projectionExists: false,
    residual: false,
  }),
  Object.freeze({
    name: 'asset-create-before-ready',
    point: FAULT_POINTS.FILE_PUBLICATION_AFTER_ASSET_CREATE,
    finalBytes: 'before',
    projectionExists: false,
    residual: true,
  }),
  Object.freeze({
    name: 'target-asset-create-before-ready',
    point: FAULT_POINTS.FILE_PUBLICATION_AFTER_TARGET_ASSET_CREATE,
    finalBytes: 'before',
    projectionExists: false,
    residual: true,
  }),
  Object.freeze({
    name: 'prepared',
    point: FAULT_POINTS.FILE_PUBLICATION_AFTER_PREPARED,
    finalBytes: 'after',
    projectionExists: true,
    residual: false,
  }),
  Object.freeze({
    name: 'no-replace-gap',
    point: FAULT_POINTS.FILE_PUBLICATION_AFTER_RELOCATE,
    recoveryRequired: true,
  }),
  Object.freeze({
    name: 'files-published',
    point: FAULT_POINTS.FILE_PUBLICATION_AFTER_FILES_PUBLISHED,
    finalBytes: 'after',
    projectionExists: true,
    residual: false,
  }),
  Object.freeze({
    name: 'projection-publish-before-terminal',
    point: FAULT_POINTS.FILE_PUBLICATION_AFTER_PROJECTION_PUBLISH,
    finalBytes: 'after',
    projectionExists: true,
    residual: false,
  }),
  Object.freeze({
    name: 'asset-delete-before-collected',
    point: FAULT_POINTS.FILE_PUBLICATION_AFTER_ASSET_DELETE,
    recoveryRequired: true,
  }),
]);

for (const scenario of SCENARIOS) {
  test(`Task 6 crash RED: ${scenario.name} recovers to one terminal scene`, { concurrency: false }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `mythpen-file-publication-${scenario.name}-`));
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
    assert.equal(crash.artifacts.scenario, scenario.name);

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
    if (scenario.recoveryRequired) {
      assert.equal(recovery.status, 2, `${recovery.stdout}\n${recovery.stderr}`);
      assert.match(recovery.stderr, /RECOVERY_REQUIRED/u);
      return;
    }
    assert.equal(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
    const result = JSON.parse(fs.readFileSync(crash.artifacts.resultPath, 'utf8'));
    assert.equal(result.state, 'assets_collected');
    assert.equal(result.finalBytes, scenario.finalBytes);
    assert.equal(result.projectionExists, scenario.projectionExists);
    assert.equal(result.eventTypes.at(-1), 'manuscript.file_publication.assets_collected');
    assert.equal(result.residuals.length > 0, scenario.residual);
  });
}

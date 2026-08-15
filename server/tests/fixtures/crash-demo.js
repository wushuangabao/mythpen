const copiedCrashMarkerToken = process.env.MYTHPEN_CRASH_MARKER_TOKEN;
const fs = require('node:fs');
const path = require('node:path');

const {
  CRASH_ARTIFACTS_PATH_ENV,
  CRASH_MARKER_PATH_ENV,
  FAULT_POINTS,
  faultPoint,
} = require('../../testing/fault-injection');

const artifactsPath = process.env[CRASH_ARTIFACTS_PATH_ENV];
if (!artifactsPath) throw new Error(`${CRASH_ARTIFACTS_PATH_ENV} is required`);

const sceneDir = path.dirname(artifactsPath);
const tempPath = path.join(sceneDir, 'candidate.tmp');
const targetPath = path.join(sceneDir, 'target.db');

fs.writeFileSync(tempPath, 'candidate');
fs.writeFileSync(
  artifactsPath,
  process.env.MYTHPEN_CRASH_DEMO_MALFORMED_ARTIFACTS
    ? '{malformed'
    : JSON.stringify({ tempPath, targetPath }),
);
if (process.env.MYTHPEN_CRASH_DEMO_PID_PATH) {
  fs.writeFileSync(process.env.MYTHPEN_CRASH_DEMO_PID_PATH, String(process.pid));
}
if (process.env.MYTHPEN_CRASH_DEMO_MALFORMED_MARKER) {
  fs.writeFileSync(process.env[CRASH_MARKER_PATH_ENV], '{malformed');
  process.exit(1);
}
if (process.env.MYTHPEN_CRASH_DEMO_FAKE_MARKER_EXIT_CODE) {
  let marker;
  if (process.env.MYTHPEN_CRASH_DEMO_FAKE_MARKER_SHAPE === 'array') {
    marker = [];
  } else {
    marker = {
      name: process.env.MYTHPEN_CRASH_DEMO_FAKE_MARKER_NAME
        || FAULT_POINTS.DEMO_AFTER_TEMP_WRITE,
      pid: process.pid + Number(process.env.MYTHPEN_CRASH_DEMO_FAKE_MARKER_PID_OFFSET || 0),
      signal: process.env.MYTHPEN_CRASH_DEMO_FAKE_MARKER_SIGNAL || 'SIGKILL',
      version: 1,
    };
    if (process.env.MYTHPEN_CRASH_DEMO_COPY_MARKER_TOKEN) {
      marker.token = copiedCrashMarkerToken;
    }
  }
  fs.writeFileSync(process.env[CRASH_MARKER_PATH_ENV], JSON.stringify(marker));
  process.exit(Number(process.env.MYTHPEN_CRASH_DEMO_FAKE_MARKER_EXIT_CODE));
}
if (process.env.MYTHPEN_CRASH_DEMO_EXIT_CODE) {
  process.exit(Number(process.env.MYTHPEN_CRASH_DEMO_EXIT_CODE));
}
if (process.env.MYTHPEN_CRASH_DEMO_DELAY_EXIT_MS) {
  setTimeout(
    () => process.exit(0),
    Number(process.env.MYTHPEN_CRASH_DEMO_DELAY_EXIT_MS),
  );
} else {
  let context = { tempPath, targetPath };
  if (process.env.MYTHPEN_CRASH_DEMO_CONTEXT_MODE === 'circular') {
    context = {};
    context.self = context;
  } else if (process.env.MYTHPEN_CRASH_DEMO_CONTEXT_MODE === 'bigint') {
    context = { value: 42n };
  }
  faultPoint(FAULT_POINTS.DEMO_AFTER_TEMP_WRITE, context);
  fs.renameSync(tempPath, targetPath);
}

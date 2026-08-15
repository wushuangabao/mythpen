const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CRASH_ARTIFACTS_PATH_ENV,
  CRASH_MARKER_PATH_ENV,
  CRASH_MARKER_TOKEN_ENV,
  CRASH_MARKER_VERSION,
  FAULT_MAP_ENV,
} = require('./fault-injection');

function parseCrashMarker(crashMarkerPath) {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(crashMarkerPath, 'utf8'));
  } catch (cause) {
    throw new Error('Invalid crash marker JSON', { cause });
  }

  if (
    marker === null
    || typeof marker !== 'object'
    || Array.isArray(marker)
    || marker.version !== CRASH_MARKER_VERSION
    || typeof marker.name !== 'string'
    || !Number.isSafeInteger(marker.pid)
    || marker.pid <= 0
    || typeof marker.signal !== 'string'
  ) {
    throw new Error('Invalid crash marker schema');
  }
  return marker;
}

function validateCrashProof({ childPid, faults, marker, markerToken, signal, status }) {
  const action = faults !== null
    && typeof faults === 'object'
    && Object.prototype.hasOwnProperty.call(faults, marker.name)
    ? faults[marker.name]
    : undefined;
  if (action === null || typeof action !== 'object' || action.crash !== true) {
    throw new Error(`Crash marker name is not a configured crash fault: ${marker.name}`);
  }
  if (marker.pid !== childPid) {
    throw new Error(`Crash marker pid ${marker.pid} does not match child pid ${childPid}`);
  }
  if (marker.signal !== 'SIGKILL') {
    throw new Error(`Crash marker signal must be SIGKILL, got ${marker.signal}`);
  }

  const rawExitMatches = process.platform === 'win32'
    ? status === 1 && signal === null
    : status === null && signal === 'SIGKILL';
  if (!rawExitMatches) {
    throw new Error(
      `Crash marker raw exit does not match ${process.platform} SIGKILL: status=${status} signal=${signal}`,
    );
  }
  if (marker.token !== markerToken) {
    throw new Error('Unauthentic crash marker token');
  }
}

function runUntilCrash({ script, faults, env = {}, timeoutMs = 10_000 }) {
  const scenePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-crash-'));
  const artifactsPath = path.join(scenePath, 'artifacts.json');
  const crashMarkerPath = path.join(scenePath, 'crash-marker.json');
  const markerToken = randomUUID();
  const cleanup = () => fs.rmSync(scenePath, { recursive: true, force: true });
  const resolvedScript = path.resolve(script);
  const faultInjectionPath = require.resolve('./fault-injection');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, ['--preload', faultInjectionPath, resolvedScript], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...env,
          [FAULT_MAP_ENV]: JSON.stringify(faults),
          [CRASH_ARTIFACTS_PATH_ENV]: artifactsPath,
          [CRASH_MARKER_PATH_ENV]: crashMarkerPath,
          [CRASH_MARKER_TOKEN_ENV]: markerToken,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timeoutError;
    const timeout = setTimeout(() => {
      timeoutError = new Error(`Child timed out after ${timeoutMs}ms before triggering a crash fault`);
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      cleanup();
      reject(error);
    });
    child.once('exit', (status, signal) => {
      clearTimeout(timeout);
      if (timeoutError) {
        cleanup();
        reject(timeoutError);
        return;
      }

      try {
        const crashPoint = parseCrashMarker(crashMarkerPath);
        validateCrashProof({
          childPid: child.pid,
          faults,
          marker: crashPoint,
          markerToken,
          signal,
          status,
        });
        let artifacts;
        try {
          artifacts = JSON.parse(fs.readFileSync(artifactsPath, 'utf8'));
        } catch (cause) {
          throw new Error('Invalid crash artifacts JSON', { cause });
        }
        if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
          throw new Error('Invalid crash artifacts schema');
        }

        resolve({
          artifacts,
          artifactsPath,
          cleanup,
          crashPoint,
          scenePath,
          signal: crashPoint.signal,
          observedSignal: signal,
          status,
          stderr,
          stdout,
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  });
}

module.exports = { runUntilCrash };

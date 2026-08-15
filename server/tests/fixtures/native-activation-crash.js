const fs = require('node:fs');

const { CRASH_ARTIFACTS_PATH_ENV } = require('../../testing/fault-injection');

const scenario = process.env.MYTHPEN_NATIVE_ACTIVATION_CRASH_SCENARIO;
if (!scenario) throw new Error('MYTHPEN_NATIVE_ACTIVATION_CRASH_SCENARIO is required');

const buildInfo = require('../../build-info');
buildInfo.getBuildInfo = () => Object.freeze({
  nativeActivationMode: 'fixture_only',
  sourceCommit: 'a'.repeat(40),
  targetTriple: 'x86_64-pc-windows-msvc',
});
delete require.cache[require.resolve('../../native/native-activation-authority')];
delete require.cache[require.resolve('../../testing/native-stage-c-activation')];

const {
  activateNativeStageCFixture,
  createNativeStageCActivationFixture,
} = require('../../testing/native-stage-c-activation');

async function main() {
  const fixture = createNativeStageCActivationFixture({
    name: `stage-c-b-${scenario}`,
    sentinel: {
      id: `activation-${scenario}`,
      name: `Activation ${scenario}`,
      background: 'stage-c-b-sentinel',
    },
  });
  fs.writeFileSync(
    process.env[CRASH_ARTIFACTS_PATH_ENV],
    JSON.stringify({ version: 1, scenario, fixture }),
  );
  await activateNativeStageCFixture(fixture);
  throw new Error(`Activation crash point was not reached: ${scenario}`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

const path = require('node:path');

const { getBuildInfo } = require('../build-info');
const {
  assertNativeStageCFixtureReopenRoot,
  authorizeNativeActivation,
} = require('../native/native-activation-authority');
const {
  createFixtureNativeActivationController,
} = require('./fixture-native-activation-controller');
const { createNativeStageCFixture } = require('./native-stage-c-fixture');

function prepareFixtureController() {
  if (getBuildInfo().nativeActivationMode !== 'fixture_only') {
    const error = new Error('Fixture sidecar was not compiled in fixture_only mode');
    error.code = 'NATIVE_ACTIVATION_DISABLED';
    throw error;
  }
  const requestedReopenRoot = process.env.MYTHPEN_FIXTURE_REOPEN_ROOT;
  let root;
  let receipt;
  if (requestedReopenRoot === undefined) {
    const fixture = createNativeStageCFixture();
    root = fixture.root;
    receipt = authorizeNativeActivation({ root }).consume();
  } else {
    root = assertNativeStageCFixtureReopenRoot(requestedReopenRoot);
    receipt = null;
  }
  process.env.MYTHPEN_DATA_DIR = root;
  process.env.MYTHPEN_EXPORT_DIR = path.join(root, 'exports');
  return createFixtureNativeActivationController({ receipt, root });
}

async function main() {
  const controller = prepareFixtureController();
  const database = require('../db');
  database.installNativeActivationController(controller);
  const { startMainServer } = require('../index');
  await startMainServer();
}

void main().catch((error) => {
  const message = `Fixture sidecar startup failed [${error.code || 'UNKNOWN'}]: ${error.message}\n`;
  process.stderr.write(message, () => process.exit(1));
});

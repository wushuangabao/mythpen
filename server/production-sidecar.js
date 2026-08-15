const {
  createProductionNativeActivationController,
} = require('./native/production-native-activation-controller');

async function main() {
  const controller = createProductionNativeActivationController();
  const database = require('./db');
  database.installNativeActivationController(controller);
  const { startMainServer } = require('./index');
  await startMainServer();
}

void main().catch((error) => {
  const message = `Production sidecar startup failed [${error.code || 'UNKNOWN'}]: ${error.message}\n`;
  process.stderr.write(message, () => process.exit(1));
});

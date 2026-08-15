const controllerModes = new WeakMap();
let fixtureInfo = null;

function disabled(message = 'Native activation controller authority is invalid') {
  const error = new Error(message);
  error.code = 'NATIVE_ACTIVATION_DISABLED';
  return error;
}

function exactController(controller) {
  return controller !== null
    && typeof controller === 'object'
    && !Array.isArray(controller)
    && Object.isFrozen(controller)
    && Object.getPrototypeOf(controller) === Object.prototype
    && Reflect.ownKeys(controller).length === 1
    && Object.keys(controller).length === 1
    && Object.keys(controller)[0] === 'activate'
    && typeof controller.activate === 'function';
}

function register(controller, mode) {
  if (!exactController(controller) || controllerModes.has(controller)) throw disabled();
  controllerModes.set(controller, mode);
  return controller;
}

function registerFixtureNativeActivationController(controller, info = null) {
  if (
    info !== null
    && (
      info === null
      || typeof info !== 'object'
      || !Object.isFrozen(info)
      || Object.getPrototypeOf(info) !== Object.prototype
      || Object.keys(info).sort().join(',') !== 'activationMode,root'
      || info.activationMode !== 'fixture_only'
      || typeof info.root !== 'string'
    )
  ) throw disabled('Fixture activation controller metadata is invalid');
  const registered = register(controller, 'fixture_only');
  if (info !== null) fixtureInfo = info;
  return registered;
}

function getFixtureNativeActivationInfo() {
  if (
    require('../build-info').getBuildInfo().nativeActivationMode !== 'fixture_only'
    || fixtureInfo === null
  ) throw disabled('Fixture native activation is not installed');
  return fixtureInfo;
}

function assertNativeActivationControllerForBuild(controller) {
  const mode = controllerModes.get(controller);
  const buildMode = require('../build-info').getBuildInfo().nativeActivationMode;
  if (mode === undefined || mode !== buildMode || buildMode === 'off') {
    throw disabled('Native activation controller does not match the compiled activation mode');
  }
  return controller;
}

const productionControllerModule = require('./production-native-activation-controller');
productionControllerModule.initializeProductionNativeActivationControllerFactory(
  (controller) => register(controller, 'production'),
);

module.exports = {
  assertNativeActivationControllerForBuild,
  getFixtureNativeActivationInfo,
  registerFixtureNativeActivationController,
};

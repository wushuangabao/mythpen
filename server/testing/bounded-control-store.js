const controlStoreModule = require('../control-store');

function createBoundedControlStoreTestHarness(controlDir, authoritySource) {
  if (typeof authoritySource !== 'function' || authoritySource.length !== 0) {
    throw new TypeError('Bounded ControlStore authoritySource must be a zero-argument function');
  }

  const controlStore = controlStoreModule.openControlStore(controlDir, { bounded: true });
  const controller = controlStoreModule.getBoundedControlStoreCheckpointController(controlStore);

  function authorityProvider() {
    return authoritySource();
  }

  return Object.freeze({
    controlStore,
    checkpoint() {
      return controller.installCheckpoint(authorityProvider);
    },
    maintenanceStatus() {
      return controller.maintenanceStatus();
    },
  });
}

module.exports = {
  createBoundedControlStoreTestHarness,
};

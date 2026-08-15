const databaseInternalsByWrapper = new WeakMap();
let projectWriteDiagnosticCapability = null;
let testManuscriptBootstrapProvider = null;

function registerDatabaseInternals(wrapper, internals) {
  databaseInternalsByWrapper.set(wrapper, Object.freeze({ ...internals }));
  return wrapper;
}

function databaseInternals(wrapper) {
  const internals = databaseInternalsByWrapper.get(wrapper);
  if (!internals) throw new TypeError('Expected a Mythpen database wrapper');
  return internals;
}

function isTestManuscriptBootstrapActive() {
  return testManuscriptBootstrapProvider?.() === true;
}

function registerProjectWriteDiagnostics(capability) {
  if (
    !capability
    || typeof capability !== 'object'
    || typeof capability.leaseAcquisitionCount !== 'function'
  ) {
    throw new TypeError('Project writer diagnostics require a read-only capability');
  }
  projectWriteDiagnosticCapability = Object.freeze({
    leaseAcquisitionCount: capability.leaseAcquisitionCount,
  });
}

function projectWriteDiagnostics() {
  if (!projectWriteDiagnosticCapability) throw new Error('Project writer diagnostics are not registered');
  return projectWriteDiagnosticCapability;
}

module.exports = {
  databaseInternals,
  isTestManuscriptBootstrapActive,
  projectWriteDiagnostics,
  registerDatabaseInternals,
  registerProjectWriteDiagnostics,
};

Object.defineProperty(module.exports, 'registerTestManuscriptBootstrapProvider', {
  value(provider) {
    if (
      testManuscriptBootstrapProvider !== null
      || typeof provider !== 'function'
      || provider.length !== 0
    ) throw new TypeError('Test manuscript bootstrap provider registration is invalid');
    testManuscriptBootstrapProvider = provider;
  },
  enumerable: false,
});

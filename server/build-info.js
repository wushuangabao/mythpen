const FALLBACK_SOURCE_COMMIT = '0'.repeat(40);
const FALLBACK_TARGET_TRIPLE = 'unknown-unknown-unknown';
const NATIVE_ACTIVATION_MODES = new Set(['off', 'fixture_only', 'production']);

const sourceCommit = typeof __MYTHPEN_SOURCE_COMMIT__ === 'string'
  ? __MYTHPEN_SOURCE_COMMIT__
  : FALLBACK_SOURCE_COMMIT;
const targetTriple = typeof __MYTHPEN_TARGET_TRIPLE__ === 'string'
  ? __MYTHPEN_TARGET_TRIPLE__
  : FALLBACK_TARGET_TRIPLE;
const nativeActivationMode = typeof __MYTHPEN_NATIVE_ACTIVATION_MODE__ === 'string'
  ? __MYTHPEN_NATIVE_ACTIVATION_MODE__
  : 'off';

if (!NATIVE_ACTIVATION_MODES.has(nativeActivationMode)) {
  throw new Error('Invalid compile-time native activation mode');
}

const BUILD_INFO = Object.freeze({
  nativeActivationMode,
  sourceCommit,
  targetTriple,
});

function getBuildInfo() {
  return BUILD_INFO;
}

module.exports = {
  getBuildInfo,
};

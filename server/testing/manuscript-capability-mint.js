'use strict';

const {
  mintFileBoundaryCapability,
  mintFileWriterCapability,
  mintJournalAuthorityCapability,
} = require('../manuscript/capability-registry');

const TEST_BACKEND_TOKEN = Object.freeze({ kind: 'manuscript_test_backend' });
const TEST_OPTIONS = Object.freeze({ backendToken: TEST_BACKEND_TOKEN, mode: 'test' });

function createTestFileBoundaryCapability(implementation) {
  return mintFileBoundaryCapability(implementation, TEST_OPTIONS);
}

function createTestFileWriterCapability(implementation) {
  return mintFileWriterCapability(implementation, TEST_OPTIONS);
}

function createTestJournalAuthorityCapability(implementation) {
  return mintJournalAuthorityCapability(implementation, TEST_OPTIONS);
}

module.exports = {
  createTestFileBoundaryCapability,
  createTestFileWriterCapability,
  createTestJournalAuthorityCapability,
};

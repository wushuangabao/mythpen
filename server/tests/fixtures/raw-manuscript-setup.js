const { withTestManuscriptBootstrap } = require('../../testing/database-internals');

function withRawManuscriptSetup(callback) {
  return withTestManuscriptBootstrap(callback);
}

module.exports = { withRawManuscriptSetup };

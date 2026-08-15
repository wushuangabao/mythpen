const { getBuildInfo } = require('./build-info');
const { createServiceLifecycle } = require('./service-lifecycle');
const { createSidecarControlChannel } = require('./sidecar-control');

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function parseDirectPort(value) {
  if (value === undefined) return 3001;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,4})$/.test(value)) {
    throw new TypeError('PORT must be a canonical decimal integer from 0 through 65535');
  }
  const port = Number(value);
  if (port > 65_535) {
    throw new TypeError('PORT must be a canonical decimal integer from 0 through 65535');
  }
  return port;
}

function createLifecycleAdmissionMiddleware(lifecycle) {
  return function lifecycleAdmissionMiddleware(req, res, next) {
    if (!MUTATION_METHODS.has(req.method) || lifecycle.state === 'running') return next();
    return res.status(503).json({
      error: {
        code: 'SERVICE_SHUTTING_DOWN',
        message: '服务正在退出，请稍后重试',
        recoverable: true,
      },
    });
  };
}

function createIdleCoordinator() {
  let active = null;
  return {
    beginQuiesce() {
      active = {};
      return active;
    },
    cancelQuiesce(quiesce) {
      if (quiesce !== active) throw new Error('invalid quiesce token');
      active = null;
    },
    drain(quiesce) {
      return quiesce === active ? Promise.resolve() : Promise.reject(new Error('invalid quiesce token'));
    },
  };
}

function listenOnLoopback(app, port) {
  return new Promise((resolve, reject) => {
    let server;
    const onError = (error) => reject(error);
    server = app.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(server);
    });
    server.once('error', onError);
  });
}

function closeListeningServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function attachRollbackErrors(primaryError, rollbackErrors) {
  if (rollbackErrors.length === 0 || !primaryError || typeof primaryError !== 'object') return;
  try {
    Object.defineProperty(primaryError, 'startupRollbackErrors', {
      configurable: true,
      value: rollbackErrors,
    });
  } catch {
    // Preserve the primary startup failure when it cannot be extended.
  }
}

async function startServerRuntime({
  assertDurabilitySupported,
  childPid = process.pid,
  closeDatabases = () => {},
  configureRecoveryDiagnosticsCapabilities,
  coordinator = createIdleCoordinator(),
  createApp,
  detectCapabilities,
  env = process.env,
  initDatabase,
  input = process.stdin,
  inspectProjectDatabasesAtStartup,
  output = process.stdout,
}) {
  const desktopOwned = env.MYTHPEN_DESKTOP_OWNED === '1';
  const controlChannel = desktopOwned ? createSidecarControlChannel({ input, output }) : null;
  let bootstrapped = !desktopOwned;
  let storageInitializationAttempted = false;
  let server = null;
  let lifecycle = null;
  let removeSignalHandlers = () => {};
  try {
    let port;
    if (desktopOwned) {
      await controlChannel.waitForBootstrap();
      bootstrapped = true;
      if (env.PORT !== '0') {
        const error = new Error('Desktop-owned sidecar requires PORT=0');
        error.code = 'CONTROL_INVALID_STATE';
        throw error;
      }
      port = 0;
    } else {
      port = parseDirectPort(env.PORT);
    }

    const capabilities = assertDurabilitySupported(detectCapabilities());
    configureRecoveryDiagnosticsCapabilities(capabilities);
    storageInitializationAttempted = true;
    await initDatabase();
    await inspectProjectDatabasesAtStartup();
    lifecycle = createServiceLifecycle({
      childPid,
      closeDatabases,
      closeListener: () => closeListeningServer(server),
      coordinator,
      async sendFrame(type, payload) {
        if (!controlChannel) return;
        await controlChannel.send(type, payload);
        if (type === 'shutdown.complete') controlChannel.close();
      },
    });
    const app = createApp({
      instanceNonceMiddleware: controlChannel?.createInstanceNonceMiddleware() || null,
      lifecycleAdmissionMiddleware: createLifecycleAdmissionMiddleware(lifecycle),
    });
    server = await listenOnLoopback(app, port);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to resolve the sidecar loopback endpoint');
    }
    const buildInfo = getBuildInfo();
    if (controlChannel) {
      const sharedBuildPayload = {
        childPid,
        nonceDigest: controlChannel.nonceDigest,
        ...buildInfo,
      };
      await controlChannel.send('ready', {
        childPid,
        host: '127.0.0.1',
        port: address.port,
        nonceDigest: controlChannel.nonceDigest,
        ...buildInfo,
      });
      controlChannel.setCommandHandler(async (command) => {
        if (command.type === 'build.info.request') {
          await controlChannel.send('build.info', sharedBuildPayload);
          return;
        }
        try {
          await lifecycle.handleCommand(command);
        } catch (error) {
          await controlChannel.send('control.error', {
            code: error?.code || 'CONTROL_INVALID_STATE',
          });
        }
      });
    } else {
      let nextAttemptSeq = 1;
      const requestSignalShutdown = () => {
        if (lifecycle.state !== 'running') return;
        void lifecycle.handleCommand({
          type: 'shutdown.request',
          attemptSeq: nextAttemptSeq++,
        }).catch((error) => {
          console.error('[Server] Graceful shutdown failed:', error);
        });
      };
      process.on('SIGINT', requestSignalShutdown);
      process.on('SIGTERM', requestSignalShutdown);
      removeSignalHandlers = () => {
        process.off('SIGINT', requestSignalShutdown);
        process.off('SIGTERM', requestSignalShutdown);
      };
    }

    return Object.freeze({
      app,
      buildInfo,
      controlChannel,
      lifecycle,
      server,
    });
  } catch (error) {
    if (!bootstrapped) throw error;
    const rollbackErrors = [];
    try {
      await closeListeningServer(server);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (storageInitializationAttempted) {
      try {
        await closeDatabases();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    removeSignalHandlers();
    controlChannel?.close();
    attachRollbackErrors(error, rollbackErrors);
    throw error;
  }
}

module.exports = {
  parseDirectPort,
  startServerRuntime,
};

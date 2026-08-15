class LifecycleControlError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LifecycleControlError';
    this.code = code;
  }
}

function controlError(code) {
  return new LifecycleControlError(code);
}

function createCompletion() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createServiceLifecycle({
  childPid = process.pid,
  clearTimer = clearTimeout,
  closeDatabases,
  closeListener,
  coordinator,
  sendFrame,
  setTimer = setTimeout,
  softDeadlineMs = 5_000,
}) {
  if (!coordinator) throw new TypeError('coordinator is required');
  if (typeof closeDatabases !== 'function') throw new TypeError('closeDatabases is required');
  if (typeof closeListener !== 'function') throw new TypeError('closeListener is required');
  if (typeof sendFrame !== 'function') throw new TypeError('sendFrame is required');

  let state = 'running';
  let attemptSeq = 0;
  let serviceEpoch = 1;
  let activeAttempt = null;
  const attempts = new Map();

  function emit(type, payload) {
    return Promise.resolve(sendFrame(type, payload));
  }

  function isCurrent(record) {
    return activeAttempt === record
      && record.epoch === serviceEpoch
      && record.outcome === null;
  }

  function clearSoftDeadline(record) {
    if (!record?.timer) return;
    clearTimer(record.timer);
    record.timer = null;
  }

  function armSoftDeadline(record) {
    clearSoftDeadline(record);
    record.timer = setTimer(() => {
      record.timer = null;
      if (
        !isCurrent(record)
        || (state !== 'quiescing' && state !== 'draining' && state !== 'closing')
      ) return;
      void emit('shutdown.soft_deadline', {
        childPid,
        attemptSeq: record.attemptSeq,
        state,
      }).catch(() => {});
    }, softDeadlineMs);
  }

  async function failAttempt(record) {
    if (!isCurrent(record)) return;
    clearSoftDeadline(record);
    state = 'failed';
    record.outcome = 'failed';
    record.code = 'STORAGE_UNAVAILABLE';
    await emit('shutdown.failed', {
      childPid,
      attemptSeq: record.attemptSeq,
      outcome: 'failed',
      code: record.code,
    });
    record.completion.resolve({ outcome: 'failed', code: record.code });
  }

  async function finishAttempt(record) {
    try {
      await coordinator.drain(record.quiesce);
      if (!isCurrent(record)) return;
      state = 'closing';
      await emit('shutdown.state', {
        childPid,
        attemptSeq: record.attemptSeq,
        state,
      });
      await closeListener();
      await closeDatabases();
      if (!isCurrent(record)) return;
      clearSoftDeadline(record);
      state = 'complete';
      record.outcome = 'clean';
      await emit('shutdown.complete', {
        childPid,
        attemptSeq: record.attemptSeq,
        outcome: 'clean',
      });
      record.completion.resolve({ outcome: 'clean' });
    } catch {
      await failAttempt(record);
    }
  }

  async function replayAttempt(record) {
    if (record.outcome === 'cancelled') {
      return emit('shutdown.cancelled', {
        childPid,
        attemptSeq: record.attemptSeq,
        outcome: 'cancelled',
        serviceEpoch: record.cancelledEpoch,
      });
    }
    if (record.outcome === 'clean') {
      return emit('shutdown.complete', {
        childPid,
        attemptSeq: record.attemptSeq,
        outcome: 'clean',
      });
    }
    if (record.outcome === 'failed') {
      return emit('shutdown.failed', {
        childPid,
        attemptSeq: record.attemptSeq,
        outcome: 'failed',
        code: record.code,
      });
    }
    return emit('shutdown.state', {
      childPid,
      attemptSeq: record.attemptSeq,
      state,
    });
  }

  async function requestShutdown(requestedAttemptSeq) {
    const replay = attempts.get(requestedAttemptSeq);
    if (replay) return replayAttempt(replay);
    if (
      !Number.isSafeInteger(requestedAttemptSeq)
      || requestedAttemptSeq !== attemptSeq + 1
      || state !== 'running'
    ) {
      throw controlError('CONTROL_ATTEMPT_INVALID');
    }
    if (attemptSeq > 0) serviceEpoch += 1;
    attemptSeq = requestedAttemptSeq;
    const completion = createCompletion();
    const record = {
      attemptSeq,
      cancelledEpoch: null,
      code: null,
      completion,
      epoch: serviceEpoch,
      outcome: null,
      quiesce: coordinator.beginQuiesce(),
      timer: null,
    };
    attempts.set(attemptSeq, record);
    activeAttempt = record;
    state = 'quiescing';
    await emit('shutdown.state', { childPid, attemptSeq, state });
    if (!isCurrent(record)) return;
    state = 'draining';
    await emit('shutdown.state', { childPid, attemptSeq, state });
    if (!isCurrent(record)) return;
    armSoftDeadline(record);
    void finishAttempt(record);
  }

  async function cancelShutdown(requestedAttemptSeq) {
    const record = attempts.get(requestedAttemptSeq);
    if (!record || requestedAttemptSeq !== attemptSeq) {
      throw controlError('CONTROL_ATTEMPT_INVALID');
    }
    if (record.outcome === 'cancelled') return replayAttempt(record);
    if (state === 'closing' || state === 'complete' || state === 'failed') {
      throw controlError('CONTROL_CANCEL_TOO_LATE');
    }
    if (!isCurrent(record)) throw controlError('CONTROL_INVALID_STATE');
    coordinator.cancelQuiesce(record.quiesce);
    clearSoftDeadline(record);
    serviceEpoch += 1;
    state = 'running';
    activeAttempt = null;
    record.outcome = 'cancelled';
    record.cancelledEpoch = serviceEpoch;
    record.completion.resolve({ outcome: 'cancelled' });
    await emit('shutdown.cancelled', {
      childPid,
      attemptSeq: record.attemptSeq,
      outcome: 'cancelled',
      serviceEpoch,
    });
  }

  async function continueWait(requestedAttemptSeq) {
    const record = attempts.get(requestedAttemptSeq);
    if (
      !record
      || requestedAttemptSeq !== attemptSeq
      || !isCurrent(record)
      || (state !== 'quiescing' && state !== 'draining' && state !== 'closing')
    ) {
      throw controlError('CONTROL_INVALID_STATE');
    }
    armSoftDeadline(record);
  }

  return Object.freeze({
    get attemptSeq() {
      return attemptSeq;
    },
    async handleCommand(command) {
      if (command?.type === 'shutdown.request') return requestShutdown(command.attemptSeq);
      if (command?.type === 'shutdown.cancel') return cancelShutdown(command.attemptSeq);
      if (command?.type === 'shutdown.continue_wait') return continueWait(command.attemptSeq);
      throw controlError('CONTROL_INVALID_STATE');
    },
    get serviceEpoch() {
      return serviceEpoch;
    },
    get state() {
      return state;
    },
    waitForAttempt(requestedAttemptSeq) {
      const record = attempts.get(requestedAttemptSeq);
      if (!record) return Promise.reject(controlError('CONTROL_ATTEMPT_INVALID'));
      return record.completion.promise;
    },
  });
}

module.exports = {
  LifecycleControlError,
  createServiceLifecycle,
};

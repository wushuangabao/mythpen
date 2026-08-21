'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createWindowsManuscriptChangeFeedAdapter,
} = require('../platform/windows-manuscript-change-feed');

function physicalIdentity(dev, ino) {
  return Object.freeze({ dev: String(dev), ino: String(ino) });
}

function platformIdentity(overrides = {}) {
  const canonicalRealMythpenDirectory = path.resolve('C:\\workspace\\article\\mythpen');
  return Object.freeze({
    canonicalRealMythpenDirectory,
    articleRootDirectoryIdentity: physicalIdentity(1, 10),
    mythpenDirectoryIdentity: physicalIdentity(1, 11),
    volumesDirectoryIdentity: physicalIdentity(1, 12),
    chaptersDirectoryIdentity: physicalIdentity(1, 13),
    ...overrides,
  });
}

function inspectedDirectory(identity, targetPath, overrides = {}) {
  const canonical = identity.canonicalRealMythpenDirectory;
  const targetName = path.basename(targetPath).toLowerCase();
  const isRoot = targetName === 'mythpen';
  const expectedIdentity = isRoot
    ? identity.mythpenDirectoryIdentity
    : identity[`${targetName}DirectoryIdentity`];
  return {
    actualName: path.basename(targetPath),
    byteSize: 0,
    identity: expectedIdentity,
    kind: 'directory',
    linkCount: null,
    parentIdentity: isRoot
      ? identity.articleRootDirectoryIdentity
      : identity.mythpenDirectoryIdentity,
    parentRealPath: isRoot ? path.dirname(canonical) : canonical,
    realPath: targetPath,
    reparse: false,
    ...overrides,
  };
}

function notificationBytes(records) {
  const encoded = records.map(({ action, component }) => ({
    action,
    name: Buffer.from(component, 'utf16le'),
  }));
  const sizes = encoded.map(({ name }, index) => {
    const minimum = 12 + name.byteLength;
    return index === encoded.length - 1 ? minimum : (minimum + 3) & ~3;
  });
  const output = Buffer.alloc(sizes.reduce((sum, size) => sum + size, 0));
  let offset = 0;
  for (let index = 0; index < encoded.length; index += 1) {
    const { action, name } = encoded[index];
    output.writeUInt32LE(index === encoded.length - 1 ? 0 : sizes[index], offset);
    output.writeUInt32LE(action, offset + 4);
    output.writeUInt32LE(name.byteLength, offset + 8);
    name.copy(output, offset + 12);
    offset += sizes[index];
  }
  return output;
}

class FakeKernel32 {
  constructor(identity, options = {}) {
    this.identity = identity;
    this.options = options;
    this.nextHandle = 100n;
    this.lastError = 0;
    this.handles = new Map();
    this.operations = new Map();
    this.calls = [];
    this.schema = null;
    this.closeCallCount = 0;
  }

  #newHandle(record) {
    const handle = this.nextHandle;
    this.nextHandle += 1n;
    this.handles.set(handle, record);
    return handle;
  }

  #feedIdForPath(targetPath) {
    return path.basename(targetPath).toLowerCase();
  }

  #identityForFeed(feedId) {
    return this.options.handleIdentity?.[feedId]
      || this.identity[`${feedId}DirectoryIdentity`];
  }

  #eventRecord(handle) {
    const record = this.handles.get(BigInt(handle));
    assert.equal(record?.kind, 'event');
    return record;
  }

  dlopen = (_name, schema) => {
    this.schema = schema;
    const symbols = {
      CreateFileW: (widePath, access, share, security, disposition, flags, template) => {
        this.calls.push(['CreateFileW', access, share, security, disposition, flags, template]);
        if (this.options.invalidCreateFileReturn === true) return 'invalid';
        const decoded = widePath.toString('utf16le').replace(/\0.*$/s, '');
        const targetPath = decoded.startsWith('\\\\?\\') ? decoded.slice(4) : decoded;
        const feedId = this.#feedIdForPath(targetPath);
        if (this.options.createFileFailure === feedId) {
          this.lastError = 3;
          return 0xffffffffffffffffn;
        }
        return this.#newHandle({ kind: 'directory', targetPath, feedId });
      },
      CreateEventW: (security, manualReset, initialState, name) => {
        this.calls.push(['CreateEventW', security, manualReset, initialState, name]);
        if (this.options.createEventFailureAt === this.calls.filter((item) => item[0] === 'CreateEventW').length) {
          this.lastError = 8;
          return 0n;
        }
        return this.#newHandle({ kind: 'event', signaled: false });
      },
      ResetEvent: (eventHandle) => {
        this.calls.push(['ResetEvent', eventHandle]);
        if (this.options.resetFailureFeed !== undefined) {
          const directory = [...this.operations.values()]
            .find((operation) => operation.eventHandle === BigInt(eventHandle));
          if (directory?.feedId === this.options.resetFailureFeed) {
            this.lastError = 6;
            return 0;
          }
        }
        this.#eventRecord(eventHandle).signaled = false;
        return 1;
      },
      ReadDirectoryChangesW: (
        directoryHandle,
        buffer,
        bufferLength,
        subtree,
        filter,
        bytesReturned,
        overlapped,
        callback,
      ) => {
        const directory = this.handles.get(BigInt(directoryHandle));
        const eventHandle = overlapped.readBigUInt64LE(24);
        this.calls.push([
          'ReadDirectoryChangesW',
          directory.feedId,
          buffer,
          bufferLength,
          subtree,
          filter,
          bytesReturned,
          overlapped,
          callback,
        ]);
        if (this.options.armFailureFeed === directory.feedId) {
          this.lastError = 87;
          return 0;
        }
        this.operations.set(BigInt(directoryHandle), {
          buffer,
          directoryHandle: BigInt(directoryHandle),
          eventHandle,
          feedId: directory.feedId,
          overlapped,
          terminal: null,
        });
        return 1;
      },
      WaitForSingleObject: (eventHandle, milliseconds) => {
        this.calls.push(['WaitForSingleObject', eventHandle, milliseconds]);
        if (this.options.waitFailure === true) {
          this.lastError = 6;
          return 0xffffffff;
        }
        return this.#eventRecord(eventHandle).signaled ? 0 : 258;
      },
      GetOverlappedResult: (directoryHandle, overlapped, transferred, wait) => {
        const operation = this.operations.get(BigInt(directoryHandle));
        this.calls.push(['GetOverlappedResult', operation?.feedId, wait]);
        if (this.options.terminalIncomplete?.has(operation?.feedId)) {
          this.lastError = 996;
          return 0;
        }
        if (operation === undefined || operation.overlapped !== overlapped || operation.terminal === null) {
          this.lastError = 996;
          return 0;
        }
        transferred.writeUInt32LE(operation.terminal.byteCount || 0, 0);
        if (operation.terminal.success) return 1;
        this.lastError = operation.terminal.error;
        return 0;
      },
      CancelIoEx: (directoryHandle, overlapped) => {
        const operation = this.operations.get(BigInt(directoryHandle));
        this.calls.push(['CancelIoEx', operation?.feedId]);
        assert.strictEqual(operation?.overlapped, overlapped);
        if (operation?.terminal !== null || this.options.cancelNotFound?.has(operation?.feedId)) {
          this.lastError = 1168;
          if (operation?.terminal === null) {
            operation.terminal = { success: false, error: 995, byteCount: 0 };
            this.#eventRecord(operation.eventHandle).signaled = true;
          }
          return 0;
        }
        operation.terminal = { success: false, error: 995, byteCount: 0 };
        this.#eventRecord(operation.eventHandle).signaled = true;
        return 1;
      },
      GetFileInformationByHandle: (directoryHandle, information) => {
        const record = this.handles.get(BigInt(directoryHandle));
        this.calls.push(['GetFileInformationByHandle', record?.feedId]);
        if (this.options.handleInspectionFailure === record?.feedId) {
          this.lastError = 6;
          return 0;
        }
        const identity = this.#identityForFeed(record.feedId);
        const fileIndex = BigInt(identity.ino);
        const attributes = 0x10 | (this.options.reparseFeed === record.feedId ? 0x400 : 0);
        information.writeUInt32LE(attributes, 0);
        information.writeUInt32LE(Number(BigInt(identity.dev)), 28);
        information.writeUInt32LE(Number((fileIndex >> 32n) & 0xffffffffn), 44);
        information.writeUInt32LE(Number(fileIndex & 0xffffffffn), 48);
        return 1;
      },
      CloseHandle: (handle) => {
        const record = this.handles.get(BigInt(handle));
        this.closeCallCount += 1;
        this.calls.push(['CloseHandle', record?.kind, record?.feedId || null]);
        if (this.options.throwCloseAt === this.closeCallCount) throw new Error('close threw');
        if (this.options.failCloseAt === this.closeCallCount) {
          this.lastError = 6;
          return 0;
        }
        return this.options.invalidCloseAt === this.closeCallCount ? 'invalid' : 1;
      },
      GetLastError: () => this.lastError,
    };
    if (this.options.missingSymbol !== undefined) delete symbols[this.options.missingSymbol];
    return { symbols, close() {} };
  };

  inject(feedId, { records, bytes, error } = {}) {
    const operation = [...this.operations.values()].find((item) => item.feedId === feedId);
    assert.ok(operation, `missing ${feedId} operation`);
    let payload = bytes;
    if (records !== undefined) payload = notificationBytes(records);
    if (payload !== undefined) payload.copy(operation.buffer);
    operation.terminal = error === undefined
      ? { success: true, byteCount: payload?.byteLength || 0 }
      : { success: false, error, byteCount: 0 };
    this.#eventRecord(operation.eventHandle).signaled = true;
  }
}

function withFakePlatform(options, run) {
  const identity = options.identity || platformIdentity();
  const fake = new FakeKernel32(identity, options.native);
  const ffi = require('bun:ffi');
  const durability = require('../platform/durability');
  const adapterPath = require.resolve('../platform/windows-manuscript-change-feed');
  const cachedAdapter = require.cache[adapterPath];
  const originalDlopen = ffi.dlopen;
  const originalPtr = ffi.ptr;
  const originalInspectPath = durability.inspectPath;
  let inspectCalls = 0;
  ffi.dlopen = fake.dlopen;
  ffi.ptr = (value) => value;
  durability.inspectPath = (targetPath) => {
    inspectCalls += 1;
    return options.inspectPath?.(targetPath, inspectCalls)
      || inspectedDirectory(identity, targetPath);
  };
  delete require.cache[adapterPath];
  try {
    return run(require(adapterPath), fake, identity, () => inspectCalls);
  } finally {
    delete require.cache[adapterPath];
    ffi.dlopen = originalDlopen;
    ffi.ptr = originalPtr;
    durability.inspectPath = originalInspectPath;
    if (cachedAdapter !== undefined) require.cache[adapterPath] = cachedAdapter;
  }
}

function assertUnknownDisposition(result) {
  assert.equal(result.outcome, 'UNAVAILABLE');
  assert.equal(result.closeDisposition, 'UNKNOWN');
  assert.deepEqual(Object.getOwnPropertyDescriptor(result.error, 'releaseDispositionUnknown'), {
    configurable: false,
    enumerable: true,
    value: true,
    writable: false,
  });
}

function captureError(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail('Expected operation to throw');
}

function stopAndClose(owner) {
  owner.beginStopping();
  for (const feedId of ['mythpen', 'volumes', 'chapters']) {
    const completion = owner.cancelPending(feedId);
    if (completion !== null) {
      owner.decode(completion);
      owner.retireCompletion(completion);
    }
  }
  return owner.close();
}

test('Windows manuscript change feed exposes one pure exact identity validator', () => {
  const adapter = createWindowsManuscriptChangeFeedAdapter();
  const identity = platformIdentity();

  assert.strictEqual(adapter.assertIdentity(identity), identity);
  assert.deepEqual(Reflect.ownKeys(adapter), ['assertIdentity', 'tryOpen']);
  assert.equal(Object.isFrozen(adapter), true);

  for (const invalid of [
    { ...identity },
    Object.freeze({ ...identity, extra: true }),
    Object.freeze({ ...identity, mythpenDirectoryIdentity: { dev: '1', ino: '11' } }),
    platformIdentity({ mythpenDirectoryIdentity: physicalIdentity('01', 11) }),
    platformIdentity({ canonicalRealMythpenDirectory: 'relative\\mythpen' }),
    platformIdentity({ canonicalRealMythpenDirectory: path.resolve('C:\\workspace\\article\\other') }),
    platformIdentity({ canonicalRealMythpenDirectory: path.resolve('C:\\workspace\\article\\MYTHPEN') }),
  ]) {
    assert.throws(() => adapter.assertIdentity(invalid), TypeError);
  }
});

test('Windows manuscript change feed freezes ABI and arms three isolated watched handles', () => {
  withFakePlatform({}, ({ createWindowsManuscriptChangeFeedAdapter: createAdapter }, fake, identity, inspectCalls) => {
    const result = createAdapter().tryOpen(identity);
    assert.equal(result.outcome, 'OPENED');
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(Reflect.ownKeys(result), ['outcome', 'owner']);
    assert.deepEqual(Reflect.ownKeys(result.owner), [
      'state',
      'feedInstance',
      'probeEvents',
      'takeCompletion',
      'rearm',
      'decode',
      'retireCompletion',
      'beginStopping',
      'cancelPending',
      'close',
    ]);
    assert.equal(result.owner.state, 'ARMED');
    assert.equal(inspectCalls(), 6);

    const ffi = require('bun:ffi').FFIType;
    assert.deepEqual(Object.keys(fake.schema), [
      'CreateFileW',
      'CreateEventW',
      'ResetEvent',
      'ReadDirectoryChangesW',
      'WaitForSingleObject',
      'GetOverlappedResult',
      'CancelIoEx',
      'GetFileInformationByHandle',
      'CloseHandle',
      'GetLastError',
    ]);
    assert.deepEqual(fake.schema.CreateFileW, {
      args: [ffi.ptr, ffi.u32, ffi.u32, ffi.ptr, ffi.u32, ffi.u32, ffi.ptr],
      returns: ffi.u64,
    });
    assert.deepEqual(fake.schema.CreateEventW, {
      args: [ffi.ptr, ffi.i32, ffi.i32, ffi.ptr],
      returns: ffi.u64,
    });
    assert.deepEqual(fake.schema.ResetEvent, { args: [ffi.u64], returns: ffi.i32 });
    assert.deepEqual(fake.schema.ReadDirectoryChangesW, {
      args: [ffi.u64, ffi.ptr, ffi.u32, ffi.i32, ffi.u32, ffi.ptr, ffi.ptr, ffi.ptr],
      returns: ffi.i32,
    });
    assert.deepEqual(fake.schema.WaitForSingleObject, {
      args: [ffi.u64, ffi.u32], returns: ffi.u32,
    });
    assert.deepEqual(fake.schema.GetOverlappedResult, {
      args: [ffi.u64, ffi.ptr, ffi.ptr, ffi.i32], returns: ffi.i32,
    });
    assert.deepEqual(fake.schema.CancelIoEx, {
      args: [ffi.u64, ffi.ptr], returns: ffi.i32,
    });
    assert.deepEqual(fake.schema.GetFileInformationByHandle, {
      args: [ffi.u64, ffi.ptr], returns: ffi.i32,
    });
    assert.deepEqual(fake.schema.CloseHandle, { args: [ffi.u64], returns: ffi.i32 });
    assert.deepEqual(fake.schema.GetLastError, { args: [], returns: ffi.u32 });

    const opens = fake.calls.filter((call) => call[0] === 'CreateFileW');
    assert.equal(opens.length, 3);
    assert.deepEqual(opens.map((call) => call.slice(1)), Array(3).fill([
      0x1, 0x3, 0, 3, 0x42200000, 0,
    ]));
    const events = fake.calls.filter((call) => call[0] === 'CreateEventW');
    assert.deepEqual(events.map((call) => call.slice(1)), Array(3).fill([0, 1, 0, 0]));
    const arms = fake.calls.filter((call) => call[0] === 'ReadDirectoryChangesW');
    assert.deepEqual(arms.map((call) => call[1]), ['mythpen', 'volumes', 'chapters']);
    assert.equal(new Set(arms.map((call) => call[2])).size, 3);
    for (const call of arms) {
      assert.equal(call[2].byteLength, 1024 * 1024);
      assert.deepEqual(call.slice(3, 9).map((value, index) => (
        index === 4 ? value.byteLength : value
      )), [1024 * 1024, 0, 0x5f, 0, 32, 0]);
    }

    assert.deepEqual(stopAndClose(result.owner), Object.freeze({ disposition: 'CLOSED' }));
  });
});

test('Windows manuscript change feed exposes branded completion and validates records after rearm', () => {
  withFakePlatform({}, ({ createWindowsManuscriptChangeFeedAdapter: createAdapter }, fake, identity) => {
    const owner = createAdapter().tryOpen(identity).owner;
    const instance = owner.feedInstance('chapters');
    fake.inject('chapters', {
      records: [
        { action: 1, component: 'chapter-a.md' },
        { action: 3, component: '章节-b.md' },
        { action: 4, component: 'old.md' },
        { action: 5, component: 'new.md' },
      ],
    });
    assert.deepEqual(owner.probeEvents(), Object.freeze({
      mythpen: false,
      volumes: false,
      chapters: true,
    }));
    const completion = owner.takeCompletion('chapters');
    assert.deepEqual(completion, Object.freeze({ feedId: 'chapters', handleInstance: instance }));
    assert.equal(Object.isFrozen(completion), true);
    assert.throws(() => owner.decode(completion), TypeError);
    assert.throws(() => owner.rearm({ ...completion }), TypeError);
    assert.strictEqual(owner.rearm(completion), instance);
    const decode = owner.decode(completion);
    assert.deepEqual(decode, Object.freeze({
      outcome: 'RECORDS',
      records: Object.freeze([
        Object.freeze({ action: 'ADDED', component: 'chapter-a.md' }),
        Object.freeze({ action: 'MODIFIED', component: '章节-b.md' }),
        Object.freeze({ action: 'RENAMED_OLD_NAME', component: 'old.md' }),
        Object.freeze({ action: 'RENAMED_NEW_NAME', component: 'new.md' }),
      ]),
    }));
    assert.equal(Object.isFrozen(decode.records), true);
    assert.throws(() => owner.decode(completion), TypeError);
    owner.retireCompletion(completion);
    assert.throws(() => owner.retireCompletion(completion), TypeError);

    const rearmCalls = fake.calls.filter((call) => call[0] === 'ReadDirectoryChangesW' && call[1] === 'chapters');
    assert.equal(rearmCalls.length, 2);
    assert.notStrictEqual(rearmCalls[0][2], rearmCalls[1][2]);
    const clone = Object.freeze({ ...owner });
    assert.throws(() => clone.feedInstance('mythpen'), TypeError);
    assert.deepEqual(stopAndClose(owner), Object.freeze({ disposition: 'CLOSED' }));
  });
});

test('Windows manuscript change feed turns native overflow, zero bytes and malformed buffers into explicit loss', () => {
  const malformed = [
    { name: 'zero byte', injection: {}, reason: 'ZERO_BYTE_COMPLETION' },
    { name: 'native overflow', injection: { error: 1022 }, reason: 'NOTIFY_ENUM_DIR' },
    {
      name: 'unknown action',
      injection: { records: [{ action: 99, component: 'bad.md' }] },
      reason: 'MALFORMED_NOTIFICATION',
    },
    {
      name: 'separator',
      injection: { records: [{ action: 1, component: 'bad/name.md' }] },
      reason: 'MALFORMED_NOTIFICATION',
    },
    {
      name: 'lone surrogate',
      injection: { records: [{ action: 1, component: '\ud800' }] },
      reason: 'MALFORMED_NOTIFICATION',
    },
    {
      name: 'misaligned next',
      injection: { bytes: Buffer.from([15, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 97, 0, 0]) },
      reason: 'MALFORMED_NOTIFICATION',
    },
  ];
  for (const scenario of malformed) {
    withFakePlatform({}, ({ createWindowsManuscriptChangeFeedAdapter: createAdapter }, fake, identity) => {
      const owner = createAdapter().tryOpen(identity).owner;
      fake.inject('mythpen', scenario.injection);
      const completion = owner.takeCompletion('mythpen');
      owner.rearm(completion);
      assert.deepEqual(owner.decode(completion), Object.freeze({
        outcome: 'COVERAGE_LOST',
        reason: scenario.reason,
      }), scenario.name);
      owner.retireCompletion(completion);
      stopAndClose(owner);
    });
  }
});

test('Windows manuscript change feed fails closed on path and watched-handle identity races', () => {
  const cases = [
    {
      name: 'path parent changed after arm',
      inspectPath(targetPath, call, identity) {
        return inspectedDirectory(identity, targetPath, call === 4
          ? { parentIdentity: physicalIdentity(9, 9) }
          : {});
      },
    },
    {
      name: 'watched handle identity mismatch',
      native: { handleIdentity: { chapters: physicalIdentity(1, 999) } },
    },
    {
      name: 'watched handle is reparse',
      native: { reparseFeed: 'volumes' },
    },
    {
      name: 'missing ABI symbol',
      native: { missingSymbol: 'CancelIoEx' },
    },
    {
      name: 'invalid native handle width',
      native: { invalidCreateFileReturn: true },
    },
  ];
  for (const scenario of cases) {
    withFakePlatform({
      native: scenario.native,
      inspectPath(targetPath, call) {
        const identity = platformIdentity();
        return scenario.inspectPath?.(targetPath, call, identity)
          || inspectedDirectory(identity, targetPath);
      },
    }, ({ createWindowsManuscriptChangeFeedAdapter: createAdapter }, _fake, identity) => {
      const result = createAdapter().tryOpen(identity);
      assert.equal(result.outcome, 'UNAVAILABLE', scenario.name);
      assert.equal(result.closeDisposition, 'KNOWN_CLOSED', scenario.name);
      assert.equal(Object.isFrozen(result), true);
    });
  }
});

test('Windows manuscript change feed keeps one module slot until a known close', () => {
  withFakePlatform({}, ({ createWindowsManuscriptChangeFeedAdapter: createAdapter }, _fake, identity) => {
    const first = createAdapter().tryOpen(identity);
    assert.equal(first.outcome, 'OPENED');
    assert.deepEqual(createAdapter().tryOpen(identity), Object.freeze({ outcome: 'NO_SLOT' }));
    stopAndClose(first.owner);
    const reopened = createAdapter().tryOpen(identity);
    assert.equal(reopened.outcome, 'OPENED');
    stopAndClose(reopened.owner);
  });
});

test('Windows manuscript change feed makes partial-open close uncertainty sticky', () => {
  withFakePlatform({
    native: { armFailureFeed: 'volumes', failCloseAt: 1 },
  }, ({ createWindowsManuscriptChangeFeedAdapter: createAdapter }, _fake, identity) => {
    const adapter = createAdapter();
    assertUnknownDisposition(adapter.tryOpen(identity));
    assertUnknownDisposition(adapter.tryOpen(identity));
  });
});

test('Windows manuscript change feed retains an unterminated partial stream without closing its handles', () => {
  withFakePlatform({
    native: {
      armFailureFeed: 'volumes',
      terminalIncomplete: new Set(['mythpen']),
    },
  }, ({ createWindowsManuscriptChangeFeedAdapter: createAdapter }, fake, identity) => {
    const adapter = createAdapter();
    assertUnknownDisposition(adapter.tryOpen(identity));
    const closes = fake.calls
      .filter((call) => call[0] === 'CloseHandle')
      .map((call) => call.slice(1));
    assert.deepEqual(closes, [
      ['directory', 'volumes'],
      ['event', null],
    ]);
    assertUnknownDisposition(adapter.tryOpen(identity));
  });
});

test('Windows manuscript change feed waits for terminal cancellation even after ERROR_NOT_FOUND', () => {
  withFakePlatform({
    native: { cancelNotFound: new Set(['volumes']) },
  }, ({ createWindowsManuscriptChangeFeedAdapter: createAdapter }, fake, identity) => {
    const owner = createAdapter().tryOpen(identity).owner;
    assert.throws(() => owner.close(), TypeError);
    owner.beginStopping();
    assert.equal(owner.state, 'STOPPING');
    fake.inject('mythpen', { records: [{ action: 2, component: 'removed.md' }] });

    const mythpen = owner.cancelPending('mythpen');
    assert.equal(owner.decode(mythpen).outcome, 'RECORDS');
    owner.retireCompletion(mythpen);
    const volumes = owner.cancelPending('volumes');
    assert.deepEqual(owner.decode(volumes), Object.freeze({
      outcome: 'COVERAGE_LOST',
      reason: 'OPERATION_ABORTED',
    }));
    owner.retireCompletion(volumes);
    assert.throws(() => owner.close(), TypeError);
    const chapters = owner.cancelPending('chapters');
    owner.decode(chapters);
    owner.retireCompletion(chapters);

    const result = owner.close();
    assert.deepEqual(result, Object.freeze({ disposition: 'CLOSED' }));
    assert.equal(owner.state, 'CLOSED');
    const cancellations = fake.calls.filter((call) => call[0] === 'CancelIoEx');
    assert.deepEqual(cancellations.map((call) => call[1]), ['mythpen', 'volumes', 'chapters']);
    const terminalWaits = fake.calls.filter((call) => call[0] === 'GetOverlappedResult');
    assert.deepEqual(terminalWaits.map((call) => call.slice(1)), [
      ['mythpen', 1],
      ['volumes', 1],
      ['chapters', 1],
    ]);
    assert.deepEqual(fake.calls.filter((call) => call[0] === 'CloseHandle').map((call) => call.slice(1)), [
      ['directory', 'mythpen'],
      ['event', null],
      ['directory', 'volumes'],
      ['event', null],
      ['directory', 'chapters'],
      ['event', null],
    ]);
  });
});

test('Windows manuscript change feed makes an owner and process slot unknown when cancellation is not terminal', () => {
  withFakePlatform({
    native: { terminalIncomplete: new Set(['mythpen']) },
  }, ({ createWindowsManuscriptChangeFeedAdapter: createAdapter }, fake, identity) => {
    const adapter = createAdapter();
    const owner = adapter.tryOpen(identity).owner;
    owner.beginStopping();
    const error = captureError(() => owner.cancelPending('mythpen'));
    assert.deepEqual(Object.getOwnPropertyDescriptor(error, 'releaseDispositionUnknown'), {
      configurable: false,
      enumerable: true,
      value: true,
      writable: false,
    });
    assert.equal(owner.state, 'CLOSE_DISPOSITION_UNKNOWN');
    assertUnknownDisposition(adapter.tryOpen(identity));
    assert.deepEqual(fake.calls.filter((call) => call[0] === 'CloseHandle'), []);
  });
});

test('Windows manuscript change feed never rearms after stopping and never closes before retire', () => {
  withFakePlatform({}, ({ createWindowsManuscriptChangeFeedAdapter: createAdapter }, fake, identity) => {
    const owner = createAdapter().tryOpen(identity).owner;
    fake.inject('chapters', { records: [{ action: 3, component: 'pending.md' }] });
    const completion = owner.takeCompletion('chapters');
    owner.beginStopping();
    assert.throws(() => owner.rearm(completion), TypeError);
    assert.throws(() => owner.close(), TypeError);
    owner.decode(completion);
    assert.throws(() => owner.close(), TypeError);
    owner.retireCompletion(completion);
    for (const feedId of ['mythpen', 'volumes']) {
      const cancelled = owner.cancelPending(feedId);
      owner.decode(cancelled);
      owner.retireCompletion(cancelled);
    }
    assert.deepEqual(owner.cancelPending('chapters'), null);
    owner.close();
  });
});

test('Windows manuscript change feed preserves unknown close disposition for every handle fault kind', () => {
  for (const fault of [
    ...Array.from({ length: 6 }, (_, index) => ({ failCloseAt: index + 1 })),
    { throwCloseAt: 2 },
    { invalidCloseAt: 6 },
  ]) {
    withFakePlatform({ native: fault }, ({ createWindowsManuscriptChangeFeedAdapter: createAdapter }, _fake, identity) => {
      const adapter = createAdapter();
      const owner = adapter.tryOpen(identity).owner;
      owner.beginStopping();
      for (const feedId of ['mythpen', 'volumes', 'chapters']) {
        const completion = owner.cancelPending(feedId);
        owner.decode(completion);
        owner.retireCompletion(completion);
      }
      const error = captureError(() => owner.close());
      assert.equal(owner.state, 'CLOSE_DISPOSITION_UNKNOWN');
      assert.deepEqual(Object.getOwnPropertyDescriptor(error, 'releaseDispositionUnknown'), {
        configurable: false,
        enumerable: true,
        value: true,
        writable: false,
      });
      assertUnknownDisposition(adapter.tryOpen(identity));
    });
  }
});

test('Windows manuscript change feed rejects a second outstanding completion until retirement', () => {
  withFakePlatform({}, ({ createWindowsManuscriptChangeFeedAdapter: createAdapter }, fake, identity) => {
    const owner = createAdapter().tryOpen(identity).owner;
    fake.inject('volumes', { records: [{ action: 1, component: 'one.json' }] });
    const first = owner.takeCompletion('volumes');
    owner.rearm(first);
    fake.inject('volumes', { records: [{ action: 1, component: 'two.json' }] });
    assert.throws(() => owner.takeCompletion('volumes'), TypeError);
    owner.decode(first);
    owner.retireCompletion(first);
    const second = owner.takeCompletion('volumes');
    owner.rearm(second);
    owner.decode(second);
    owner.retireCompletion(second);
    stopAndClose(owner);
  });
});

function realIdentity(targetPath) {
  const stats = fs.lstatSync(targetPath, { bigint: true });
  return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
}

function realPlatformIdentity(mythpenDirectory) {
  return Object.freeze({
    canonicalRealMythpenDirectory: fs.realpathSync.native(mythpenDirectory),
    articleRootDirectoryIdentity: realIdentity(path.dirname(mythpenDirectory)),
    mythpenDirectoryIdentity: realIdentity(mythpenDirectory),
    volumesDirectoryIdentity: realIdentity(path.join(mythpenDirectory, 'volumes')),
    chaptersDirectoryIdentity: realIdentity(path.join(mythpenDirectory, 'chapters')),
  });
}

function deepFrozenPlatformIdentity(identity) {
  return Object.isFrozen(identity)
    && Object.isFrozen(identity.articleRootDirectoryIdentity)
    && Object.isFrozen(identity.mythpenDirectoryIdentity)
    && Object.isFrozen(identity.volumesDirectoryIdentity)
    && Object.isFrozen(identity.chaptersDirectoryIdentity);
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`worker exit=${code} stdout=${stdout} stderr=${stderr}`));
    });
  });
}

test('Windows manuscript direct feed observes writes from a second process in all three directories', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
  timeout: 30_000,
}, async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(
    fs.realpathSync.native(os.tmpdir()),
    'mythpen-feed-',
  )));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mythpen = path.join(root, 'mythpen');
  fs.mkdirSync(path.join(mythpen, 'volumes'), { recursive: true });
  fs.mkdirSync(path.join(mythpen, 'chapters'));
  const identity = realPlatformIdentity(mythpen);
  assert.equal(deepFrozenPlatformIdentity(identity), true);
  const adapterPath = require.resolve('../platform/windows-manuscript-change-feed');
  delete require.cache[adapterPath];
  const realAdapter = require(adapterPath).createWindowsManuscriptChangeFeedAdapter();
  const opened = realAdapter.tryOpen(identity);
  assert.equal(opened.outcome, 'OPENED', opened.error?.stack);
  const owner = opened.owner;
  try {
    const { spawn } = require('node:child_process');
    const invalidIdentity = Object.freeze({
      ...identity,
      chaptersDirectoryIdentity: physicalIdentity(
        identity.chaptersDirectoryIdentity.dev,
        BigInt(identity.chaptersDirectoryIdentity.ino) + 1n,
      ),
    });
    const rejectedChild = spawn(process.execPath, [
      path.join(__dirname, 'fixtures', 'manuscript-feed-worker.js'),
      JSON.stringify(invalidIdentity),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await assert.rejects(waitForChild(rejectedChild), /identity|worker exit/i);
    assert.equal(fs.existsSync(path.join(mythpen, 'manuscript.json')), false);
    assert.equal(fs.existsSync(path.join(mythpen, 'volumes', 'volume.json')), false);
    assert.equal(fs.existsSync(path.join(mythpen, 'chapters', 'chapter.md')), false);

    const child = spawn(process.execPath, [
      path.join(__dirname, 'fixtures', 'manuscript-feed-worker.js'),
      JSON.stringify(identity),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForChild(child);

    const records = new Map();
    const deadline = Date.now() + 10_000;
    while (records.size < 3 && Date.now() < deadline) {
      const events = owner.probeEvents();
      for (const feedId of ['mythpen', 'volumes', 'chapters']) {
        if (!events[feedId]) continue;
        const completion = owner.takeCompletion(feedId);
        owner.rearm(completion);
        records.set(feedId, owner.decode(completion));
        owner.retireCompletion(completion);
      }
      if (records.size < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual([...records.keys()].sort(), ['chapters', 'mythpen', 'volumes']);
    assert.ok(records.get('mythpen').records.some((record) => record.component === 'manuscript.json'));
    assert.ok(records.get('volumes').records.some((record) => record.component === 'volume.json'));
    assert.ok(records.get('chapters').records.some((record) => record.component === 'chapter.md'));
  } finally {
    if (owner.state === 'ARMED') stopAndClose(owner);
  }
});

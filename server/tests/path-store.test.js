const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindowsStore } = require('../path-store');

test('Windows registry queries discard reg.exe stderr when a value is absent', () => {
  let options;
  const store = createWindowsStore((_file, _args, receivedOptions) => {
    options = receivedOptions;
    throw new Error('missing registry value');
  });

  assert.equal(store.get('DataDir'), null);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
});

test('Windows registry parses a REG_SZ Chinese path containing spaces', () => {
  const store = createWindowsStore((file, args) => {
    assert.equal(file, 'reg.exe');
    assert.deepEqual(args, ['query', 'HKCU\\Software\\Mythpen', '/v', 'DataDir']);
    return [
      '',
      'HKEY_CURRENT_USER\\Software\\Mythpen',
      '    DataDir    REG_SZ    D:\\小说 资料\\我的作品',
      '',
    ].join('\r\n');
  });

  assert.equal(store.get('DataDir'), 'D:\\小说 资料\\我的作品');
});

test('Windows registry set uses the fixed Mythpen key and an argument array', () => {
  let invocation;
  const store = createWindowsStore((file, args, options) => {
    invocation = { file, args, options };
  });

  store.set('ExportDir', 'E:\\导出 文件');

  assert.equal(invocation.file, 'reg.exe');
  assert.deepEqual(invocation.args, [
    'add',
    'HKCU\\Software\\Mythpen',
    '/v',
    'ExportDir',
    '/t',
    'REG_SZ',
    '/d',
    'E:\\导出 文件',
    '/f',
  ]);
  assert.equal(invocation.options.stdio, 'ignore');
});

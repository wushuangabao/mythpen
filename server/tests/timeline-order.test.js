const assert = require('node:assert/strict');
const test = require('node:test');

const {
  compareTimelineEvents,
  orderTimelineEvents,
  parseTimelineSortKey,
  validateTimelineEventOrder,
} = require('../timeline-order');

test('timeline events use natural numeric chronological ordering', () => {
  const events = [
    { year: '2033.10', title: '十月' },
    { year: '2033.9', title: '九月' },
    { year: '2032', title: '开始' },
    { year: '2033.6', title: '六月' },
  ];

  assert.deepEqual(
    events.sort(compareTimelineEvents).map((event) => event.year),
    ['2032', '2033.6', '2033.9', '2033.10'],
  );
});

test('timeline events recognize negative and BCE years', () => {
  assert.deepEqual(parseTimelineSortKey('-221'), [-221, 0, 0]);
  assert.deepEqual(parseTimelineSortKey('公元前221年'), [-221, 0, 0]);
  assert.deepEqual(parseTimelineSortKey('BCE 44'), [-44, 0, 0]);
  assert.deepEqual(parseTimelineSortKey('44 BCE'), [-44, 0, 0]);

  const events = [
    { year: '1', title: 'Common era' },
    { year: '公元前1年', title: 'One BCE' },
    { year: '公元前221年', title: 'Qin' },
    { year: '-300', title: 'Earlier' },
  ];
  assert.deepEqual(
    events.sort(compareTimelineEvents).map((event) => event.year),
    ['-300', '公元前221年', '公元前1年', '1'],
  );
});

test('timeline events support year, month, day, and common date separators', () => {
  const events = [
    { year: '2033年1月10日', title: '十日' },
    { year: '2033/1/2', title: '二日' },
    { year: '2033-2', title: '二月' },
    { year: '2033', title: '年初' },
    { year: '2033年1月', title: '一月' },
  ];

  assert.deepEqual(
    events.sort(compareTimelineEvents).map((event) => event.year),
    ['2033', '2033年1月', '2033/1/2', '2033年1月10日', '2033-2'],
  );
});

test('unrecognizable timeline text remains in its original relative order after dated events', () => {
  const events = [
    { year: '第一章之前', title: '前史' },
    { year: '2033年夏', title: '夏季' },
    { year: '2033.10', title: '十月' },
    { year: '2033.9', title: '九月' },
  ];

  assert.deepEqual(
    events.sort(compareTimelineEvents).map((event) => event.year),
    ['2033.9', '2033.10', '第一章之前', '2033年夏'],
  );
});

test('timeline reorder accepts only a complete event ID permutation', () => {
  const events = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];

  assert.equal(validateTimelineEventOrder(['third', 'first', 'second'], events), null);
  assert.match(validateTimelineEventOrder(['first', 'first', 'second'], events), /重复/);
  assert.match(validateTimelineEventOrder(['first', 'second'], events), /全部/);
  assert.match(validateTimelineEventOrder(['first', 'second', 'missing'], events), /全部/);
});

test('automatic timeline ordering keeps a manual sequence unchanged', () => {
  const events = [
    { id: 'october', year: '2033.10', title: 'October' },
    { id: 'fantasy', year: 'Star Calendar Nine', title: 'Fantasy' },
    { id: 'september', year: '2033.9', title: 'September' },
  ];

  assert.deepEqual(
    orderTimelineEvents(events, 'auto').map((event) => event.id),
    ['september', 'october', 'fantasy'],
  );
  assert.deepEqual(
    orderTimelineEvents(events, 'manual').map((event) => event.id),
    ['october', 'fantasy', 'september'],
  );
});

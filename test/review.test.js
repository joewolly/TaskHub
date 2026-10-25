import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewGroups } from '../public/workflows.js';

test('review separates deadlines, visible follow-ups, bounded older tasks and persistent Today order without mutations', () => {
  const base = { is_open: true, queue: 'inbox', today_rank: null };
  const tasks = [
    { ...base, id: 1, queue: 'someday', due_date: '2026-10-01', snoozed_until: '2026-11-01' },
    { ...base, id: 2, waiting_on: 'Part', follow_up_date: '2026-10-02', snoozed_until: '2026-11-01' },
    { ...base, id: 3, waiting_on: 'Person', follow_up_date: '2026-10-02' },
    { ...base, id: 4, today_rank: 3 }, { ...base, id: 5, today_rank: 0 },
    ...Array.from({ length: 30 }, (_, i) => ({ ...base, id: i + 10 })),
  ];
  const before = structuredClone(tasks);
  const groups = reviewGroups(tasks, '2026-10-10');
  assert.deepEqual(groups[0].tasks.map(t => t.id), [1,3]);
  assert.equal(groups[1].tasks.length, 20);
  assert.deepEqual(groups[2].tasks.map(t => t.id), [5,4]);
  assert.deepEqual(tasks, before);
});

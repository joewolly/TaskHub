export const estimateOptions = [['', 'No estimate'], ...[5,15,30,60].map(n => [n, `${n} minutes`])];
export function matchesTime(task, query) {
  if (!query.max_minutes) return true;
  return task.estimate_minutes == null ? String(query.include_unestimated) !== 'false' : task.estimate_minutes <= Number(query.max_minutes);
}
export function timeFilters(ui, query, update) {
  const { el, select } = ui;
  return el('div', { class: 'planning-actions time-filters' },
    el('label', {}, 'Time available ', select('max_minutes', [['', 'Any amount of time'], ...estimateOptions.slice(1)], query.max_minutes || '', e => update('max_minutes', e.target.value))),
    el('label', { class: 'focus-check' }, el('input', { type: 'checkbox', checked: query.include_unestimated !== 'false', onchange: e => update('include_unestimated', String(e.target.checked)) }), 'Include tasks without estimates'));
}

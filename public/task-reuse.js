import { randomId } from './uuid.js';

/** Whitelist content; no history, dates, identities, assignments or recurrence. */
export function reuseDraft(task) {
  return {
    id: randomId(), title: task.title, body: task.body || '', tags: (task.tags || []).join(', '),
    project_id: task.project_id || null, device_id: task.device_id || null,
    priority: 'medium', due_date: '', estimate_minutes: task.estimate_minutes ?? '',
    checklist: (task.checklist || []).map(item => item.title),
    files: [], reused: true, updated_at: new Date().toISOString(),
  };
}

let connection;
function open() {
  if (!connection)
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open('taskhub-drafts', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('drafts', { keyPath: 'id' });
      request.onerror = () => {
        connection = null;
        reject(request.error);
      };
      request.onsuccess = () => resolve(request.result);
    });
  return connection;
}
async function run(mode, operation) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', mode),
      request = operation(tx.objectStore('drafts'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () =>
      reject(
        tx.error ||
          request.error ||
          new Error('Could not save this draft on the device'),
      );
  });
}
export const listDrafts = () => run('readonly', (s) => s.getAll());
export const getDraft = (id) => run('readonly', (s) => s.get(id));
export const putDraft = (draft) => run('readwrite', (s) => s.put(draft));
export const deleteDraft = (id) => run('readwrite', (s) => s.delete(id));
export const clearDrafts = () => run('readwrite', (s) => s.clear());

/** Compare and write in one transaction so another tab cannot erase submission state. */
export async function putBatchDraft(draft, { create = false } = {}) {
  const db = await open();
  const revision = draft.revision ?? 0;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite');
    const store = tx.objectStore('drafts');
    const request = store.get(draft.id);
    let failure;
    tx.oncomplete = () => resolve(revision + 1);
    tx.onerror = tx.onabort = () => reject(failure || tx.error || request.error ||
      new Error('Could not save this list on the device'));
    request.onsuccess = () => {
      const current = request.result;
      if (create ? Boolean(current) : !current || current.kind !== 'paste-tasks' ||
          current.version !== 1 || (current.revision ?? 0) !== revision) {
        failure = Object.assign(new Error(
          'This list changed in another tab or was discarded. Copy any unsaved edits, then reload to recover the latest progress.',
        ), { name: 'DraftConflictError' });
        tx.abort();
        return;
      }
      try {
        store.put({ ...draft, revision: revision + 1 });
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
  });
}

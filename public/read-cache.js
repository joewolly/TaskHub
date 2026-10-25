/** Briefly reuse navigation reads, including requests already in flight. */
export function createReadCache({ ttlMs = 5000, maxEntries = 64, now = Date.now } = {}) {
  const entries = new Map();
  return {
    async get(key, load) {
      let entry = entries.get(key);
      if (!entry || entry.expires <= now()) {
        entry = { expires: Infinity };
        entry.promise = Promise.resolve().then(load).then(value => {
          entry.expires = now() + ttlMs;
          return value;
        }, error => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        });
        entries.set(key, entry);
        if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      }
      // Route handlers may change their copy without altering another screen's data.
      return structuredClone(await entry.promise);
    },
    clear() { entries.clear(); },
  };
}

import type { StorageAdapter } from './types.js';

/** Keeps the session in memory only: it is gone when the page / process ends. */
export function memoryStorage(): StorageAdapter {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

/** localStorage when the environment provides a working one (it can throw in private mode or sandboxes), else null. */
export function browserStorage(): StorageAdapter | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    const probe = '__sbb_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return {
      getItem: (key) => ls.getItem(key),
      setItem: (key, value) => ls.setItem(key, value),
      removeItem: (key) => ls.removeItem(key),
    };
  } catch {
    return null;
  }
}

/** The subset of `chrome.storage.local` / `browser.storage.local` that is used. */
export interface ChromeStorageArea {
  get(keys: string, callback?: (items: Record<string, unknown>) => void): unknown;
  set(items: Record<string, unknown>, callback?: () => void): unknown;
  remove(keys: string, callback?: () => void): unknown;
}

/** Works with both callback-style (`chrome.*`) and promise-style (`browser.*`, MV3) extension APIs. */
function call<T>(fn: (done: (value: T) => void) => unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      const ret = fn(resolve);
      if (ret && typeof (ret as Promise<T>).then === 'function') (ret as Promise<T>).then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Session storage for browser extensions. Defaults to `chrome.storage.local`
 * (`browser.storage.local` in Firefox). Pass `chrome.storage.session` to forget the
 * session when the browser closes.
 *
 *   createClient(url, key, { auth: { storage: createChromeStorage() } })
 */
export function createChromeStorage(area?: ChromeStorageArea): StorageAdapter {
  const g = globalThis as unknown as { chrome?: { storage?: { local?: ChromeStorageArea } }; browser?: { storage?: { local?: ChromeStorageArea } } };
  const target = area ?? g.browser?.storage?.local ?? g.chrome?.storage?.local;
  if (!target) throw new Error('createChromeStorage: chrome.storage is not available (are you running inside an extension with the "storage" permission?)');
  return {
    async getItem(key) {
      const items = await call<Record<string, unknown>>((done) => target.get(key, done));
      const value = items?.[key];
      return typeof value === 'string' ? value : null;
    },
    async setItem(key, value) {
      await call<void>((done) => target.set({ [key]: value }, done));
    },
    async removeItem(key) {
      await call<void>((done) => target.remove(key, done));
    },
  };
}

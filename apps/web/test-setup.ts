/**
 * PLNR-289: Vitest setup for jsdom tests with Node 26's experimental localStorage.
 *
 * Node v26.7.0 defines an experimental localStorage global that is `undefined` (when
 * --localstorage-file is not provided) with an ExperimentalWarning. Vitest's jsdom
 * environment only copies window properties to globalThis when they are not already
 * defined there, so Node's undefined global wins and jsdom's real Storage is never
 * installed. This means both `typeof globalThis.localStorage` and `typeof window.localStorage`
 * are `'undefined'` inside a jsdom test.
 *
 * This setup file installs a working Storage implementation on BOTH globalThis and window
 * before any test module loads, but only when the value is missing or unusable. It never
 * clobbers a working Storage that jsdom may have already installed (on Node versions
 * without this problem).
 */

/**
 * A minimal Map-backed Web Storage implementation that passes the contract expected
 * by the test suite and production components (get/set/remove/clear/length/key).
 */
class MapBackedStorage implements Storage {
  private store = new Map<string, string>();

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  key(index: number): string | null {
    const keys = Array.from(this.store.keys());
    return keys[index] ?? null;
  }

  get length(): number {
    return this.store.size;
  }
}

/**
 * Install a working Storage on the given object if it is missing or not a real object.
 * Returns true if it installed a shim, false if it left an existing Storage in place.
 */
function ensureStorage(target: any, name: string): boolean {
  const existing = target[name];
  // If it already exists and is an object (even if not a Storage), assume jsdom installed it correctly.
  if (existing && typeof existing === 'object') {
    return false;
  }
  // It's undefined (Node 26's problem) or some primitive (unlikely) — install a working shim.
  target[name] = new MapBackedStorage();
  return true;
}

// Install on globalThis first, then on window.
// Both must be the same instance so that `globalThis.localStorage === window.localStorage`.
const storage = new MapBackedStorage();
const sessionStorage = new MapBackedStorage();

ensureStorage(globalThis, 'localStorage') && (globalThis.localStorage = storage);
ensureStorage(globalThis, 'sessionStorage') && (globalThis.sessionStorage = sessionStorage);

// Ensure window.localStorage and window.sessionStorage are the same instance.
// Vitest's jsdom environment sets up a real window object; we need to sync with it.
if (typeof window !== 'undefined') {
  if (!window.localStorage || typeof window.localStorage !== 'object') {
    Object.defineProperty(window, 'localStorage', {
      value: globalThis.localStorage,
      writable: false,
      configurable: true,
    });
  }
  if (!window.sessionStorage || typeof window.sessionStorage !== 'object') {
    Object.defineProperty(window, 'sessionStorage', {
      value: globalThis.sessionStorage,
      writable: false,
      configurable: true,
    });
  }
}

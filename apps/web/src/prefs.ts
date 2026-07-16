// PLNR-143: localStorage preference keys renamed planar.* → noriq.*. Reads go
// through here so an existing browser's prefs survive the rename: the legacy key
// is copied to the new name once, then removed. Writers use the new key directly.
export function migratedGet(key: string): string | null {
  const val = localStorage.getItem(key);
  if (val !== null) return val;
  const legacy = key.replace(/^noriq\./, 'planar.');
  const old = localStorage.getItem(legacy);
  if (old !== null) {
    localStorage.setItem(key, old);
    localStorage.removeItem(legacy);
  }
  return old;
}

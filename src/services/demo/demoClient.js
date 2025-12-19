import demoData from './demoData.json';

const DEMO_NAME = normalize(demoData?.meta?.businessName);
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const MODE_KEY = 'bizzy:dataMode';
const TESTING_KEY = 'bizzy:qbTesting';

function normalize(value) {
  return (value || '').toString().trim().toLowerCase();
}

function clone(payload) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(payload); } catch (_) { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(payload));
}

function getLocalStorage() {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getStoredBusinessName() {
  const storage = getLocalStorage();
  if (!storage) return '';
  const keys = ['bizzy:businessName', 'currentBusinessName', 'business_name'];
  for (const key of keys) {
    const val = storage.getItem(key);
    if (val) return val;
  }
  return '';
}

function envDemoFlag() {
  const raw = (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_BIZZY_DEMO) || '';
  const node = typeof process !== 'undefined' ? process.env?.VITE_BIZZY_DEMO : '';
  const val = normalize(raw || node || '');
  return TRUTHY.has(val);
}

function storageDemoFlag() {
  const storage = getLocalStorage();
  if (!storage) return false;
  const flag = normalize(storage.getItem('bizzy:demo') || '');
  return !!flag && !['0', 'false', 'off', ''].includes(flag);
}

function getModeOverride() {
  const storage = getLocalStorage();
  if (!storage) return 'auto';
  const raw = storage.getItem(MODE_KEY);
  if (!raw) return 'auto';
  const val = normalize(raw);
  if (val === 'demo') return 'demo';
  if (val === 'live') return 'live';
  return 'auto';
}

function setModeOverride(mode) {
  const storage = getLocalStorage();
  if (!storage) return;
  if (!mode || mode === 'auto') {
    storage.removeItem(MODE_KEY);
  } else {
    storage.setItem(MODE_KEY, mode);
  }
}

function getTestingFlag() {
  const storage = getLocalStorage();
  if (!storage) return false;
  const raw = normalize(storage.getItem(TESTING_KEY));
  return raw === 'on' || raw === '1' || raw === 'true';
}

function setTestingFlag(enabled) {
  const storage = getLocalStorage();
  if (!storage) return;
  if (enabled) storage.setItem(TESTING_KEY, 'on');
  else storage.removeItem(TESTING_KEY);
  try {
    window.dispatchEvent(new CustomEvent('bizzy:testing-mode-changed', { detail: enabled }));
  } catch {
    // ignore
  }
}

function bestBusinessName(candidate) {
  if (!candidate) return getStoredBusinessName();
  if (typeof candidate === 'string') return candidate;
  return (
    candidate?.business_name ||
    candidate?.businessName ||
    candidate?.name ||
    getStoredBusinessName()
  );
}

export function getDemoData() {
  return clone(demoData);
}

export function getDemoBusinessName() {
  return demoData?.meta?.businessName || "";
}

export function shouldUseDemoData(businessLike) {
  if (isTestingMode()) return false;
  const override = getModeOverride();
  if (override === 'demo') return true;
  if (override === 'live') return false;
  if (envDemoFlag() || storageDemoFlag()) return true;
  const name = normalize(bestBusinessName(businessLike));
  return !!name && !!DEMO_NAME && name === DEMO_NAME;
}

export function ensureDemoBusinessNameStored(business) {
  const storage = getLocalStorage();
  if (!storage) return;
  const name = bestBusinessName(business);
  if (!name) return;
  try {
    storage.setItem('bizzy:businessName', name);
  } catch {
    // no-op
  }
}

export function getDemoMode() {
  return getModeOverride();
}

export function setDemoMode(mode) {
  try {
    setModeOverride(mode);
    const storage = getLocalStorage();
    if (storage) {
      if (mode === 'demo') storage.setItem('bizzy:demo', '1');
      else if (mode === 'live') storage.setItem('bizzy:demo', '0');
      else storage.removeItem('bizzy:demo');
    }
  } catch {
    // ignore
  } finally {
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('bizzy:demo-mode-changed', { detail: mode }));
      } catch {
        /* ignore */
      }
    }
  }
}

export function isLiveModeForced() {
  return getModeOverride() === 'live';
}

export function isTestingMode() {
  return getTestingFlag();
}

// True when we should show only live/sandbox data (no mock/demo fallbacks)
export function shouldForceLiveData() {
  return isTestingMode() || isLiveModeForced();
}

export function setTestingMode(enabled) {
  try {
    setTestingFlag(!!enabled);
  } catch {
    // ignore storage failures
  }
}

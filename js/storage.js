/**
 * storage.js — persistencia en localStorage con prefijos.
 * Nunca lanza excepciones hacia la interfaz: avisa con un evento y sigue.
 */

export const INVENTORY_PREFIX = 'mi_inventario_';
export const SHOPPING_PREFIX = 'mi_lista_compras_';
export const MAX_ITEMS = 1000;

const DEFAULT_SETTINGS = {
  theme: null,
  inventorySort: 'name',
  categoryFilter: '',
  storeFilter: 'both',
  showHistory: false,
};

let storageErrorNotified = false;

function notifyError(message) {
  if (storageErrorNotified) return;
  storageErrorNotified = true;
  console.warn('Mi Inventario: localStorage no disponible.', message);
  try {
    window.dispatchEvent(new CustomEvent('storage:error', { detail: { message } }));
  } catch {
    /* entorno sin CustomEvent: se ignora */
  }
}

export function get(prefix, key, fallback = null) {
  try {
    const raw = window.localStorage.getItem(prefix + key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (error) {
    notifyError(String(error?.message || error));
    return fallback;
  }
}

export function set(prefix, key, value) {
  try {
    window.localStorage.setItem(prefix + key, JSON.stringify(value));
    return true;
  } catch (error) {
    notifyError(String(error?.message || error));
    return false;
  }
}

export function remove(prefix, key) {
  try {
    window.localStorage.removeItem(prefix + key);
    return true;
  } catch (error) {
    notifyError(String(error?.message || error));
    return false;
  }
}

export function keys(prefix) {
  try {
    const result = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(prefix)) result.push(key);
    }
    return result;
  } catch (error) {
    notifyError(String(error?.message || error));
    return [];
  }
}

export function clear(prefix) {
  keys(prefix).forEach((key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* se ignora */
    }
  });
}

function asArray(value) {
  return Array.isArray(value) ? value.slice(0, MAX_ITEMS) : [];
}

export function getItems() {
  return asArray(get(INVENTORY_PREFIX, 'items', []));
}

export function setItems(items) {
  return set(INVENTORY_PREFIX, 'items', asArray(items));
}

export function getShopping() {
  return asArray(get(SHOPPING_PREFIX, 'items', []));
}

export function setShopping(items) {
  return set(SHOPPING_PREFIX, 'items', asArray(items));
}

export function getSettings() {
  const stored = get(INVENTORY_PREFIX, 'settings', null);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return { ...DEFAULT_SETTINGS };
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function setSettings(settings) {
  return set(INVENTORY_PREFIX, 'settings', settings);
}

export function getHistory() {
  return asArray(get(INVENTORY_PREFIX, 'history', []));
}

export function setHistory(history) {
  return set(INVENTORY_PREFIX, 'history', asArray(history));
}

export function getMeta() {
  const stored = get(SHOPPING_PREFIX, 'meta', null);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return { lastSync: null, lastPricesAt: null };
  }
  return {
    lastSync: stored.lastSync ?? null,
    lastPricesAt: stored.lastPricesAt ?? null,
  };
}

export function setMeta(meta) {
  return set(SHOPPING_PREFIX, 'meta', meta);
}

export function clearAll() {
  clear(INVENTORY_PREFIX);
  clear(SHOPPING_PREFIX);
}

export const Storage = {
  INVENTORY_PREFIX,
  SHOPPING_PREFIX,
  MAX_ITEMS,
  get,
  set,
  remove,
  keys,
  clear,
  getItems,
  setItems,
  getShopping,
  setShopping,
  getSettings,
  setSettings,
  getHistory,
  setHistory,
  getMeta,
  setMeta,
  clearAll,
};

export default Storage;

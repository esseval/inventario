/**
 * state.js — estado compartido en memoria.
 * La fuente de verdad persistente sigue siendo localStorage (storage.js).
 */

export const state = {
  items: [],
  shopping: [],
  filters: { text: '', category: '', sort: 'name' },
  busy: { prices: false, import: false },
  lastPricesAt: null,
};

export function setItems(items) {
  state.items = Array.isArray(items) ? items : [];
}

export function setShopping(items) {
  state.shopping = Array.isArray(items) ? items : [];
}

export function setFilters(filters = {}) {
  state.filters = { ...state.filters, ...filters };
}

export function setBusy(key, value) {
  if (key in state.busy) {
    state.busy[key] = Boolean(value);
  }
}

export default state;

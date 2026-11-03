/**
 * inventario.js — CRUD de elementos, cantidades, mínimos, filtros y resumen.
 */

import Storage from './storage.js';
import { state, setItems, setFilters } from './state.js';
import {
  escapeHtml,
  toast,
  openDialog,
  closeDialog,
  formatQuantity,
  statusBadge,
  itemState,
  stepperHtml,
  confirmDialog,
  createId,
  debounce,
} from './ui.js';

const MAX_ITEMS = Storage.MAX_ITEMS;
const MAX_NAME = 80;
const MAX_CATEGORY = 40;
const MAX_UNIT = 12;
const MAX_QUERY = 80;
const MAX_NOTE = 300;
const MAX_AMOUNT = 99999;

let items = [];
let onChange = null;
let editingId = null;
let deleteCandidateId = null;

function nowIso() {
  return new Date().toISOString();
}

function getElement(id) {
  return document.getElementById(id);
}

function parseAmount(raw) {
  const value = typeof raw === 'string' ? raw.replace(',', '.') : raw;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function roundAmount(value) {
  return Math.round(value * 100) / 100;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createId('itm'),
    name: name.slice(0, MAX_NAME),
    category: (typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'Otros').slice(0, MAX_CATEGORY),
    quantity: Math.max(0, Math.min(MAX_AMOUNT, Number(raw.quantity) || 0)),
    minQuantity: Math.max(0, Math.min(MAX_AMOUNT, Number(raw.minQuantity) || 0)),
    unit: (typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : 'unidad').slice(0, MAX_UNIT),
    query: typeof raw.query === 'string' ? raw.query.trim().slice(0, MAX_QUERY) : '',
    note: typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE) : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  };
}

function load() {
  items = Storage.getItems().map(normalizeItem).filter(Boolean);
  if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);
  setItems(items);
}

function persist() {
  Storage.setItems(items);
  setItems(items);
}

function notify() {
  if (typeof onChange === 'function') {
    onChange(items);
  }
  window.dispatchEvent(new CustomEvent('inventory:changed', { detail: { items } }));
}

function currentSettings() {
  return Storage.getSettings();
}

function saveSettings(patch) {
  Storage.setSettings({ ...currentSettings(), ...patch });
}

/* --------------------------------------------------------------------------
   Render
   -------------------------------------------------------------------------- */

function visibleItems() {
  const text = state.filters.text.trim().toLowerCase();
  const category = state.filters.category;
  const filtered = items.filter((item) => {
    const matchesCategory = !category || item.category === category;
    if (!matchesCategory) return false;
    if (!text) return true;
    const haystack = [item.name, item.category, item.note, item.query].join(' ').toLowerCase();
    return haystack.includes(text);
  });

  const sort = state.filters.sort;
  filtered.sort((a, b) => {
    if (sort === 'status') {
      const rank = { out: 0, low: 1, ok: 2 };
      const diff = (rank[itemState(a)] ?? 3) - (rank[itemState(b)] ?? 3);
      if (diff !== 0) return diff;
    } else if (sort === 'recent') {
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    }
    return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
  });
  return filtered;
}

function render() {
  const tbody = getElement('inventory-list');
  if (!tbody) return;
  const list = visibleItems();

  tbody.innerHTML = list.map((item) => {
    const status = itemState(item);
    const rowClass = status === 'out' ? 'is-out' : status === 'low' ? 'is-low' : '';
    const metaParts = [];
    if (item.query) metaParts.push(`Busca: ${item.query}`);
    if (item.note) metaParts.push(item.note);
    const meta = metaParts.join(' · ');
    const name = escapeHtml(item.name);
    return `<tr class="${rowClass}" data-item-id="${escapeHtml(item.id)}">
      <td data-label="Elemento">
        <span class="item-name">${name}</span>
        ${meta ? `<span class="item-meta" title="${escapeHtml(meta)}">${escapeHtml(meta)}</span>` : ''}
      </td>
      <td data-label="Categoría"><span class="category-tag">${escapeHtml(item.category)}</span></td>
      <td data-label="Cantidad">
        ${stepperHtml(item.quantity, { id: item.id, label: `${item.name} (${item.unit})`, min: 0 })}
        <span class="item-meta">${escapeHtml(item.unit)}</span>
      </td>
      <td data-label="Mínimo" class="cell-num">${formatQuantity(item.minQuantity, item.unit)}</td>
      <td data-label="Estado">${statusBadge(item)}</td>
      <td data-label="Acciones" class="cell-actions">
        <button class="btn btn-small btn-ghost" type="button" data-action="edit" data-item-id="${escapeHtml(item.id)}" aria-label="Editar ${name}" title="Editar">✎ Editar</button>
        <button class="btn btn-small btn-danger" type="button" data-action="delete" data-item-id="${escapeHtml(item.id)}" aria-label="Eliminar ${name}" title="Eliminar">🗑 Eliminar</button>
      </td>
    </tr>`;
  }).join('');

  renderEmpty(list.length);
  renderStats();
  renderCategoryOptions();
}

function renderEmpty(visibleCount) {
  const empty = getElement('inventory-empty');
  if (!empty) return;
  const hasItems = items.length > 0;
  empty.hidden = visibleCount > 0;
  if (!empty.hidden) {
    const title = empty.querySelector('h3');
    const text = empty.querySelector('p');
    const button = empty.querySelector('button');
    if (hasItems) {
      if (title) title.textContent = 'No hay elementos que coincidan con el filtro';
      if (text) text.textContent = 'Probá con otro texto o quitá el filtro de categoría.';
      if (button) {
        button.textContent = 'Limpiar filtros';
        button.dataset.action = 'clear-filters';
      }
    } else {
      if (title) title.textContent = 'Tu inventario está vacío';
      if (text) text.textContent = 'Agregá el primer elemento para empezar a controlar lo que hay en casa.';
      if (button) {
        button.textContent = 'Agregar elemento';
        button.dataset.action = 'add-item';
      }
    }
  }
}

export function renderStats() {
  const total = items.length;
  const low = items.filter((item) => ['low', 'out'].includes(itemState(item))).length;
  const categories = new Set(items.map((item) => item.category).filter(Boolean)).size;

  const totalEl = getElement('inventory-count');
  const lowEl = getElement('inventory-low-count');
  const categoriesEl = getElement('inventory-category-count');
  const sectionCount = getElement('inventory-section-count');

  if (totalEl) totalEl.textContent = String(total);
  if (lowEl) lowEl.textContent = String(low);
  if (categoriesEl) categoriesEl.textContent = String(categories);
  if (sectionCount) sectionCount.textContent = String(visibleItems().length);
}

function renderCategoryOptions() {
  const select = getElement('inventory-category');
  if (!select) return;
  const categories = [...new Set(items.map((item) => item.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));

  const selected = state.filters.category;
  if (selected && !categories.includes(selected)) {
    state.filters.category = '';
    setFilters({ category: '' });
    saveSettings({ categoryFilter: '' });
  }
  const current = state.filters.category;
  select.innerHTML = '<option value="">Todas las categorías</option>'
    + categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  select.value = current;
}

/* --------------------------------------------------------------------------
   Diálogo de alta / edición
   -------------------------------------------------------------------------- */

export function openItemDialog(item = null) {
  const dialog = getElement('item-dialog');
  const form = getElement('item-form');
  if (!dialog || !form) return;

  editingId = item?.id ?? null;
  deleteCandidateId = null;
  form.reset();

  const setValue = (id, value) => {
    const field = getElement(id);
    if (field) field.value = value ?? '';
  };

  setValue('item-name', item?.name ?? '');
  setValue('item-category', item?.category ?? 'Alimentos');
  setValue('item-unit', item?.unit ?? 'unidad');
  setValue('item-quantity', item?.quantity ?? 0);
  setValue('item-min', item?.minQuantity ?? 1);
  setValue('item-query', item?.query ?? '');
  setValue('item-note', item?.note ?? '');

  const title = getElement('item-dialog-title');
  if (title) title.textContent = item ? 'Editar elemento' : 'Agregar elemento';

  const deleteButton = getElement('item-delete');
  if (deleteButton) {
    deleteButton.hidden = !item;
    deleteButton.dataset.itemId = item?.id ?? '';
  }

  const error = getElement('item-error');
  if (error) {
    error.hidden = true;
    error.textContent = '';
  }

  openDialog(dialog);
  window.setTimeout(() => getElement('item-name')?.focus(), 50);
}

function showItemError(message) {
  const error = getElement('item-error');
  if (!error) {
    toast(message, 'error');
    return;
  }
  error.textContent = message;
  error.hidden = false;
}

function saveItem(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;

  const name = String(getElement('item-name')?.value ?? '').trim();
  const category = String(getElement('item-category')?.value ?? '').trim();
  const unit = String(getElement('item-unit')?.value ?? '').trim();
  const quantity = parseAmount(getElement('item-quantity')?.value ?? '');
  const minimum = parseAmount(getElement('item-min')?.value ?? '');
  const query = String(getElement('item-query')?.value ?? '').trim();
  const note = String(getElement('item-note')?.value ?? '').trim();

  if (name.length < 1 || name.length > MAX_NAME) {
    showItemError(`El nombre es obligatorio (1 a ${MAX_NAME} caracteres).`);
    getElement('item-name')?.focus();
    return;
  }
  if (category.length < 1 || category.length > MAX_CATEGORY) {
    showItemError(`La categoría es obligatoria (1 a ${MAX_CATEGORY} caracteres).`);
    getElement('item-category')?.focus();
    return;
  }
  if (unit.length < 1 || unit.length > MAX_UNIT) {
    showItemError(`La unidad es obligatoria (1 a ${MAX_UNIT} caracteres).`);
    getElement('item-unit')?.focus();
    return;
  }
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_AMOUNT) {
    showItemError('La cantidad debe ser un número entre 0 y 99999.');
    getElement('item-quantity')?.focus();
    return;
  }
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > MAX_AMOUNT) {
    showItemError('El mínimo debe ser un número entre 0 y 99999.');
    getElement('item-min')?.focus();
    return;
  }
  if (query.length > MAX_QUERY) {
    showItemError(`El término de búsqueda no puede superar ${MAX_QUERY} caracteres.`);
    return;
  }
  if (note.length > MAX_NOTE) {
    showItemError(`La nota no puede superar ${MAX_NOTE} caracteres.`);
    return;
  }

  const timestamp = nowIso();
  if (editingId) {
    const index = items.findIndex((item) => item.id === editingId);
    if (index === -1) {
      showItemError('El elemento ya no existe. Cerrá y volvé a intentar.');
      return;
    }
    items[index] = {
      ...items[index],
      name,
      category,
      unit,
      quantity: roundAmount(quantity),
      minQuantity: roundAmount(minimum),
      query,
      note,
      updatedAt: timestamp,
    };
  } else {
    if (items.length >= MAX_ITEMS) {
      showItemError(`Llegaste al máximo de ${MAX_ITEMS} elementos.`);
      return;
    }
    items.push({
      id: createId('itm'),
      name,
      category,
      unit,
      quantity: roundAmount(quantity),
      minQuantity: roundAmount(minimum),
      query,
      note,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  persist();
  render();
  notify();
  closeDialog(getElement('item-dialog'));
  toast(editingId ? 'Elemento actualizado.' : 'Elemento agregado.', 'success');
  editingId = null;
}

export function deleteItem(id) {
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  if (!confirmDialog(`¿Eliminar «${item.name}» del inventario? Esta acción no se puede deshacer.`)) {
    return;
  }
  items = items.filter((entry) => entry.id !== id);
  persist();
  render();
  notify();
  closeDialog(getElement('item-dialog'));
  toast('Elemento eliminado.', 'success');
}

export function updateQuantity(id, value) {
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  const parsed = parseAmount(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_AMOUNT) {
    toast('La cantidad debe ser un número entre 0 y 99999.', 'error');
    render();
    return;
  }
  item.quantity = roundAmount(parsed);
  item.updatedAt = nowIso();
  persist();
  render();
  notify();
}

export function addQuantity(id, amount) {
  const item = items.find((entry) => entry.id === id);
  if (!item) return null;
  const delta = Number(amount);
  if (!Number.isFinite(delta) || delta <= 0) return null;
  item.quantity = roundAmount(Math.min(MAX_AMOUNT, item.quantity + delta));
  item.updatedAt = nowIso();
  persist();
  render();
  notify();
  return item;
}

function stepQuantity(id, delta) {
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  updateQuantity(id, Math.max(0, roundAmount(item.quantity + delta)));
}

/* --------------------------------------------------------------------------
   Eventos
   -------------------------------------------------------------------------- */

const debouncedQuantity = debounce((id, value) => updateQuantity(id, value), 400);

function wire() {
  const addButton = getElement('btn-add-item');
  addButton?.addEventListener('click', () => openItemDialog());

  const empty = getElement('inventory-empty');
  empty?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'add-item') openItemDialog();
    if (button.dataset.action === 'clear-filters') {
      const search = getElement('inventory-search');
      const category = getElement('inventory-category');
      if (search) search.value = '';
      if (category) category.value = '';
      setFilters({ text: '', category: '' });
      saveSettings({ categoryFilter: '' });
      render();
    }
  });

  const search = getElement('inventory-search');
  search?.addEventListener('input', debounce(() => {
    setFilters({ text: search.value ?? '' });
    render();
  }, 200));

  const category = getElement('inventory-category');
  category?.addEventListener('change', () => {
    setFilters({ category: category.value ?? '' });
    saveSettings({ categoryFilter: category.value ?? '' });
    render();
  });

  const sort = getElement('inventory-sort');
  sort?.addEventListener('change', () => {
    setFilters({ sort: sort.value || 'name' });
    saveSettings({ inventorySort: sort.value || 'name' });
    render();
  });

  const tbody = getElement('inventory-list');
  tbody?.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const id = button.dataset.itemId;
    if (!id) return;
    if (button.dataset.step) {
      stepQuantity(id, Number(button.dataset.step));
      return;
    }
    const action = button.dataset.action;
    if (action === 'edit') openItemDialog(items.find((item) => item.id === id) ?? null);
    if (action === 'delete') deleteItem(id);
  });

  tbody?.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-item-id]');
    if (!input) return;
    debouncedQuantity(input.dataset.itemId, input.value);
  });

  const form = getElement('item-form');
  form?.addEventListener('submit', saveItem);

  getElement('item-cancel')?.addEventListener('click', () => closeDialog(getElement('item-dialog')));

  getElement('item-delete')?.addEventListener('click', () => {
    const id = getElement('item-delete')?.dataset.itemId;
    if (id) deleteItem(id);
  });

  document.querySelectorAll('#item-dialog [data-close-dialog], #manual-dialog [data-close-dialog], #candidate-dialog [data-close-dialog], #data-dialog [data-close-dialog]')
    .forEach((button) => {
      button.addEventListener('click', () => closeDialog(button.closest('dialog')));
    });
}

/* --------------------------------------------------------------------------
   API pública
   -------------------------------------------------------------------------- */

export function init(options = {}) {
  onChange = typeof options.onChange === 'function' ? options.onChange : null;
  load();

  const settings = currentSettings();
  setFilters({
    sort: settings.inventorySort || 'name',
    category: settings.categoryFilter || '',
    text: '',
  });

  const sort = getElement('inventory-sort');
  if (sort) sort.value = state.filters.sort;
  const category = getElement('inventory-category');
  if (category) category.value = state.filters.category;

  wire();
  render();
  return items;
}

export function getItems() {
  return items;
}

export function reloadFromStorage() {
  load();
  const settings = currentSettings();
  setFilters({ sort: settings.inventorySort || 'name', category: settings.categoryFilter || '' });
  const sort = getElement('inventory-sort');
  if (sort) sort.value = state.filters.sort;
  render();
}

export function getItem(id) {
  return items.find((item) => item.id === id) ?? null;
}

export function getLowItems() {
  return items.filter((item) => item.minQuantity > 0 && item.quantity <= item.minQuantity);
}

export { render, saveItem, nowIso };

export default {
  init,
  render,
  renderStats,
  openItemDialog,
  deleteItem,
  updateQuantity,
  addQuantity,
  getItems,
  getItem,
  getLowItems,
};

/**
 * history.js — historial de compras recibidas (máximo 50 entradas).
 */

import Storage from './storage.js';
import {
  escapeHtml,
  toast,
  confirmDialog,
  formatCurrency,
  formatQuantity,
  formatDate,
  createId,
} from './ui.js';

const MAX_HISTORY = 50;
const STORE_LABELS = {
  coto: 'COTO',
  masonline: 'ChangoMas',
  manual: 'Manual',
};

let entries = [];
let visible = false;

function nowIso() {
  return new Date().toISOString();
}

function getElement(id) {
  return document.getElementById(id);
}

function save() {
  Storage.setHistory(entries);
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.itemName === 'string' ? raw.itemName.trim() : '';
  if (!name) return null;
  const store = ['coto', 'masonline', 'manual'].includes(raw.store) ? raw.store : null;
  const quantity = Number(raw.quantity);
  const unitPrice = Number(raw.unitPrice);
  const total = Number(raw.total);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createId('hist'),
    itemName: name.slice(0, 80),
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    unit: typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim().slice(0, 12) : 'unidad',
    store,
    unitPrice: Number.isFinite(unitPrice) && unitPrice > 0 ? unitPrice : null,
    total: Number.isFinite(total) && total > 0 ? total : null,
    purchasedAt: typeof raw.purchasedAt === 'string' ? raw.purchasedAt : nowIso(),
  };
}

export function render() {
  const list = getElement('history-list');
  const empty = getElement('history-empty');
  const totalLine = getElement('history-total');
  if (!list) return;

  list.innerHTML = entries.map((entry) => {
    const store = entry.store ? (STORE_LABELS[entry.store] || 'Tienda') : 'Sin tienda';
    const price = entry.unitPrice ? formatCurrency(entry.unitPrice) : 'sin precio';
    return `<li class="history-item">
      <div class="history-main">
        <span class="history-name">${escapeHtml(entry.itemName)}</span>
        <span class="history-meta">${escapeHtml(formatQuantity(entry.quantity, entry.unit))} · ${escapeHtml(store)} · ${escapeHtml(price)} por unidad · ${escapeHtml(formatDate(entry.purchasedAt))}</span>
      </div>
      <span class="history-amount">${escapeHtml(entry.total ? formatCurrency(entry.total) : '—')}</span>
    </li>`;
  }).join('');

  if (empty) empty.hidden = entries.length > 0;

  if (totalLine) {
    const spent = entries.reduce((sum, entry) => sum + (entry.total ?? 0), 0);
    if (!entries.length) {
      totalLine.textContent = '';
    } else if (spent > 0) {
      totalLine.textContent = `Total gastado registrado: ${formatCurrency(spent)} en ${entries.length} compra(s).`;
    } else {
      totalLine.textContent = `${entries.length} compra(s) registrada(s), sin precios asociados.`;
    }
  }
}

function updateToggle() {
  const body = getElement('history-body');
  const button = getElement('btn-toggle-history');
  if (body) body.hidden = !visible;
  if (button) {
    button.textContent = visible ? 'Ocultar historial' : 'Mostrar historial';
    button.setAttribute('aria-expanded', String(visible));
  }
}

export function setVisible(next) {
  visible = Boolean(next);
  updateToggle();
  Storage.setSettings({ ...Storage.getSettings(), showHistory: visible });
}

export function add(rawEntry) {
  const entry = normalizeEntry(rawEntry);
  if (!entry) return null;
  entries.unshift(entry);
  entries = entries.slice(0, MAX_HISTORY);
  save();
  render();
  return entry;
}

export function clear() {
  if (!entries.length) {
    toast('El historial ya está vacío.', 'error');
    return;
  }
  if (!confirmDialog('¿Vaciar todo el historial de compras? Esta acción no se puede deshacer.')) {
    return;
  }
  entries = [];
  save();
  render();
  toast('Historial vaciado.', 'success');
}

function wire() {
  getElement('btn-clear-history')?.addEventListener('click', clear);
  getElement('btn-toggle-history')?.addEventListener('click', () => setVisible(!visible));
}

export function init() {
  entries = Storage.getHistory().map(normalizeEntry).filter(Boolean).slice(0, MAX_HISTORY);
  visible = Boolean(Storage.getSettings().showHistory);
  wire();
  updateToggle();
  render();
  return entries;
}

export function getHistory() {
  return entries;
}

export function reloadFromStorage() {
  entries = Storage.getHistory().map(normalizeEntry).filter(Boolean).slice(0, MAX_HISTORY);
  visible = Boolean(Storage.getSettings().showHistory);
  updateToggle();
  render();
}

export default {
  init,
  add,
  render,
  clear,
  setVisible,
  getHistory,
};

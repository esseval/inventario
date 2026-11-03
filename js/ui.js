/**
 * ui.js — utilidades de interfaz: escape, toasts, tema, diálogos y formato.
 * Todo contenido externo debe pasar por escapeHtml antes de innerHTML.
 */

const CURRENCY = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 2,
});

const NUMBER = new Intl.NumberFormat('es-AR', {
  maximumFractionDigits: 2,
});

const DATE_SHORT = new Intl.DateTimeFormat('es-AR', {
  dateStyle: 'short',
  timeStyle: 'short',
});

let toastTimer = null;

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function safeHttpsUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return /^https:\/\//i.test(trimmed) ? trimmed : '';
}

export function truncate(value, max = 80) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function createId(prefix = 'itm') {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}_${crypto.randomUUID()}`;
    }
  } catch {
    /* fallback abajo */
  }
  const random = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${Date.now()}_${random}`;
}

export function toast(message, type = 'info') {
  const element = document.getElementById('toast');
  if (!element) return;
  element.textContent = String(message ?? '');
  element.classList.remove('is-error', 'is-success');
  if (type === 'error') element.classList.add('is-error');
  if (type === 'success') element.classList.add('is-success');
  element.hidden = false;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    element.hidden = true;
    element.classList.remove('is-error', 'is-success');
  }, 3600);
}

export function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  const icon = document.getElementById('theme-icon');
  const button = document.getElementById('btn-theme');
  if (icon) icon.textContent = next === 'dark' ? '☀️' : '🌙';
  if (button) {
    const label = next === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }
  return next;
}

export function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

export function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function' && dialog.open) {
    dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
}

export function formatCurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  return CURRENCY.format(number);
}

export function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return NUMBER.format(number);
}

export function formatQuantity(value, unit = '') {
  const suffix = unit ? ` ${unit}` : '';
  return `${formatNumber(value)}${suffix}`;
}

export function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_SHORT.format(date);
}

export function relativeTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'ahora';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'ayer';
  return `hace ${days} días`;
}

export function isStale(iso, hours = 24) {
  if (!iso) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  return Date.now() - date.getTime() > hours * 3600 * 1000;
}

export function itemState(item) {
  const quantity = Number(item?.quantity ?? 0);
  const minimum = Number(item?.minQuantity ?? 0);
  if (quantity <= 0) return 'out';
  if (minimum > 0 && quantity <= minimum) return 'low';
  return 'ok';
}

export function statusBadge(item) {
  const status = itemState(item);
  if (status === 'out') return '<span class="badge badge-out">✕ Agotado</span>';
  if (status === 'low') return '<span class="badge badge-low">⚠ Bajo</span>';
  return '<span class="badge badge-ok">✓ OK</span>';
}

/**
 * Stepper numérico accesible.
 * @param {number} value
 * @param {{id?: string, attr?: 'data-item-id'|'data-shop-id', label?: string, min?: number, step?: number, small?: boolean}} options
 */
export function stepperHtml(value, options = {}) {
  const {
    id = '',
    attr = 'data-item-id',
    label = 'cantidad',
    min = 0,
    step = 0.01,
    small = false,
  } = options;
  const safeAttr = attr === 'data-shop-id' ? 'data-shop-id' : 'data-item-id';
  const safeId = escapeHtml(id);
  const safeLabel = escapeHtml(label);
  const numeric = Number(value);
  const display = Number.isFinite(numeric) ? String(Math.round(numeric * 100) / 100) : '0';
  return `<div class="stepper${small ? ' stepper-sm' : ''}">
    <button type="button" ${safeAttr}="${safeId}" data-step="-1" aria-label="Restar a ${safeLabel}" title="Restar">−</button>
    <input type="number" ${safeAttr}="${safeId}" value="${display}" min="${min}" max="99999" step="${step}" inputmode="decimal" aria-label="Cantidad de ${safeLabel}">
    <button type="button" ${safeAttr}="${safeId}" data-step="1" aria-label="Sumar a ${safeLabel}" title="Sumar">＋</button>
  </div>`;
}

export function attachImgFallback(img, emoji = '🛒') {
  if (!img) return;
  img.addEventListener('error', () => {
    const fallback = document.createElement('span');
    fallback.className = 'candidate-img-fallback';
    fallback.setAttribute('aria-hidden', 'true');
    fallback.textContent = emoji;
    img.replaceWith(fallback);
  }, { once: true });
}

export function confirmDialog(message) {
  return window.confirm(message);
}

export function debounce(fn, delay = 300) {
  let timer = null;
  return function debounced(...args) {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * compras.js — listado de compras, sincronización con mínimos, precios,
 * elección de candidatos, totales y recepción de mercadería.
 */

import Storage from './storage.js';
import { state, setShopping } from './state.js';
import {
  escapeHtml,
  safeHttpsUrl,
  truncate,
  toast,
  openDialog,
  closeDialog,
  formatCurrency,
  formatQuantity,
  formatDate,
  relativeTime,
  isStale,
  stepperHtml,
  confirmDialog,
  createId,
  debounce,
  attachImgFallback,
} from './ui.js';
import { getPricesBatch } from './api.js';
import {
  getLowItems,
  getItem,
  addQuantity,
  openItemDialog,
} from './inventario.js';
import * as history from './history.js';

const STORES = ['coto', 'masonline'];
const STORE_LABELS = { coto: 'COTO', masonline: 'ChangoMas' };
const MAX_NAME = 80;
const MAX_CATEGORY = 40;
const MAX_UNIT = 12;
const MAX_AMOUNT = 99999;

let shopping = [];
let pricesBusy = false;
let candidateContext = null;

function nowIso() {
  return new Date().toISOString();
}

function getElement(id) {
  return document.getElementById(id);
}

function roundAmount(value) {
  return Math.round(value * 100) / 100;
}

function parseAmount(raw) {
  const value = typeof raw === 'string' ? raw.replace(',', '.') : raw;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function blankPrice() {
  return {
    status: 'empty',
    selected: null,
    best: null,
    candidates: [],
    error: null,
    fetchedAt: null,
  };
}

function blankPrices() {
  return { coto: blankPrice(), masonline: blankPrice() };
}

/* --------------------------------------------------------------------------
   Normalización y persistencia
   -------------------------------------------------------------------------- */

function normalizeCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const price = Number(raw.price);
  if (!name || !Number.isFinite(price) || price <= 0) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: name.slice(0, 140),
    brand: typeof raw.brand === 'string' ? raw.brand.slice(0, 60) : '',
    package: typeof raw.package === 'string' ? raw.package.slice(0, 80) : '',
    price,
    listPrice: Number.isFinite(Number(raw.listPrice)) ? Number(raw.listPrice) : price,
    promo: typeof raw.promo === 'string' ? raw.promo.slice(0, 120) : null,
    image: safeHttpsUrl(raw.image) || null,
    url: safeHttpsUrl(raw.url) || null,
    available: raw.available !== false,
    score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : 0,
  };
}

function normalizePriceEntry(raw) {
  if (!raw || typeof raw !== 'object') return blankPrice();
  const status = ['ok', 'empty', 'error'].includes(raw.status) ? raw.status : 'empty';
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.map(normalizeCandidate).filter(Boolean).slice(0, 5)
    : [];
  const selected = normalizeCandidate(raw.selected);
  const best = normalizeCandidate(raw.best);
  return {
    status,
    selected,
    best,
    candidates,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 240) : null,
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null,
  };
}

function normalizePrices(raw) {
  const prices = blankPrices();
  if (!raw || typeof raw !== 'object') return prices;
  STORES.forEach((store) => {
    prices[store] = normalizePriceEntry(raw[store]);
  });
  return prices;
}

function normalizeShopping(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  const status = raw.status === 'completed' ? 'completed' : 'pending';
  const currentQuantity = parseAmount(raw.currentQuantity);
  const minQuantity = parseAmount(raw.minQuantity);
  const buyQuantity = parseAmount(raw.buyQuantity);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createId('shop'),
    sourceItemId: typeof raw.sourceItemId === 'string' && raw.sourceItemId ? raw.sourceItemId : null,
    manual: Boolean(raw.manual),
    name: name.slice(0, MAX_NAME),
    category: (typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'Otros').slice(0, MAX_CATEGORY),
    unit: (typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : 'unidad').slice(0, MAX_UNIT),
    query: typeof raw.query === 'string' ? raw.query.trim().slice(0, 80) : name.slice(0, 80),
    currentQuantity: Number.isFinite(currentQuantity) ? Math.max(0, currentQuantity) : null,
    minQuantity: Number.isFinite(minQuantity) ? Math.max(0, minQuantity) : null,
    buyQuantity: Number.isFinite(buyQuantity) && buyQuantity > 0
      ? Math.min(MAX_AMOUNT, buyQuantity)
      : 1,
    buyQuantityEdited: Boolean(raw.buyQuantityEdited),
    checked: Boolean(raw.checked),
    status,
    prices: normalizePrices(raw.prices),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
  };
}

function load() {
  shopping = Storage.getShopping().map(normalizeShopping).filter(Boolean);
  setShopping(shopping);
}

function save() {
  Storage.setShopping(shopping);
  setShopping(shopping);
}

function emit() {
  window.dispatchEvent(new CustomEvent('shopping:changed', { detail: { shopping } }));
}

/* --------------------------------------------------------------------------
   Sincronización con el inventario
   -------------------------------------------------------------------------- */

function defaultBuyQuantity(item) {
  return Math.max(1, Math.ceil(Math.max(0, item.minQuantity - item.quantity)));
}

function createFromItem(item) {
  const timestamp = nowIso();
  return {
    id: createId('shop'),
    sourceItemId: item.id,
    manual: false,
    name: item.name,
    category: item.category,
    unit: item.unit,
    query: item.query || item.name,
    currentQuantity: item.quantity,
    minQuantity: item.minQuantity,
    buyQuantity: defaultBuyQuantity(item),
    buyQuantityEdited: false,
    checked: false,
    status: 'pending',
    prices: blankPrices(),
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

export function sync() {
  const low = getLowItems();
  const lowIds = new Set(low.map((item) => item.id));

  const groups = new Map();
  shopping.forEach((row) => {
    if (!row.sourceItemId) return;
    const group = groups.get(row.sourceItemId) ?? { pending: null, completed: null };
    if (row.status === 'completed') {
      if (!group.completed) group.completed = row;
    } else if (!group.pending) {
      group.pending = row;
    }
    groups.set(row.sourceItemId, group);
  });

  low.forEach((item) => {
    const group = groups.get(item.id) ?? { pending: null, completed: null };
    if (group.completed) {
      // Una compra completada se conserva hasta que el usuario limpie los comprados.
      return;
    }
    if (group.pending) {
      const row = group.pending;
      row.name = item.name;
      row.category = item.category;
      row.unit = item.unit;
      row.query = item.query || item.name;
      row.currentQuantity = item.quantity;
      row.minQuantity = item.minQuantity;
      if (!row.buyQuantityEdited) {
        row.buyQuantity = defaultBuyQuantity(item);
      }
      row.updatedAt = nowIso();
      return;
    }
    shopping.push(createFromItem(item));
  });

  shopping = shopping.filter((row) => {
    if (row.manual || row.status === 'completed') return true;
    return Boolean(row.sourceItemId && lowIds.has(row.sourceItemId));
  });

  const meta = Storage.getMeta();
  Storage.setMeta({ ...meta, lastSync: nowIso() });
  save();
  emit();
  return shopping;
}

/* --------------------------------------------------------------------------
   Render
   -------------------------------------------------------------------------- */

function orderedRows() {
  const rank = (row) => (row.status === 'completed' ? 1 : 0);
  return [...shopping].sort((a, b) => {
    const byStatus = rank(a) - rank(b);
    if (byStatus !== 0) return byStatus;
    const byCategory = String(a.category).localeCompare(String(b.category), 'es', { sensitivity: 'base' });
    if (byCategory !== 0) return byCategory;
    return String(a.name).localeCompare(String(b.name), 'es', { sensitivity: 'base' });
  });
}

function selectedFor(row, store) {
  return row.prices?.[store]?.selected ?? null;
}

function bestStoreForRow(row) {
  const options = STORES
    .map((store) => {
      const selected = selectedFor(row, store);
      return selected ? { store, price: Number(selected.price) } : null;
    })
    .filter((entry) => entry && Number.isFinite(entry.price) && entry.price > 0)
    .sort((a, b) => a.price - b.price);
  return options.length ? options[0].store : null;
}

function bestSelection(row) {
  const options = STORES
    .map((store) => {
      const selected = selectedFor(row, store);
      return selected ? { store, price: Number(selected.price) } : null;
    })
    .filter((entry) => entry && Number.isFinite(entry.price) && entry.price > 0)
    .sort((a, b) => a.price - b.price);
  return options.length ? options[0] : null;
}

function priceButtons(row, store) {
  if (row.status === 'completed') return '';
  const label = STORE_LABELS[store];
  return `<div class="cell-price-actions">
    <button class="btn btn-small btn-ghost" type="button" data-action="choose-price" data-src="${store}" data-shop-id="${escapeHtml(row.id)}" aria-label="Elegir producto en ${label} para ${escapeHtml(row.name)}">Elegir</button>
    <button class="btn btn-small btn-ghost" type="button" data-action="refresh-price" data-shop-id="${escapeHtml(row.id)}" aria-label="Actualizar precio de ${escapeHtml(row.name)}">↻</button>
  </div>`;
}

function priceCell(row, store) {
  const entry = row.prices?.[store];
  const label = STORE_LABELS[store];
  if (pricesBusy && row.status === 'pending') {
    return '<span class="spinner" aria-label="Consultando precio"></span>';
  }
  if (!entry) return '<span class="price-empty">Sin consultar</span>';

  const selected = entry.selected;
  const buttons = priceButtons(row, store);
  if (selected) {
    const isBest = bestStoreForRow(row) === store;
    const url = safeHttpsUrl(selected.url);
    const stale = isStale(entry.fetchedAt) ? '<span class="price-stale">Desactualizado</span>' : '';
    const name = escapeHtml(truncate(selected.name, 38));
    const link = url
      ? `<a class="price-product" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(selected.name)}">${name} ↗</a>`
      : `<span class="price-product" title="${escapeHtml(selected.name)}">${name}</span>`;
    const error = entry.error
      ? `<span class="price-error" title="${escapeHtml(entry.error)}">⚠ ${escapeHtml(truncate(entry.error, 32))}</span>`
      : '';
    return `<span class="store-tag store-${store}">${label}</span>
      <span class="price-value${isBest ? ' is-best' : ''}">${formatCurrency(selected.price)}</span>${stale}
      ${link}${error}${buttons}`;
  }

  if (entry.error) {
    return `<span class="price-error" title="${escapeHtml(entry.error)}">No disponible</span>${buttons}`;
  }
  return `<span class="price-empty">Sin coincidencia</span>${buttons}`;
}

function bestCell(row) {
  const selection = bestSelection(row);
  if (!selection) return '<span class="price-empty">—</span>';
  return `<span class="store-tag store-${selection.store}">${STORE_LABELS[selection.store]}</span>
    <span class="price-value is-best">${formatCurrency(selection.price)}</span>`;
}

function actionCell(row) {
  const name = escapeHtml(row.name);
  if (row.status === 'completed') {
    return `<span class="badge badge-done">✓ Comprado</span>
      ${row.manual ? `<button class="btn btn-small btn-danger" type="button" data-action="remove-manual" data-shop-id="${escapeHtml(row.id)}" aria-label="Quitar ${name} de la lista">Quitar</button>` : ''}`;
  }
  const parts = [
    `<button class="btn btn-small btn-primary" type="button" data-action="receive" data-shop-id="${escapeHtml(row.id)}" aria-label="Marcar ${name} como recibido">✓ Recibido</button>`,
  ];
  if (!row.manual && row.sourceItemId && getItem(row.sourceItemId)) {
    parts.push(`<button class="btn btn-small btn-ghost" type="button" data-action="open-item" data-shop-id="${escapeHtml(row.id)}" aria-label="Editar ${name} en el inventario">✎ Elemento</button>`);
  }
  if (row.manual) {
    parts.push(`<button class="btn btn-small btn-danger" type="button" data-action="remove-manual" data-shop-id="${escapeHtml(row.id)}" aria-label="Quitar ${name} de la lista">🗑 Quitar</button>`);
  }
  return parts.join('');
}

export function render() {
  const tbody = getElement('shopping-list');
  if (!tbody) return;
  const rows = orderedRows();

  tbody.innerHTML = rows.map((row) => {
    const completed = row.status === 'completed';
    const currentLabel = row.currentQuantity === null
      ? '—'
      : formatQuantity(row.currentQuantity, row.unit);
    const buyCell = completed
      ? `<span class="cell-num">${escapeHtml(formatQuantity(row.buyQuantity, row.unit))}</span>`
      : `${stepperHtml(row.buyQuantity, { id: row.id, attr: 'data-shop-id', label: `${row.name} (${row.unit})`, min: 0.01 })}`;
    const query = row.manual ? 'Suelto' : 'En mínimo';
    return `<tr class="${completed ? 'is-completed' : ''}" data-shop-id="${escapeHtml(row.id)}">
      <td class="check-cell" data-label="Comprado">
        <input type="checkbox" data-shop-id="${escapeHtml(row.id)}" ${row.checked ? 'checked' : ''} aria-label="Marcar ${escapeHtml(row.name)} como comprado">
      </td>
      <td data-label="Elemento">
        <span class="item-name">${escapeHtml(row.name)}</span>
        <span class="item-meta">${escapeHtml(row.category)} · ${query}</span>
      </td>
      <td data-label="Cantidad actual" class="cell-num">${escapeHtml(currentLabel)}</td>
      <td data-label="Comprar">${buyCell}</td>
      <td data-label="COTO" class="price-cell">${priceCell(row, 'coto')}</td>
      <td data-label="ChangoMas" class="price-cell">${priceCell(row, 'masonline')}</td>
      <td data-label="Mejor" class="price-cell">${bestCell(row)}</td>
      <td data-label="Acciones" class="cell-actions">${actionCell(row)}</td>
    </tr>`;
  }).join('');

  const empty = getElement('shopping-empty');
  if (empty) empty.hidden = rows.length > 0;

  const count = getElement('shopping-count');
  if (count) count.textContent = String(rows.filter((row) => row.status === 'pending').length);
}

export function renderTotals() {
  const pending = shopping.filter((row) => row.status === 'pending');
  let totalCoto = 0;
  let totalMasonline = 0;
  let totalBest = 0;
  let cotoCount = 0;
  let masonlineCount = 0;
  let bestCount = 0;

  pending.forEach((row) => {
    const quantity = Number(row.buyQuantity) || 0;
    const coto = Number(selectedFor(row, 'coto')?.price);
    const masonline = Number(selectedFor(row, 'masonline')?.price);
    const prices = [];

    if (Number.isFinite(coto) && coto > 0) {
      totalCoto += coto * quantity;
      cotoCount += 1;
      prices.push(coto);
    }
    if (Number.isFinite(masonline) && masonline > 0) {
      totalMasonline += masonline * quantity;
      masonlineCount += 1;
      prices.push(masonline);
    }
    if (prices.length) {
      totalBest += Math.min(...prices) * quantity;
      bestCount += 1;
    }
  });

  const setText = (id, value, count) => {
    const element = getElement(id);
    if (!element) return;
    element.textContent = count > 0 ? formatCurrency(value) : '—';
  };
  setText('shopping-total-coto', totalCoto, cotoCount);
  setText('shopping-total-masonline', totalMasonline, masonlineCount);
  setText('shopping-total-best', totalBest, bestCount);

  const note = getElement('shopping-total-note');
  if (note) {
    note.textContent = pending.length
      ? `Estimado sobre ${bestCount} de ${pending.length} elemento(s) con precio. El precio es por unidad de venta y puede no coincidir con el gramaje exacto.`
      : 'Todavía no hay elementos pendientes con precio consultado.';
  }
}

function setPriceStatus(text, type = '') {
  const element = getElement('price-status');
  if (!element) return;
  element.textContent = text;
  element.classList.remove('is-error', 'is-success');
  if (type === 'error') element.classList.add('is-error');
  if (type === 'success') element.classList.add('is-success');
}

function setRefreshBusy(busy) {
  const button = getElement('btn-refresh-prices');
  if (!button) return;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.innerHTML = busy
    ? '<span class="spinner" aria-hidden="true"></span> Actualizando…'
    : '↻ Actualizar precios';
}

/* --------------------------------------------------------------------------
   Consulta de precios
   -------------------------------------------------------------------------- */

function candidateKey(candidate) {
  if (!candidate) return '';
  const id = candidate.id || candidate.url || candidate.name || '';
  return `${id}|${candidate.price ?? ''}`;
}

function queryFor(row) {
  if (row.sourceItemId) {
    const item = getItem(row.sourceItemId);
    if (item) return item.query || item.name;
  }
  return row.query || row.name;
}

async function runPriceRequest(items, label) {
  if (!items.length) {
    toast('No hay elementos pendientes para consultar.', 'error');
    return;
  }
  pricesBusy = true;
  setRefreshBusy(true);
  setPriceStatus(label);
  render();

  let updated = 0;
  let failures = 0;
  try {
    const data = await getPricesBatch(items, STORES);
    const results = Array.isArray(data?.results) ? data.results : [];
    const byId = new Map(results.map((result) => [result.id, result]));

    items.forEach((item) => {
      const row = shopping.find((entry) => entry.id === item.id);
      const result = byId.get(item.id);
      if (!row || !result?.stores) {
        failures += 1;
        return;
      }
      let rowUpdated = false;
      STORES.forEach((store) => {
        const storeResult = result.stores[store];
        if (!storeResult) return;
        const previous = row.prices?.[store] ?? blankPrice();
        if (storeResult.ok) {
          const candidates = Array.isArray(storeResult.candidates)
            ? storeResult.candidates.map(normalizeCandidate).filter(Boolean)
            : [];
          const best = normalizeCandidate(storeResult.best);
          const previousKey = candidateKey(previous.selected);
          const keepSelection = previousKey && candidates.some((candidate) => candidateKey(candidate) === previousKey);
          row.prices[store] = {
            status: candidates.length ? 'ok' : 'empty',
            selected: keepSelection ? previous.selected : best,
            best,
            candidates: candidates.slice(0, 5),
            error: null,
            fetchedAt: storeResult.fetchedAt || nowIso(),
          };
          rowUpdated = true;
        } else {
          failures += 1;
          row.prices[store] = {
            ...previous,
            error: storeResult.error || 'No se pudo consultar la tienda.',
          };
        }
      });
      if (rowUpdated) updated += 1;
      row.updatedAt = nowIso();
    });

    const stamp = nowIso();
    Storage.setMeta({ ...Storage.getMeta(), lastPricesAt: stamp });
    save();
    setPriceStatus(
      `Precios actualizados ${relativeTime(stamp)}${failures ? ` · ${failures} consulta(s) con problemas` : ''}.`,
      failures ? 'error' : 'success',
    );
    if (Array.isArray(data?.warnings) && data.warnings.length) {
      toast(data.warnings[0], 'error');
    }
    toast(`Precios actualizados: ${updated} de ${items.length}.`, updated ? 'success' : 'error');
  } catch (error) {
    const message = error?.message || 'No se pudieron actualizar los precios.';
    setPriceStatus(message, 'error');
    toast(message, 'error');
  } finally {
    pricesBusy = false;
    setRefreshBusy(false);
    save();
    render();
    renderTotals();
    emit();
  }
}

function refreshAllPrices() {
  if (pricesBusy) return;
  const pending = getPending();
  if (!pending.length) {
    toast('No hay elementos pendientes para consultar.', 'error');
    return;
  }
  const items = pending.map((row) => ({ id: row.id, q: queryFor(row) }));
  runPriceRequest(items, `Actualizando precios de ${items.length} elemento(s)…`);
}

function refreshPrice(shopId) {
  if (pricesBusy) return;
  const row = shopping.find((entry) => entry.id === shopId);
  if (!row) return;
  runPriceRequest([{ id: row.id, q: queryFor(row) }], `Actualizando precio de ${row.name}…`);
}

/* --------------------------------------------------------------------------
   Candidatos
   -------------------------------------------------------------------------- */

function choosePrice(shopId, store) {
  const row = shopping.find((entry) => entry.id === shopId);
  if (!row || !STORES.includes(store)) return;
  const entry = row.prices?.[store] ?? blankPrice();
  const candidates = entry.candidates ?? [];
  const label = STORE_LABELS[store];

  candidateContext = { shopId, store };
  const title = getElement('candidate-title');
  if (title) title.textContent = `Elegir en ${label}`;
  const list = getElement('candidate-list');
  if (!list) return;

  if (!candidates.length) {
    list.innerHTML = '<p class="empty-state">No hay candidatos guardados. Actualizá los precios y volvé a intentar.</p>';
  } else {
    list.innerHTML = candidates.map((candidate) => {
      const image = safeHttpsUrl(candidate.image);
      const url = safeHttpsUrl(candidate.url);
      const isSelected = entry.selected && candidateKey(entry.selected) === candidateKey(candidate);
      const meta = [candidate.brand, candidate.package].filter(Boolean).map(escapeHtml).join(' · ');
      return `<article class="candidate">
        ${image
          ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(candidate.name)}" loading="lazy" referrerpolicy="no-referrer">`
          : '<span class="candidate-img-fallback" aria-hidden="true">🛒</span>'}
        <div class="candidate-info">
          <p class="candidate-name">${escapeHtml(candidate.name)}</p>
          <span class="candidate-meta">${meta || 'Sin marca ni formato'}</span>
          <span class="candidate-meta">${isSelected ? '✓ Seleccionado · ' : ''}Coincidencia ${Number(candidate.score) || 0}%</span>
          ${url ? `<a class="price-product" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Ver en ${label} ↗</a>` : ''}
        </div>
        <div class="candidate-actions">
          <span class="candidate-price">${formatCurrency(candidate.price)}</span>
          <button class="btn btn-small btn-primary" type="button" data-action="pick-candidate" data-src="${store}" data-shop-id="${escapeHtml(row.id)}" data-candidate-id="${escapeHtml(candidateKey(candidate))}">Elegir</button>
        </div>
      </article>`;
    }).join('');
  }

  openDialog(getElement('candidate-dialog'));
  list.querySelectorAll('img').forEach((img) => attachImgFallback(img));
}

function applyCandidate(shopId, store, key) {
  const row = shopping.find((entry) => entry.id === shopId);
  if (!row || !STORES.includes(store)) return;
  const entry = row.prices?.[store];
  if (!entry) return;
  const candidate = (entry.candidates ?? []).find((item) => candidateKey(item) === key);
  if (!candidate) {
    toast('No se encontró el producto elegido. Actualizá los precios.', 'error');
    return;
  }
  entry.selected = candidate;
  entry.status = 'ok';
  entry.error = null;
  row.updatedAt = nowIso();
  save();
  closeDialog(getElement('candidate-dialog'));
  render();
  renderTotals();
  emit();
  toast(`Producto elegido en ${STORE_LABELS[store]}.`, 'success');
}

/* --------------------------------------------------------------------------
   Recepción, cantidades y elementos sueltos
   -------------------------------------------------------------------------- */

export function receive(shopId) {
  const row = shopping.find((entry) => entry.id === shopId);
  if (!row || row.status === 'completed') return;
  const quantity = Math.max(0.01, Number(row.buyQuantity) || 1);
  const selection = bestSelection(row);
  const unitPrice = selection?.price ?? null;
  const total = unitPrice ? roundAmount(unitPrice * quantity) : null;

  // 1) Completar primero: así la sincronización no borra la fila al cambiar el inventario.
  row.status = 'completed';
  row.checked = true;
  row.completedAt = nowIso();
  row.updatedAt = nowIso();
  save();
  render();
  renderTotals();
  emit();

  // 2) Reintegrar al inventario si corresponde.
  if (row.sourceItemId) {
    const updated = addQuantity(row.sourceItemId, quantity);
    if (!updated) {
      toast('El elemento original ya no existe; la compra quedó registrada igual.', 'error');
    }
  }

  // 3) Historial de compras.
  history.add({
    itemName: row.name,
    quantity,
    unit: row.unit,
    store: selection?.store ?? (row.manual ? 'manual' : null),
    unitPrice,
    total,
    purchasedAt: nowIso(),
  });

  toast(`Inventario actualizado: +${formatQuantity(quantity, row.unit)}.`, 'success');
}

export function setChecked(shopId, checked) {
  const row = shopping.find((entry) => entry.id === shopId);
  if (!row) return;
  row.checked = Boolean(checked);
  row.updatedAt = nowIso();
  save();
  render();
  renderTotals();
  emit();
}

export function setBuyQuantity(shopId, value) {
  const row = shopping.find((entry) => entry.id === shopId);
  if (!row) return;
  const quantity = parseAmount(value);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_AMOUNT) {
    toast('La cantidad a comprar debe ser mayor que 0 y menor que 99999.', 'error');
    render();
    return;
  }
  row.buyQuantity = roundAmount(quantity);
  row.buyQuantityEdited = true;
  row.updatedAt = nowIso();
  save();
  render();
  renderTotals();
  emit();
}

function stepBuyQuantity(shopId, delta) {
  const row = shopping.find((entry) => entry.id === shopId);
  if (!row) return;
  setBuyQuantity(shopId, Math.max(0.01, roundAmount(Number(row.buyQuantity) + delta)));
}

function openManualDialog() {
  const form = getElement('manual-form');
  form?.reset();
  const error = getElement('manual-error');
  if (error) {
    error.hidden = true;
    error.textContent = '';
  }
  const defaults = { 'manual-category': 'Otros', 'manual-unit': 'unidad', 'manual-quantity': '1' };
  Object.entries(defaults).forEach(([id, value]) => {
    const field = getElement(id);
    if (field) field.value = value;
  });
  openDialog(getElement('manual-dialog'));
  window.setTimeout(() => getElement('manual-name')?.focus(), 50);
}

function showManualError(message) {
  const error = getElement('manual-error');
  if (!error) {
    toast(message, 'error');
    return;
  }
  error.textContent = message;
  error.hidden = false;
}

function addManual(event) {
  event.preventDefault();
  const name = String(getElement('manual-name')?.value ?? '').trim();
  const category = String(getElement('manual-category')?.value ?? '').trim() || 'Otros';
  const unit = String(getElement('manual-unit')?.value ?? '').trim() || 'unidad';
  const quantity = parseAmount(getElement('manual-quantity')?.value ?? '');

  if (name.length < 1 || name.length > MAX_NAME) {
    showManualError(`El nombre es obligatorio (1 a ${MAX_NAME} caracteres).`);
    return;
  }
  if (category.length > MAX_CATEGORY) {
    showManualError(`La categoría no puede superar ${MAX_CATEGORY} caracteres.`);
    return;
  }
  if (unit.length > MAX_UNIT) {
    showManualError(`La unidad no puede superar ${MAX_UNIT} caracteres.`);
    return;
  }
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_AMOUNT) {
    showManualError('La cantidad a comprar debe ser mayor que 0 y menor que 99999.');
    return;
  }

  const timestamp = nowIso();
  shopping.push({
    id: createId('shop'),
    sourceItemId: null,
    manual: true,
    name,
    category,
    unit,
    query: name,
    currentQuantity: null,
    minQuantity: null,
    buyQuantity: roundAmount(quantity),
    buyQuantityEdited: true,
    checked: false,
    status: 'pending',
    prices: blankPrices(),
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  });

  save();
  closeDialog(getElement('manual-dialog'));
  render();
  renderTotals();
  emit();
  toast('Elemento suelto agregado a la lista.', 'success');
}

function removeManual(shopId) {
  const row = shopping.find((entry) => entry.id === shopId);
  if (!row || !row.manual) return;
  if (!confirmDialog(`¿Quitar «${row.name}» de la lista de compras?`)) return;
  shopping = shopping.filter((entry) => entry.id !== shopId);
  save();
  render();
  renderTotals();
  emit();
  toast('Elemento quitado de la lista.', 'success');
}

function clearCompleted() {
  const completed = shopping.filter((row) => row.status === 'completed');
  if (!completed.length) {
    toast('No hay compras completadas para limpiar.', 'error');
    return;
  }
  if (!confirmDialog(`¿Eliminar ${completed.length} fila(s) comprada(s) de la lista? El historial se conserva.`)) {
    return;
  }
  shopping = shopping.filter((row) => row.status !== 'completed');
  save();
  render();
  renderTotals();
  emit();
  toast('Compras completadas quitadas de la lista.', 'success');
}

/* --------------------------------------------------------------------------
   Eventos
   -------------------------------------------------------------------------- */

const debouncedBuy = debounce((shopId, value) => setBuyQuantity(shopId, value), 400);

function wire() {
  getElement('btn-refresh-prices')?.addEventListener('click', refreshAllPrices);
  getElement('btn-add-manual')?.addEventListener('click', openManualDialog);
  getElement('shopping-empty')?.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="add-manual"]')) openManualDialog();
  });
  getElement('btn-clear-completed')?.addEventListener('click', clearCompleted);
  getElement('manual-form')?.addEventListener('submit', addManual);
  getElement('manual-cancel')?.addEventListener('click', () => closeDialog(getElement('manual-dialog')));

  const tbody = getElement('shopping-list');
  tbody?.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const shopId = button.dataset.shopId;
    if (!shopId) return;

    if (button.dataset.step) {
      stepBuyQuantity(shopId, Number(button.dataset.step));
      return;
    }

    const action = button.dataset.action;
    if (action === 'receive') receive(shopId);
    if (action === 'choose-price') choosePrice(shopId, button.dataset.src);
    if (action === 'refresh-price') refreshPrice(shopId);
    if (action === 'remove-manual') removeManual(shopId);
    if (action === 'open-item') {
      const row = shopping.find((entry) => entry.id === shopId);
      const item = row?.sourceItemId ? getItem(row.sourceItemId) : null;
      if (item) openItemDialog(item);
      else toast('El elemento original ya no existe en el inventario.', 'error');
    }
  });

  tbody?.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[type="checkbox"][data-shop-id]');
    if (checkbox) {
      setChecked(checkbox.dataset.shopId, checkbox.checked);
      return;
    }
    const input = event.target.closest('input[data-shop-id]');
    if (input) debouncedBuy(input.dataset.shopId, input.value);
  });

  getElement('candidate-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="pick-candidate"]');
    if (!button) return;
    applyCandidate(button.dataset.shopId, button.dataset.src, button.dataset.candidateId);
  });

  getElement('candidate-close')?.addEventListener('click', () => {
    candidateContext = null;
    closeDialog(getElement('candidate-dialog'));
  });
}

/* --------------------------------------------------------------------------
   API pública
   -------------------------------------------------------------------------- */

export function init() {
  load();
  wire();
  render();
  renderTotals();

  const meta = Storage.getMeta();
  if (meta.lastPricesAt) {
    setPriceStatus(`Última actualización de precios: ${relativeTime(meta.lastPricesAt)} · ${formatDate(meta.lastPricesAt)}`);
  } else {
    setPriceStatus('Todavía no consultaste precios. Usá «Actualizar precios».');
  }
  return shopping;
}

export function getShopping() {
  return shopping;
}

export function reloadFromStorage() {
  load();
  render();
  renderTotals();
}

export function getPending() {
  return shopping.filter((row) => row.status === 'pending');
}

export { refreshAllPrices, refreshPrice, choosePrice, addManual, removeManual, clearCompleted };

export default {
  init,
  render,
  renderTotals,
  sync,
  receive,
  setChecked,
  setBuyQuantity,
  getShopping,
  getPending,
  refreshAllPrices,
  refreshPrice,
  choosePrice,
  clearCompleted,
};

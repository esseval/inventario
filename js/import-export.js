/**
 * import-export.js — exportar, importar y borrar datos.
 * Acepta JSON propio y TXT tabulado (también generado por esta app).
 */

import Storage from './storage.js';
import {
  toast,
  openDialog,
  formatCurrency,
  formatDate,
  itemState,
  safeHttpsUrl,
  createId,
  confirmDialog,
} from './ui.js';

const APP_ID = 'mi-inventario';
const VERSION = 1;
const MAX_ITEMS = 1000;
const MAX_AMOUNT = 99999;

function nowIso() {
  return new Date().toISOString();
}

function getElement(id) {
  return document.getElementById(id);
}

function stamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function download(filename, text, mime = 'application/json;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function txtCell(value) {
  return String(value ?? '')
    .replaceAll('\t', ' ')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .trim();
}

function parseNumeric(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const clean = String(raw).replace(/[^\d,.-]/g, '').replace(',', '.');
  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
}

function clampAmount(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(MAX_AMOUNT, Math.round(number * 100) / 100));
}

function textValue(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isoOr(value) {
  if (typeof value !== 'string') return nowIso();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? nowIso() : date.toISOString();
}

function normalizeKeyText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function itemKey(item) {
  return `${normalizeKeyText(item.name)}|${normalizeKeyText(item.unit)}`;
}

function announceDataChanged() {
  window.dispatchEvent(new CustomEvent('data:changed'));
}

function setResult(message, type = 'ok') {
  const element = getElement('import-result');
  if (!element) {
    toast(message, type === 'error' ? 'error' : 'success');
    return;
  }
  element.textContent = message;
  element.hidden = false;
  element.classList.remove('is-ok', 'is-error');
  element.classList.add(type === 'error' ? 'is-error' : 'is-ok');
}

/* --------------------------------------------------------------------------
   Saneamiento
   -------------------------------------------------------------------------- */

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = textValue(raw.name, 80);
  if (!name) return null;
  return {
    id: textValue(raw.id, 80) || createId('itm'),
    name,
    category: textValue(raw.category, 40) || 'Otros',
    quantity: clampAmount(raw.quantity, 0),
    minQuantity: clampAmount(raw.minQuantity, 0),
    unit: textValue(raw.unit, 12) || 'unidad',
    query: textValue(raw.query, 80),
    note: textValue(raw.note, 300),
    createdAt: isoOr(raw.createdAt),
    updatedAt: isoOr(raw.updatedAt),
  };
}

function sanitizeCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = textValue(raw.name, 140);
  const price = parseNumeric(raw.price);
  if (!name || price === null || price <= 0) return null;
  return {
    id: textValue(raw.id, 80),
    name,
    brand: textValue(raw.brand, 60),
    package: textValue(raw.package, 80),
    price,
    listPrice: parseNumeric(raw.listPrice) ?? price,
    promo: textValue(raw.promo, 120) || null,
    image: safeHttpsUrl(raw.image) || null,
    url: safeHttpsUrl(raw.url) || null,
    available: raw.available !== false,
    score: Math.max(0, Math.min(100, Math.round(Number(raw.score) || 0))),
  };
}

function blankPrice() {
  return { status: 'empty', selected: null, best: null, candidates: [], error: null, fetchedAt: null };
}

function sanitizePriceEntry(raw) {
  if (!raw || typeof raw !== 'object') return blankPrice();
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.map(sanitizeCandidate).filter(Boolean).slice(0, 5)
    : [];
  return {
    status: ['ok', 'empty', 'error'].includes(raw.status) ? raw.status : 'empty',
    selected: sanitizeCandidate(raw.selected),
    best: sanitizeCandidate(raw.best),
    candidates,
    error: textValue(raw.error, 240) || null,
    fetchedAt: textValue(raw.fetchedAt, 60) || null,
  };
}

function sanitizePrices(raw) {
  const prices = { coto: blankPrice(), masonline: blankPrice() };
  if (!raw || typeof raw !== 'object') return prices;
  prices.coto = sanitizePriceEntry(raw.coto);
  prices.masonline = sanitizePriceEntry(raw.masonline);
  return prices;
}

function sanitizeShopping(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = textValue(raw.name, 80);
  if (!name) return null;
  const buyQuantity = clampAmount(raw.buyQuantity, 1);
  const currentQuantity = parseNumeric(raw.currentQuantity);
  const minQuantity = parseNumeric(raw.minQuantity);
  return {
    id: textValue(raw.id, 80) || createId('shop'),
    sourceItemId: textValue(raw.sourceItemId, 80) || null,
    manual: Boolean(raw.manual),
    name,
    category: textValue(raw.category, 40) || 'Otros',
    unit: textValue(raw.unit, 12) || 'unidad',
    query: textValue(raw.query, 80) || name,
    currentQuantity: currentQuantity === null ? null : Math.max(0, currentQuantity),
    minQuantity: minQuantity === null ? null : Math.max(0, minQuantity),
    buyQuantity: buyQuantity > 0 ? buyQuantity : 1,
    buyQuantityEdited: Boolean(raw.buyQuantityEdited),
    checked: Boolean(raw.checked),
    status: raw.status === 'completed' ? 'completed' : 'pending',
    prices: sanitizePrices(raw.prices),
    createdAt: isoOr(raw.createdAt),
    updatedAt: isoOr(raw.updatedAt),
    completedAt: textValue(raw.completedAt, 60) || null,
  };
}

function hasPriceData(prices) {
  return ['coto', 'masonline'].some((store) => {
    const entry = prices?.[store];
    return Boolean(entry && (entry.selected || entry.best || (entry.candidates && entry.candidates.length)));
  });
}

/* --------------------------------------------------------------------------
   Exportación
   -------------------------------------------------------------------------- */

function exportInventoryJson() {
  const items = Storage.getItems();
  if (!items.length) {
    toast('No hay elementos para exportar.', 'error');
    return;
  }
  const payload = {
    app: APP_ID,
    version: VERSION,
    type: 'inventory',
    exportedAt: nowIso(),
    items,
  };
  download(`mi-inventario-${stamp()}.json`, JSON.stringify(payload, null, 2));
  toast('Inventario exportado en JSON.', 'success');
}

function exportInventoryTxt() {
  const items = Storage.getItems();
  if (!items.length) {
    toast('No hay elementos para exportar.', 'error');
    return;
  }
  const stateLabels = { out: 'Agotado', low: 'Bajo', ok: 'OK' };
  const lines = [
    '# Mi Inventario — Inventario',
    `# Exportado: ${formatDate(nowIso())}`,
    `# Total: ${items.length} elemento(s)`,
    '',
    'nombre\tcategoría\tcantidad\tunidad\tmínimo\testado\tquery\tnota',
  ];
  items.forEach((item) => {
    lines.push([
      txtCell(item.name),
      txtCell(item.category),
      String(item.quantity),
      txtCell(item.unit),
      String(item.minQuantity),
      stateLabels[itemState(item)] || 'OK',
      txtCell(item.query),
      txtCell(item.note),
    ].join('\t'));
  });
  download(`mi-inventario-${stamp()}.txt`, `\uFEFF${lines.join('\r\n')}`, 'text/plain;charset=utf-8');
  toast('Inventario exportado en TXT.', 'success');
}

function exportShoppingJson() {
  const items = Storage.getShopping();
  if (!items.length) {
    toast('No hay elementos en la lista para exportar.', 'error');
    return;
  }
  const meta = Storage.getMeta();
  const payload = {
    app: APP_ID,
    version: VERSION,
    type: 'shopping',
    exportedAt: nowIso(),
    items,
    meta: { lastPricesAt: meta.lastPricesAt },
  };
  download(`mi-lista-compras-${stamp()}.json`, JSON.stringify(payload, null, 2));
  toast('Listado de compras exportado en JSON.', 'success');
}

function exportShoppingTxt() {
  const items = Storage.getShopping();
  if (!items.length) {
    toast('No hay elementos en la lista para exportar.', 'error');
    return;
  }
  const pending = items.filter((row) => row.status !== 'completed');
  const completed = items.filter((row) => row.status === 'completed');
  let totalCoto = 0;
  let totalMasonline = 0;
  let totalBest = 0;
  pending.forEach((row) => {
    const quantity = Number(row.buyQuantity) || 0;
    const coto = Number(row.prices?.coto?.selected?.price);
    const masonline = Number(row.prices?.masonline?.selected?.price);
    if (Number.isFinite(coto) && coto > 0) totalCoto += coto * quantity;
    if (Number.isFinite(masonline) && masonline > 0) totalMasonline += masonline * quantity;
    const prices = [coto, masonline].filter((price) => Number.isFinite(price) && price > 0);
    if (prices.length) totalBest += Math.min(...prices) * quantity;
  });

  const lines = [
    '# Mi Inventario — Listado de Compras',
    `# Exportado: ${formatDate(nowIso())}`,
    `# Pendientes: ${pending.length} · Completados: ${completed.length}`,
    `# Total estimado COTO: ${formatCurrency(totalCoto)} · ChangoMas: ${formatCurrency(totalMasonline)} · Mejor: ${formatCurrency(totalBest)}`,
    '',
    'elemento\tcategoría\tunidad\tcantidad_actual\tcantidad_comprar\tprecio_coto\tprecio_changomas\tmejor',
  ];
  items.forEach((row) => {
    const coto = row.prices?.coto?.selected?.price;
    const masonline = row.prices?.masonline?.selected?.price;
    const best = [coto, masonline]
      .map((price, index) => ({ price: Number(price), store: index === 0 ? 'COTO' : 'ChangoMas' }))
      .filter((entry) => Number.isFinite(entry.price) && entry.price > 0)
      .sort((a, b) => a.price - b.price)[0];
    lines.push([
      txtCell(row.name),
      txtCell(row.category),
      txtCell(row.unit),
      row.currentQuantity === null ? '' : String(row.currentQuantity),
      String(row.buyQuantity),
      coto ? String(coto) : '',
      masonline ? String(masonline) : '',
      best ? best.store : '',
    ].join('\t'));
  });
  download(`mi-lista-compras-${stamp()}.txt`, `\uFEFF${lines.join('\r\n')}`, 'text/plain;charset=utf-8');
  toast('Listado de compras exportado en TXT.', 'success');
}

/* --------------------------------------------------------------------------
   Lectura y parseo de archivos
   -------------------------------------------------------------------------- */

function extractItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) return parsed.items;
  throw new Error('El archivo no tiene una lista "items" válida.');
}

function splitTxtRows(text) {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
}

function headerIndex(headers, names) {
  return headers.findIndex((header) => names.includes(header));
}

function normalizeHeader(value) {
  return normalizeKeyText(value).replaceAll(' ', '_');
}

function parseInventoryTxt(text) {
  const lines = splitTxtRows(text);
  const headerLine = lines.find((line) => !line.startsWith('#') && line.includes('\t'));
  if (!headerLine) {
    throw new Error('El TXT no tiene el formato esperado. Exportá el inventario desde esta app y volvé a importarlo.');
  }
  const headers = headerLine.split('\t').map(normalizeHeader);
  const indexes = {
    name: headerIndex(headers, ['nombre']),
    category: headerIndex(headers, ['categoria', 'categoría']),
    quantity: headerIndex(headers, ['cantidad']),
    unit: headerIndex(headers, ['unidad']),
    minimum: headerIndex(headers, ['minimo', 'mínimo', 'min']),
    query: headerIndex(headers, ['query', 'busqueda', 'búsqueda']),
    note: headerIndex(headers, ['nota']),
  };
  if (indexes.name === -1) {
    throw new Error('El TXT no incluye la columna "nombre".');
  }
  const start = lines.indexOf(headerLine) + 1;
  const items = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('#')) continue;
    const columns = line.split('\t');
    const get = (index) => (index >= 0 ? columns[index] ?? '' : '');
    const name = textValue(get(indexes.name), 80);
    if (!name) continue;
    items.push({
      name,
      category: textValue(get(indexes.category), 40) || 'Otros',
      quantity: parseNumeric(get(indexes.quantity)) ?? 0,
      unit: textValue(get(indexes.unit), 12) || 'unidad',
      minQuantity: parseNumeric(get(indexes.minimum)) ?? 0,
      query: textValue(get(indexes.query), 80),
      note: textValue(get(indexes.note), 300),
    });
  }
  if (!items.length) {
    throw new Error('El TXT no contiene elementos para importar.');
  }
  return items;
}

function parseShoppingTxt(text) {
  const lines = splitTxtRows(text);
  const headerLine = lines.find((line) => !line.startsWith('#') && line.includes('\t'));
  if (!headerLine) {
    throw new Error('El TXT no tiene el formato esperado. Exportá la lista desde esta app y volvé a importarla.');
  }
  const headers = headerLine.split('\t').map(normalizeHeader);
  const indexes = {
    name: headerIndex(headers, ['elemento', 'nombre']),
    category: headerIndex(headers, ['categoria', 'categoría']),
    unit: headerIndex(headers, ['unidad']),
    current: headerIndex(headers, ['cantidad_actual', 'actual']),
    buy: headerIndex(headers, ['cantidad_comprar', 'comprar']),
  };
  if (indexes.name === -1) {
    throw new Error('El TXT no incluye la columna "elemento".');
  }
  const start = lines.indexOf(headerLine) + 1;
  const items = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('#')) continue;
    const columns = line.split('\t');
    const get = (index) => (index >= 0 ? columns[index] ?? '' : '');
    const name = textValue(get(indexes.name), 80);
    if (!name) continue;
    const current = parseNumeric(get(indexes.current));
    const buy = parseNumeric(get(indexes.buy));
    items.push({
      name,
      category: textValue(get(indexes.category), 40) || 'Otros',
      unit: textValue(get(indexes.unit), 12) || 'unidad',
      currentQuantity: current,
      buyQuantity: buy && buy > 0 ? buy : 1,
      manual: true,
      status: 'pending',
    });
  }
  if (!items.length) {
    throw new Error('El TXT no contiene elementos para importar.');
  }
  return items;
}

async function readImportFile(file, kind) {
  if (!file) {
    throw new Error('Elegí un archivo antes de importar.');
  }
  if (file.size > 2 * 1024 * 1024) {
    throw new Error('El archivo supera los 2 MB. Usá un archivo más chico.');
  }
  const text = await file.text();
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    throw new Error('El archivo está vacío.');
  }
  const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (isJson) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('El JSON no es válido. Revisá el archivo o volvé a exportarlo.');
    }
    return extractItems(parsed);
  }
  return kind === 'inventory' ? parseInventoryTxt(text) : parseShoppingTxt(text);
}

/* --------------------------------------------------------------------------
   Importación
   -------------------------------------------------------------------------- */

function mergeInventory(rawItems, mode) {
  const sanitized = rawItems.map(sanitizeItem).filter(Boolean).slice(0, MAX_ITEMS);
  const invalid = rawItems.length - sanitized.length;
  if (mode === 'replace') {
    Storage.setItems(sanitized);
    return { added: sanitized.length, updated: 0, kept: 0, invalid, total: sanitized.length, mode };
  }

  const next = Storage.getItems().map(sanitizeItem).filter(Boolean).slice(0, MAX_ITEMS);
  const byId = new Map(next.map((item) => [item.id, item]));
  const byKey = new Map(next.map((item) => [itemKey(item), item]));
  let added = 0;
  let updated = 0;
  let kept = 0;

  sanitized.forEach((item) => {
    const match = byId.get(item.id) || byKey.get(itemKey(item));
    if (!match) {
      if (next.length >= MAX_ITEMS) {
        kept += 1;
        return;
      }
      next.push(item);
      byId.set(item.id, item);
      byKey.set(itemKey(item), item);
      added += 1;
      return;
    }
    const incomingTime = new Date(item.updatedAt).getTime();
    const currentTime = new Date(match.updatedAt).getTime();
    if (incomingTime > currentTime) {
      const index = next.indexOf(match);
      const merged = { ...match, ...item, id: match.id, createdAt: match.createdAt };
      next[index] = merged;
      byId.set(merged.id, merged);
      byKey.set(itemKey(merged), merged);
      updated += 1;
    } else {
      kept += 1;
    }
  });

  Storage.setItems(next);
  return { added, updated, kept, invalid, total: next.length, mode };
}

function mergeShopping(rawItems, mode) {
  const sanitized = rawItems.map(sanitizeShopping).filter(Boolean).slice(0, MAX_ITEMS);
  const invalid = rawItems.length - sanitized.length;
  if (mode === 'replace') {
    Storage.setShopping(sanitized);
    return { added: sanitized.length, updated: 0, kept: 0, invalid, total: sanitized.length, mode };
  }

  const next = Storage.getShopping().map(sanitizeShopping).filter(Boolean).slice(0, MAX_ITEMS);
  const byId = new Map(next.map((row) => [row.id, row]));
  const bySource = new Map();
  const byKey = new Map();
  next.forEach((row) => {
    if (row.sourceItemId) bySource.set(row.sourceItemId, row);
    byKey.set(itemKey(row), row);
  });
  let added = 0;
  let updated = 0;
  let kept = 0;

  sanitized.forEach((incoming) => {
    const match = byId.get(incoming.id)
      || (incoming.sourceItemId ? bySource.get(incoming.sourceItemId) : null)
      || byKey.get(itemKey(incoming));
    if (!match) {
      if (next.length >= MAX_ITEMS) {
        kept += 1;
        return;
      }
      next.push(incoming);
      byId.set(incoming.id, incoming);
      if (incoming.sourceItemId) bySource.set(incoming.sourceItemId, incoming);
      byKey.set(itemKey(incoming), incoming);
      added += 1;
      return;
    }

    const preserveCompleted = match.status === 'completed';
    const merged = {
      ...match,
      ...incoming,
      id: match.id,
      sourceItemId: incoming.sourceItemId ?? match.sourceItemId,
      manual: match.manual,
      status: preserveCompleted ? 'completed' : incoming.status,
      checked: preserveCompleted ? true : (incoming.checked || match.checked),
      completedAt: preserveCompleted ? match.completedAt : incoming.completedAt,
      prices: hasPriceData(incoming.prices) ? incoming.prices : match.prices,
      createdAt: match.createdAt,
      updatedAt: nowIso(),
    };
    const index = next.indexOf(match);
    next[index] = merged;
    byId.set(merged.id, merged);
    if (merged.sourceItemId) bySource.set(merged.sourceItemId, merged);
    byKey.set(itemKey(merged), merged);
    updated += 1;
  });

  Storage.setShopping(next);
  return { added, updated, kept, invalid, total: next.length, mode };
}

async function handleInventoryImport() {
  const file = getElement('inventory-import-file')?.files?.[0];
  const mode = document.querySelector('input[name="inventory-import-mode"]:checked')?.value || 'merge';
  try {
    const rawItems = await readImportFile(file, 'inventory');
    const result = mergeInventory(rawItems, mode);
    setResult(
      `Inventario: ${result.added} agregado(s), ${result.updated} actualizado(s), ${result.kept} conservado(s), ${result.invalid} inválido(s). Quedan ${result.total} elemento(s).`,
      'ok',
    );
    const input = getElement('inventory-import-file');
    if (input) input.value = '';
    announceDataChanged();
    toast('Inventario importado.', 'success');
  } catch (error) {
    setResult(error?.message || 'No se pudo importar el inventario.', 'error');
  }
}

async function handleShoppingImport() {
  const file = getElement('shopping-import-file')?.files?.[0];
  const mode = document.querySelector('input[name="shopping-import-mode"]:checked')?.value || 'merge';
  try {
    const rawItems = await readImportFile(file, 'shopping');
    const result = mergeShopping(rawItems, mode);
    setResult(
      `Listado de compras: ${result.added} agregado(s), ${result.updated} actualizado(s), ${result.kept} conservado(s), ${result.invalid} inválido(s). Quedan ${result.total} fila(s).`,
      'ok',
    );
    const input = getElement('shopping-import-file');
    if (input) input.value = '';
    announceDataChanged();
    toast('Listado de compras importado.', 'success');
  } catch (error) {
    setResult(error?.message || 'No se pudo importar el listado de compras.', 'error');
  }
}

function wipeAll() {
  const items = Storage.getItems().length;
  const rows = Storage.getShopping().length;
  const historyCount = Storage.getHistory().length;
  const message = `¿Borrar todos los datos?\n\nInventario: ${items} elemento(s)\nLista de compras: ${rows} fila(s)\nHistorial: ${historyCount} compra(s)\n\nEsta acción no se puede deshacer.`;
  if (!confirmDialog(message)) return;
  Storage.clearAll();
  setResult('Se borraron todos los datos de este navegador.', 'ok');
  announceDataChanged();
  toast('Datos borrados.', 'success');
}

/* --------------------------------------------------------------------------
   Arranque
   -------------------------------------------------------------------------- */

export function init() {
  getElement('btn-data')?.addEventListener('click', () => openDialog(getElement('data-dialog')));
  getElement('btn-export-inventory-json')?.addEventListener('click', exportInventoryJson);
  getElement('btn-export-inventory-txt')?.addEventListener('click', exportInventoryTxt);
  getElement('btn-export-shopping-json')?.addEventListener('click', exportShoppingJson);
  getElement('btn-export-shopping-txt')?.addEventListener('click', exportShoppingTxt);
  getElement('btn-import-inventory')?.addEventListener('click', handleInventoryImport);
  getElement('btn-import-shopping')?.addEventListener('click', handleShoppingImport);
  getElement('btn-wipe-all')?.addEventListener('click', wipeAll);

  getElement('inventory-import-file')?.addEventListener('change', () => {
    const element = getElement('import-result');
    if (element) element.hidden = true;
  });
  getElement('shopping-import-file')?.addEventListener('change', () => {
    const element = getElement('import-result');
    if (element) element.hidden = true;
  });

  const preview = getElement('data-dialog');
  if (preview) {
    preview.addEventListener('close', () => {
      const element = getElement('import-result');
      if (element) element.hidden = true;
    });
  }
}

export { exportInventoryJson, exportInventoryTxt, exportShoppingJson, exportShoppingTxt };

export default {
  init,
  exportInventoryJson,
  exportInventoryTxt,
  exportShoppingJson,
  exportShoppingTxt,
};

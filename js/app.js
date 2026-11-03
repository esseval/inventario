/**
 * app.js — arranque, tema, health check y cableado entre módulos.
 */

import Storage from './storage.js';
import * as inventario from './inventario.js';
import * as compras from './compras.js';
import * as history from './history.js';
import * as importExport from './import-export.js';
import { health } from './api.js';
import { applyTheme, toast, formatDate } from './ui.js';

function getElement(id) {
  return document.getElementById(id);
}

/* --------------------------------------------------------------------------
   Tema
   -------------------------------------------------------------------------- */

function initTheme() {
  const settings = Storage.getSettings();
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const initial = settings.theme === 'light' || settings.theme === 'dark'
    ? settings.theme
    : (prefersDark ? 'dark' : 'light');
  applyTheme(initial);

  getElement('btn-theme')?.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    Storage.setSettings({ ...Storage.getSettings(), theme: next });
  });
}

/* --------------------------------------------------------------------------
   Estado del backend
   -------------------------------------------------------------------------- */

function setStatusBadge(kind, text, title) {
  const badge = getElement('backend-status');
  const label = getElement('status-text');
  if (!badge || !label) return;
  badge.classList.remove('is-ok', 'is-error');
  if (kind === 'ok') badge.classList.add('is-ok');
  if (kind === 'error') badge.classList.add('is-error');
  label.textContent = text;
  if (title) badge.title = title;
}

async function checkHealth(deep = false) {
  const badge = getElement('backend-status');
  const label = getElement('status-text');
  if (!badge || !label) return;
  if (badge.getAttribute('aria-busy') === 'true') return;

  badge.setAttribute('aria-busy', 'true');
  badge.disabled = true;
  label.innerHTML = '<span class="spinner" aria-hidden="true"></span> probando…';

  try {
    const data = await health(deep);
    const stores = Array.isArray(data?.stores) ? data.stores : [];
    const storeText = stores.length === 1
      ? '1 tienda'
      : stores.length > 1
        ? `${stores.length} tiendas`
        : 'sin tiendas';
    setStatusBadge(
      'ok',
      storeText,
      `Backend listo · ${data?.backend || 'proxy.php'} · cURL multi: ${data?.curlMulti ? 'sí' : 'no'}`,
    );

    if (data?.cacheWritable === false) {
      toast('La carpeta cache/ no es escribible. La app funciona, pero sin caché de precios.', 'error');
    }

    if (deep) {
      const coto = data?.coto || 'sin datos';
      const masonline = data?.masonline || 'sin datos';
      const allOk = coto === 'ok' && masonline === 'ok';
      toast(`COTO: ${coto} · ChangoMas: ${masonline}`, allOk ? 'success' : 'error');
    }
  } catch (error) {
    setStatusBadge('error', 'sin backend', error?.message || 'No se pudo contactar a proxy.php.');
    toast(error?.message || 'No se pudo contactar a proxy.php. ¿Está Apache corriendo?', 'error');
  } finally {
    badge.setAttribute('aria-busy', 'false');
    badge.disabled = false;
  }
}

/* --------------------------------------------------------------------------
   Recarga completa tras importar o borrar datos
   -------------------------------------------------------------------------- */

function syncFilterControls() {
  const settings = Storage.getSettings();
  const sort = getElement('inventory-sort');
  const category = getElement('inventory-category');
  if (sort) sort.value = settings.inventorySort || 'name';
  if (category) category.value = settings.categoryFilter || '';
}

function reloadAll() {
  inventario.reloadFromStorage();
  compras.reloadFromStorage();
  compras.sync();
  inventario.render();
  compras.render();
  compras.renderTotals();
  history.reloadFromStorage();
  history.render();
  syncFilterControls();
}

/* --------------------------------------------------------------------------
   Cableado
   -------------------------------------------------------------------------- */

function handleInventoryChange() {
  compras.sync();
  compras.render();
  compras.renderTotals();
  inventario.renderStats();
}

function printDate() {
  const element = getElement('print-date');
  if (element) {
    element.textContent = `Impreso el ${formatDate(new Date().toISOString())}`;
  }
}

function init() {
  initTheme();

  inventario.init({ onChange: handleInventoryChange });
  compras.init();
  history.init();
  importExport.init();

  compras.sync();
  inventario.render();
  compras.render();
  compras.renderTotals();
  history.render();

  getElement('backend-status')?.addEventListener('click', () => checkHealth(true));

  window.addEventListener('shopping:changed', () => {
    compras.renderTotals();
    history.render();
  });

  window.addEventListener('data:changed', reloadAll);

  window.addEventListener('storage:error', () => {
    toast('No se pudo guardar en localStorage. Los cambios quedan solo en esta pestaña.', 'error');
  });

  window.addEventListener('beforeprint', printDate);
  printDate();

  checkHealth(false);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

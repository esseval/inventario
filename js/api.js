/**
 * api.js — cliente del backend proxy.php.
 * El navegador solo habla con el mismo origen; nunca con las tiendas.
 */

export const PROXY = 'proxy.php';
const DEFAULT_TIMEOUT = 90000;

export function buildUrl(action, params = {}) {
  const url = new URL(PROXY, window.location.href);
  url.searchParams.set('action', action);
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (entry !== null && entry !== undefined && entry !== '') {
          url.searchParams.append(`${key}[]`, String(entry));
        }
      });
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

async function request(url, { method = 'GET', body = null, timeout = DEFAULT_TIMEOUT } = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);

  let response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : null,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('El servidor tardó demasiado en responder. Reintentá en unos segundos.');
    }
    throw new Error('No se pudo contactar a proxy.php. ¿Está Apache corriendo en Laragon?');
  } finally {
    window.clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('proxy.php devolvió una respuesta que no es JSON. Revisá que PHP esté funcionando y que no haya errores en el log.');
    }
  }

  if (!response.ok || data?.ok === false) {
    const parts = [data?.error, data?.hint, data?.detail]
      .filter((part) => typeof part === 'string' && part.trim() !== '');
    const message = parts.length
      ? parts.join(' — ')
      : `El backend respondió con HTTP ${response.status}. Revisá Apache/Laragon y reintentá.`;
    throw new Error(message);
  }

  return data;
}

export function health(deep = false) {
  return request(
    buildUrl('health', deep ? { deep: 1 } : {}),
    { timeout: deep ? 30000 : 20000 },
  );
}

export function getPrices(query, stores = ['coto', 'masonline'], limit = 5) {
  return request(
    buildUrl('prices', { q: query, stores: stores.join(','), limit }),
    { timeout: 45000 },
  );
}

export function getPricesBatch(items, stores = ['coto', 'masonline']) {
  return request(
    buildUrl('prices-batch'),
    {
      method: 'POST',
      timeout: 60000,
      body: { action: 'prices-batch', stores, items },
    },
  );
}

export { debounce } from './ui.js';
export { request as rawRequest };

# Mi Inventario 🧺

Aplicación web para controlar lo que hay en casa (alimentos, limpieza, higiene y otros), generar automáticamente el **Listado de Compras** cuando un elemento llega a su mínimo y comparar precios orientativos entre **COTO** y **ChangoMas**.

- **Sin frameworks, sin build, sin base de datos, sin Node/npm/Composer.**
- Frontend: HTML5 + CSS3 + módulos ES nativos.
- Backend: un único `proxy.php` con PHP 8 + cURL.
- Datos del usuario: solo `localStorage` del navegador.

---

## 1. Requisitos

- **Laragon** con **Apache** y **PHP 8.1 o superior**.
- Extensiones PHP: `curl`, `mbstring`, `json` (vienen habilitadas por defecto en Laragon).
- Conexión a internet para consultar precios.
- Abrir la app desde **`http://localhost/inventario/`**, nunca con `file://`.

Comprobar extensiones:

```powershell
C:\laragon\bin\php\php-8.3.30-Win32-vs16-x64\php.exe -m
```

Deben aparecer `curl`, `mbstring` y `json`.

---

## 2. Instalación

1. Copiar la carpeta `inventario/` dentro de `C:\laragon\www\`.
2. Iniciar Laragon y presionar **Start All** (Apache + PHP).
3. Abrir <http://localhost/inventario/>.

No hace falta configurar nada más: `proxy.php` trae valores por defecto para COTO y ChangoMas.

### Configuración opcional

```powershell
Copy-Item C:\laragon\www\inventario\config.php.example C:\laragon\www\inventario\config.php
```

`config.php` permite cambiar:

| Opción | Descripción |
|---|---|
| `price_ttl` | Segundos de caché de precios (600 = 10 minutos). |
| `timeout` | Timeout por petición a las tiendas (3–30 s). |
| `concurrency` | Peticiones simultáneas si `curl_multi` está disponible (1–10). |
| `max_batch` | Máximo de elementos por lote (1–25). |
| `min_score` | Puntaje mínimo (0–100) para elegir un producto automáticamente. |
| `coto.store` | Sucursal digital de COTO (3 dígitos, por defecto `200`). |
| `coto.key` | Clave pública embebida en la web de COTO. Puede cambiar. |
| `masonline.base` | Endpoint público de catálogo de ChangoMas. |

> `config.php` está en `.gitignore`. La clave de COTO es pública (la usa su propio sitio) y no es un dato sensible del usuario.

---

## 3. Verificar el backend

Con Apache corriendo:

- Salud: <http://localhost/inventario/proxy.php?action=health>
- Salud profunda (consulta real a las tiendas): <http://localhost/inventario/proxy.php?action=health&deep=1>
- Precios: <http://localhost/inventario/proxy.php?action=prices&q=arroz>

Ejemplo de respuesta de `health`:

```json
{
  "ok": true,
  "backend": "inventario via proxy.php (Laragon Apache)",
  "stores": ["coto", "masonline"],
  "cacheWritable": true,
  "curlMulti": true,
  "coto": null,
  "masonline": null,
  "version": "1.0"
}
```

Con `deep=1`, `coto` y `masonline` devuelven `"ok"` o `"error: detalle"`. Si una tienda falla, la app sigue funcionando y lo muestra en la columna correspondiente.

### Caché

Los precios se guardan 10 minutos en `cache/*.json`. La carpeta incluye un `.htaccess` con `Require all denied`, así que no se sirve por HTTP.

Si `cache/` no es escribible, la app funciona igual, pero consulta las tiendas en cada actualización.

---

## 4. Uso

### Inventario

1. **Agregar elemento**: nombre, categoría, unidad, cantidad actual y mínimo.
2. El campo **“Término de búsqueda para precios”** es opcional. Si lo completás (`arroz largo fino 1kg`), la búsqueda de precios es más precisa. Si lo dejás vacío se usa el nombre.
3. La tabla muestra el estado:
   - **OK** (verde): cantidad por encima del mínimo.
   - **Bajo** (ámbar): `mínimo > 0` y cantidad `<=` mínimo.
   - **Agotado** (rojo): cantidad `0`.
4. Los botones `−` / `+` y el campo numérico permiten ajustar la cantidad. Los cambios se guardan solos.

### Listado de Compras

- Se sincroniza automáticamente con los elementos **bajos o agotados**.
- **Cantidad a comprar** sugerida: `max(1, ceil(mínimo − cantidad actual))`. Si la editás, se conserva.
- **Actualizar precios** consulta ambas tiendas en un solo lote (hasta 25 elementos) y muestra:
  - precio, nombre del producto y enlace a la ficha;
  - **Sin coincidencia** cuando el puntaje es bajo;
  - **No disponible** con el detalle del error si la tienda falla;
  - **Desactualizado** si el precio tiene más de 24 horas.
- **Elegir** abre la lista de candidatos para seleccionar manualmente otro producto.
- **✓ Recibido** suma la cantidad al inventario, registra la compra en el historial y deja la fila como **Comprado**.
- **Limpiar comprados** quita las filas completadas (el historial se conserva).
- **Agregar suelto** permite sumar algo que no está en el inventario.

### Historial

Cada recepción guarda nombre, cantidad, unidad, tienda, precio unitario, total y fecha. Se conservan las últimas 50 compras.

### Exportar / Importar

El botón **Datos** permite:

- Exportar inventario y listado de compras en **JSON** o **TXT**.
- Importar en modo **Combinar** o **Reemplazar todo**.
- Borrar todos los datos del navegador.

Formatos:

- **JSON**: sobre con `app`, `version`, `type`, `exportedAt` e `items`.
- **TXT**: texto tabulado con cabecera `#` y columnas legibles. Se puede volver a importar desde la misma app.

Modos de importación:

- **Combinar (inventario)**: une por `id` o por nombre + unidad. Solo actualiza si el archivo trae un `updatedAt` más reciente.
- **Combinar (lista)**: une por `id`, `sourceItemId` o nombre + unidad. Conserva filas completadas, checks y precios actuales si el archivo no trae precios.
- **Reemplazar**: sustituye todo el conjunto correspondiente.

Archivos de ejemplo:

- `assets/ejemplo-inventario.json` (14 elementos, varios en mínimo).
- `assets/ejemplo-lista-compras.json` (6 elementos sueltos).

---

## 5. API de `proxy.php`

Todas las respuestas son JSON. El navegador solo llama a este archivo.

### `GET ?action=health[&deep=1]`

Estado del backend, tiendas habilitadas, caché y soporte de `curl_multi`. Con `deep=1` consulta `arroz` en cada tienda.

### `GET ?action=prices&q=<término>&stores=coto,masonline&limit=5`

- `q`: obligatorio, 1–80 caracteres.
- `stores`: opcional, lista separada por comas.
- `limit`: opcional, 1–5 candidatos por tienda.

Devuelve `stores.coto` y `stores.masonline` con `ok`, `candidates`, `best`, `error`, `cached` y `fetchedAt`. Un error de tienda no rompe la respuesta global (`ok: true`).

### `POST ?action=prices-batch`

```json
{
  "action": "prices-batch",
  "stores": ["coto", "masonline"],
  "items": [
    { "id": "shop_1", "q": "arroz largo fino 1kg" },
    { "id": "shop_2", "q": "detergente 500ml" }
  ]
}
```

- 1–25 elementos.
- Deduplica consultas idénticas.
- Usa caché por tienda + consulta.
- Devuelve `results`, `meta` (consultas, cacheadas, descargadas, tiempo) y `warnings`.

### Errores

- Falta `q`, lote inválido o acción desconocida → HTTP 400 con `error` y `hint`.
- Método incorrecto en el lote → HTTP 405.

---

## 6. Cómo funcionan los precios

### COTO

Se usa el endpoint público que alimenta la búsqueda de COTO:

```
https://api.coto.com.ar/api/v1/ms-digital-sitio-bff-web/api/v1/products/search/<término>
```

Con `key` pública, `num_results_per_page`, `pre_filter_expression` y `us=<sucursal>` repetido. El adaptador toma el precio de la sucursal configurada y arma la URL de ficha `https://www.coto.com.ar/productos/...`.

### ChangoMas

Se usa el catálogo público VTEX:

```
https://www.masonline.com.ar/api/catalog_system/pub/products/search/?ft=<término>&_from=0&_to=11
```

El adaptador toma el seller por defecto y el precio de `commertialOffer.Price`.

### Coincidencia

Cada candidato recibe un puntaje (0–100) según:

- nombre idéntico, subcadena o tokens coincidentes;
- coincidencia de tamaño (`1kg`, `500ml`, etc.);
- marca presente en el nombre;
- penalización de accesorios (`dispenser`, `soporte`, `kit`, etc.).

Se elige automáticamente el mejor candidato solo si supera `min_score` (35 por defecto). Si no, la UI muestra **Sin coincidencia** y permite elegir a mano.

### Uso responsable

- Solo se consulta cuando el usuario presiona **Actualizar precios** (o el botón de una fila).
- Caché de 10 minutos y lotes de hasta 25 elementos.
- No se intenta evadir captchas, logins ni bloqueos anti-bot.
- Si una tienda responde `403`/`429`, se muestra un error claro y se sugiere reintentar más tarde.

---

## 7. Estructura

```
inventario/
├── index.html
├── proxy.php
├── config.php.example
├── .gitignore
├── README.md
├── assets/
│   ├── ejemplo-inventario.json
│   └── ejemplo-lista-compras.json
├── cache/
│   └── .htaccess
├── css/
│   ├── styles.css
│   └── responsive.css
└── js/
    ├── app.js
    ├── api.js
    ├── state.js
    ├── storage.js
    ├── ui.js
    ├── inventario.js
    ├── compras.js
    ├── history.js
    └── import-export.js
```

### Claves de `localStorage`

| Clave | Contenido |
|---|---|
| `mi_inventario_items` | Elementos del inventario. |
| `mi_inventario_settings` | Tema, orden, filtros e historial visible. |
| `mi_inventario_history` | Últimas 50 compras recibidas. |
| `mi_lista_compras_items` | Listado de compras (pendientes y comprados). |
| `mi_lista_compras_meta` | Última sincronización y última consulta de precios. |

Para reiniciar todo: **Datos → Borrar todos los datos**, o borrar las claves desde las herramientas del navegador.

---

## 8. Accesibilidad y responsive

- `lang="es-AR"`, landmarks, skip link, jerarquía de encabezados.
- `aria-live` en el estado del backend, el estado de precios y los toasts.
- Diálogos con `aria-labelledby`, cierre con botón y `Esc`.
- Formularios con etiquetas visibles o `.sr-only`.
- Foco visible con anillo naranja.
- Estados con texto además de color (`OK`, `Bajo`, `Agotado`, `Comprado`).
- Tablas que se convierten en tarjetas por debajo de 900 px.
- Estilos de impresión: solo inventario y listado de compras, sin controles.
- Respeta `prefers-reduced-motion`.

---

## 9. Limitaciones y aviso legal

- **Los precios son orientativos.** Pueden variar por sucursal, stock, impuestos, promociones o medio de pago. Siempre verificá en el sitio de la tienda antes de comprar.
- Los endpoints de COTO y ChangoMas son **públicos pero no oficiales para terceros**. Pueden cambiar sin aviso; si eso pasa, solo hay que ajustar el adaptador correspondiente en `proxy.php`.
- No se consulta stock en tiempo real ni se realizan compras.
- No hay cuentas, sincronización entre dispositivos ni respaldo en la nube. Si borrás los datos del navegador, se pierden (exportá antes).
- La app no está afiliada a COTO ni a ChangoMas. Las marcas pertenecen a sus dueños.
- El uso de los endpoints debe ser moderado y respetuoso. No se implementan mecanismos para saltar protecciones.

---

## 10. Solución de problemas

| Problema | Qué revisar |
|---|---|
| “No se pudo contactar a proxy.php” | Apache debe estar corriendo en Laragon. Abrí la app desde `http://localhost/inventario/`. |
| `proxy.php` devuelve HTML o error 500 | Revisá `php -l proxy.php` y el log de Apache/PHP. |
| Health dice `sin backend` | Probá `proxy.php?action=health` directamente en el navegador. |
| “No disponible” en una tienda | Puede ser un bloqueo temporal, un cambio de endpoint o falta de red. Reintentá más tarde. |
| Precios de otra zona | Ajustá `coto.store` en `config.php` (por defecto `200`). |
| “La carpeta cache/ no es escribible” | Dale permisos de escritura a `cache/` o ignorá el aviso: la app funciona sin caché. |
| No aparecen elementos en la lista | Un elemento entra si `mínimo > 0` y `cantidad <= mínimo`. Revisá el mínimo. |
| Importación inválida | Usá un archivo exportado por esta app o el ejemplo de `assets/`. |
| La app se ve sin estilos | Verificá que `css/styles.css` y `css/responsive.css` existan y que la URL sea la correcta. |

### Comandos útiles

```powershell
# Validar sintaxis PHP
C:\laragon\bin\php\php-8.3.30-Win32-vs16-x64\php.exe -l C:\laragon\www\inventario\proxy.php

# Probar el backend por consola
curl.exe "http://localhost/inventario/proxy.php?action=health"
curl.exe "http://localhost/inventario/proxy.php?action=prices&q=arroz"
```

---

## 11. Privacidad

- El inventario, la lista, el historial y los ajustes se guardan **solo en tu navegador**.
- `proxy.php` no guarda datos de usuario: solo cachea respuestas de precios por consulta.
- No hay cookies de terceros, analítica, login ni claves privadas en el cliente.

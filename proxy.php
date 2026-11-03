<?php
/**
 * Mi Inventario — proxy.php
 * Backend único de la aplicación. Consulta COTO y ChangoMas, normaliza los
 * resultados, los cachea en disco y los devuelve al cliente en un formato
 * propio y estable.
 *
 * Acciones:
 *   GET  ?action=health[&deep=1]
 *   GET  ?action=prices&q=<término>&stores=coto,masonline&limit=5
 *   POST ?action=prices-batch    (cuerpo JSON)
 *
 * Requiere PHP 8.1+ con curl, mbstring y json.
 */

declare(strict_types=1);

ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);
set_time_limit(60);
date_default_timezone_set('America/Argentina/Buenos_Aires');

const MAX_BATCH_ITEMS = 25;
const MAX_CANDIDATES  = 5;
const MAX_QUERY_LEN   = 80;
const PRICE_TTL       = 600;
const REQUEST_BUDGET  = 25;
const CONCURRENCY     = 6;
const MIN_MATCH_SCORE = 35;
const MAX_CACHE_CANDIDATES = 12;

const ALLOWED_STORES = ['coto', 'masonline'];

// ---------------------------------------------------------------------------
// Cabeceras y utilidades de respuesta
// ---------------------------------------------------------------------------

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function respond(int $code, array $data): never
{
    http_response_code($code);
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        http_response_code(500);
        echo '{"error":"No se pudo serializar la respuesta","hint":"Revisá los datos enviados."}';
        exit;
    }
    echo $json;
    exit;
}

function fail(int $code, string $error, string $hint = ''): never
{
    $data = ['ok' => false, 'error' => $error];
    if ($hint !== '') {
        $data['hint'] = $hint;
    }
    respond($code, $data);
}

function isoNow(): string
{
    return date('c');
}

function clampText(string $value, int $max): string
{
    return mb_substr(trim($value), 0, $max, 'UTF-8');
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

$rawBody = file_get_contents('php://input');
$jsonBody = null;
if (is_string($rawBody) && trim($rawBody) !== '') {
    $contentType = strtolower($_SERVER['CONTENT_TYPE'] ?? '');
    $looksJson = str_contains($contentType, 'application/json')
        || str_starts_with(ltrim($rawBody), '{')
        || str_starts_with(ltrim($rawBody), '[');
    if ($looksJson) {
        $decoded = json_decode($rawBody, true);
        if (is_array($decoded)) {
            $jsonBody = $decoded;
        }
    }
}

$input = $_GET + $_POST + (is_array($jsonBody) ? $jsonBody : []);
$action = is_string($input['action'] ?? null) ? trim((string) $input['action']) : '';

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

function defaultConfig(): array
{
    return [
        'price_ttl'   => PRICE_TTL,
        'timeout'     => 15,
        'concurrency' => CONCURRENCY,
        'max_batch'   => MAX_BATCH_ITEMS,
        'min_score'   => MIN_MATCH_SCORE,
        'user_agent'  => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            . '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'coto' => [
            'enabled' => true,
            'base'    => 'https://api.coto.com.ar/api/v1/ms-digital-sitio-bff-web/api/v1',
            'key'     => 'key_r6xzz4IAoTWcipni',
            'store'   => '200',
        ],
        'masonline' => [
            'enabled' => true,
            'base'    => 'https://www.masonline.com.ar/api/catalog_system/pub/products/search/',
        ],
    ];
}

/**
 * Merge recursivo para arrays asociativos: los valores del usuario pisan a los
 * defaults, pero sin perder claves hermanas.
 */
function deepMerge(array $defaults, array $override): array
{
    foreach ($override as $key => $value) {
        if (is_array($value) && isset($defaults[$key]) && is_array($defaults[$key])
            && !array_is_list($value) && !array_is_list($defaults[$key])) {
            $defaults[$key] = deepMerge($defaults[$key], $value);
        } else {
            $defaults[$key] = $value;
        }
    }
    return $defaults;
}

function loadConfig(): array
{
    static $config = null;
    if (is_array($config)) {
        return $config;
    }
    $config = defaultConfig();
    $file = __DIR__ . '/config.php';
    if (is_file($file)) {
        try {
            $custom = require $file;
            if (is_array($custom)) {
                $config = deepMerge($config, $custom);
            }
        } catch (Throwable $e) {
            error_log('Mi Inventario: config.php inválido: ' . $e->getMessage());
        }
    }
    $config['price_ttl']   = max(0, (int) $config['price_ttl']);
    $config['timeout']     = max(3, min(30, (int) $config['timeout']));
    $config['concurrency'] = max(1, min(10, (int) $config['concurrency']));
    $config['max_batch']   = max(1, min(MAX_BATCH_ITEMS, (int) $config['max_batch']));
    $config['min_score']   = max(0, min(100, (int) $config['min_score']));
    $config['coto']['store'] = str_pad(
        preg_replace('/\D/', '', (string) $config['coto']['store']) ?: '200',
        3,
        '0',
        STR_PAD_LEFT
    );
    return $config;
}

// ---------------------------------------------------------------------------
// Caché en disco
// ---------------------------------------------------------------------------

function cacheDir(): string
{
    return __DIR__ . '/cache';
}

function cachePath(string $key): string
{
    $safe = preg_replace('/[^a-zA-Z0-9_.-]/', '', $key) ?: 'cache';
    return cacheDir() . DIRECTORY_SEPARATOR . $safe . '.json';
}

function cacheGet(string $key, int $ttl): ?array
{
    if ($ttl <= 0) {
        return null;
    }
    $path = cachePath($key);
    if (!is_file($path)) {
        return null;
    }
    $mtime = @filemtime($path);
    if ($mtime === false || (time() - $mtime) > $ttl) {
        return null;
    }
    $raw = @file_get_contents($path);
    if (!is_string($raw) || $raw === '') {
        return null;
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : null;
}

function cachePut(string $key, array $data): bool
{
    $dir = cacheDir();
    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }
    if (!is_dir($dir) || !is_writable($dir)) {
        return false;
    }
    $payload = json_encode(
        ['fetchedAt' => isoNow(), 'data' => $data],
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    );
    if ($payload === false) {
        return false;
    }
    return @file_put_contents(cachePath($key), $payload, LOCK_EX) !== false;
}

function cacheWritable(): bool
{
    $dir = cacheDir();
    if (is_dir($dir)) {
        return is_writable($dir);
    }
    return is_writable(__DIR__);
}

// ---------------------------------------------------------------------------
// cURL
// ---------------------------------------------------------------------------

function hasCurlMulti(): bool
{
    static $result = null;
    if ($result !== null) {
        return $result;
    }
    $functions = [
        'curl_init', 'curl_setopt', 'curl_setopt_array', 'curl_exec',
        'curl_getinfo', 'curl_error', 'curl_close',
        'curl_multi_init', 'curl_multi_add_handle', 'curl_multi_exec',
        'curl_multi_select', 'curl_multi_getcontent', 'curl_multi_remove_handle',
        'curl_multi_close', 'curl_multi_info_read',
    ];
    foreach ($functions as $fn) {
        if (!function_exists($fn)) {
            $result = false;
            return $result;
        }
    }
    $result = true;
    return $result;
}

/**
 * @return array{body: ?string, code: int, error: ?string}
 */
function emptyResponse(string $error): array
{
    return ['body' => null, 'code' => 0, 'error' => $error];
}

function buildCurl(string $url, int $timeout, string $ua): ?CurlHandle
{
    $ch = curl_init($url);
    if ($ch === false) {
        return null;
    }
    $ok = curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 5,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => max(2, min(10, $timeout)),
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_ENCODING       => '',
        CURLOPT_USERAGENT      => $ua,
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
    ]);
    if (!$ok) {
        curl_close($ch);
        return null;
    }
    return $ch;
}

/**
 * Descarga varias URLs. Devuelve un array con el mismo número de elementos;
 * cada elemento es null si no se procesó.
 *
 * @param array<int, string|null> $urls
 * @return array<int, array{body: ?string, code: int, error: ?string}|null>
 */
function fetchMany(array $urls, int $timeout, string $ua, int $concurrency = 6, int $budget = 0): array
{
    $out = array_fill(0, count($urls), null);
    if (!$urls) {
        return $out;
    }

    $timeout = max(3, $timeout);
    $concurrency = max(1, min(10, $concurrency));
    $deadline = $budget > 0 ? microtime(true) + $budget : null;

    if (!function_exists('curl_init')) {
        return $out;
    }

    if (hasCurlMulti() && count(array_filter($urls, 'is_string')) > 1) {
        $mh = curl_multi_init();
        if ($mh === false) {
            return $out;
        }
        $active = [];
        $index = 0;
        $total = count($urls);

        while ($index < $total || $active) {
            while ($index < $total && count($active) < $concurrency) {
                $url = $urls[$index];
                if (!is_string($url) || $url === '') {
                    $index++;
                    continue;
                }
                $requestTimeout = $timeout;
                if ($deadline !== null) {
                    $remaining = $deadline - microtime(true);
                    if ($remaining <= 0.75) {
                        $index++;
                        continue;
                    }
                    $requestTimeout = (int) max(2, min($timeout, (int) floor($remaining)));
                }
                $ch = buildCurl($url, $requestTimeout, $ua);
                if ($ch === null) {
                    $out[$index] = emptyResponse('No se pudo inicializar cURL');
                    $index++;
                    continue;
                }
                curl_multi_add_handle($mh, $ch);
                $active[spl_object_id($ch)] = ['ch' => $ch, 'i' => $index];
                $index++;
            }

            if (!$active) {
                break;
            }

            do {
                $status = curl_multi_exec($mh, $running);
            } while ($status === CURLM_CALL_MULTI_PERFORM);

            while (($info = curl_multi_info_read($mh)) !== false) {
                $ch = $info['handle'] ?? null;
                if (!$ch instanceof CurlHandle) {
                    continue;
                }
                $id = spl_object_id($ch);
                $idx = $active[$id]['i'] ?? null;
                if ($idx !== null) {
                    $body = curl_multi_getcontent($ch);
                    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
                    $err = curl_error($ch);
                    $out[$idx] = [
                        'body'  => $err === '' && is_string($body) ? $body : null,
                        'code'  => $code,
                        'error' => $err !== '' ? $err : null,
                    ];
                }
                curl_multi_remove_handle($mh, $ch);
                unset($active[$id]);
            }

            if ($active) {
                $selected = curl_multi_select($mh, 0.5);
                if ($selected === -1) {
                    usleep(20000);
                }
            }
        }

        curl_multi_close($mh);
        return $out;
    }

    // Fallback sin curl_multi: un único handle reutilizado (keep-alive TLS).
    $ch = curl_init();
    if ($ch === false) {
        return $out;
    }
    $baseOk = curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 5,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_ENCODING       => '',
        CURLOPT_USERAGENT      => $ua,
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
    ]);
    if (!$baseOk) {
        curl_close($ch);
        return $out;
    }

    foreach ($urls as $i => $url) {
        if (!is_string($url) || $url === '') {
            continue;
        }
        $requestTimeout = $timeout;
        if ($deadline !== null) {
            $remaining = $deadline - microtime(true);
            if ($remaining <= 0.75) {
                break;
            }
            $requestTimeout = (int) max(2, min($timeout, (int) floor($remaining)));
        }
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_HTTPGET, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, $requestTimeout);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, max(2, min(10, $requestTimeout)));
        $body = curl_exec($ch);
        $err = curl_error($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $out[$i] = [
            'body'  => $err === '' && is_string($body) ? $body : null,
            'code'  => $code,
            'error' => $err !== '' ? $err : null,
        ];
    }

    curl_close($ch);
    return $out;
}

// ---------------------------------------------------------------------------
// Normalización, tokens y coincidencia
// ---------------------------------------------------------------------------

function normalizeText(string $value): string
{
    $value = mb_strtolower(trim($value), 'UTF-8');
    $value = strtr($value, [
        'á' => 'a', 'é' => 'e', 'í' => 'i', 'ó' => 'o', 'ú' => 'u',
        'à' => 'a', 'è' => 'e', 'ì' => 'i', 'ò' => 'o', 'ù' => 'u',
        'â' => 'a', 'ê' => 'e', 'î' => 'i', 'ô' => 'o', 'û' => 'u',
        'ä' => 'a', 'ë' => 'e', 'ï' => 'i', 'ö' => 'o', 'ü' => 'u',
        'ñ' => 'n', 'ç' => 'c',
    ]);
    $value = preg_replace('/[^a-z0-9]+/u', ' ', $value) ?? '';
    $value = preg_replace('/\s+/', ' ', $value) ?? '';
    return trim($value);
}

/** @return list<string> */
function tokens(string $value): array
{
    $normalized = normalizeText($value);
    if ($normalized === '') {
        return [];
    }
    $parts = explode(' ', $normalized);
    return array_values(array_filter($parts, static fn (string $p): bool => $p !== ''));
}

function scoreCandidate(string $query, string $name, string $brand = ''): int
{
    $q = normalizeText($query);
    $n = normalizeText($name);
    $b = normalizeText($brand);
    if ($q === '' || $n === '') {
        return 0;
    }

    if ($n === $q) {
        $score = 100;
    } elseif (str_contains($n, $q)) {
        $score = 85;
    } else {
        $queryTokens = tokens($q);
        $nameTokens = tokens($n);
        if (!$queryTokens) {
            return 0;
        }
        $matched = 0;
        foreach ($queryTokens as $token) {
            if (in_array($token, $nameTokens, true)) {
                $matched++;
            }
        }
        $score = $matched === count($queryTokens)
            ? 65
            : (int) round(40 * ($matched / count($queryTokens)));
    }

    // Bonus si el tamaño de la consulta (1kg, 500 ml, 1l…) aparece en el nombre.
    if (preg_match_all('/(\d+(?:\.\d+)?)\s*(kg|g|gr|ml|l|lt|litros?|cc|cm3|unidades?|un|u)\b/', $q, $matches, PREG_SET_ORDER)) {
        foreach ($matches as $match) {
            if (str_contains($n, $match[1]) && str_contains($n, $match[2])) {
                $score += 5;
                break;
            }
        }
    }

    // Bonus si la marca aparece en el nombre del producto.
    if ($b !== '') {
        $nameTokens = $nameTokens ?? tokens($n);
        foreach (tokens($b) as $brandToken) {
            if (in_array($brandToken, $nameTokens, true)) {
                $score += 5;
                break;
            }
        }
    }

    // Penalizar accesorios cuando la consulta no los pide.
    $accessories = [
        'dispenser', 'dispensador', 'jabonera', 'porta', 'soporte',
        'adorno', 'juguete', 'kit', 'set', 'combo', 'recarga',
    ];
    foreach ($accessories as $accessory) {
        if (str_contains($n, $accessory) && !str_contains($q, $accessory)) {
            $score -= 25;
            break;
        }
    }

    return max(0, min(100, $score));
}

function toFloat(mixed $value): ?float
{
    if (is_int($value) || is_float($value)) {
        $number = (float) $value;
        return $number > 0 ? $number : null;
    }
    if (!is_string($value)) {
        return null;
    }
    $clean = preg_replace('/[^0-9,.\-]/', '', trim($value)) ?? '';
    if ($clean === '' || $clean === '-' || $clean === '.') {
        return null;
    }
    if (str_contains($clean, ',') && str_contains($clean, '.')) {
        $clean = str_replace('.', '', $clean);
    }
    $clean = str_replace(',', '.', $clean);
    $number = (float) $clean;
    return $number > 0 ? $number : null;
}

function safeHttps(?string $url): ?string
{
    if (!is_string($url)) {
        return null;
    }
    $url = trim($url);
    if ($url === '' || !preg_match('#^https://#i', $url)) {
        return null;
    }
    return $url;
}

/**
 * Ordena por score desc, precio asc, nombre asc y recorta duplicados.
 *
 * @param list<array<string, mixed>> $candidates
 * @return list<array<string, mixed>>
 */
function sortCandidates(array $candidates): array
{
    usort($candidates, static function (array $a, array $b): int {
        $scoreCmp = ($b['score'] ?? 0) <=> ($a['score'] ?? 0);
        if ($scoreCmp !== 0) {
            return $scoreCmp;
        }
        $priceCmp = ((float) ($a['price'] ?? 0)) <=> ((float) ($b['price'] ?? 0));
        if ($priceCmp !== 0) {
            return $priceCmp;
        }
        return strcmp((string) ($a['name'] ?? ''), (string) ($b['name'] ?? ''));
    });

    $seen = [];
    $unique = [];
    foreach ($candidates as $candidate) {
        $id = (string) ($candidate['id'] ?? '');
        $signature = $id !== '' ? 'id:' . $id : 'name:' . normalizeText((string) ($candidate['name'] ?? ''));
        if (isset($seen[$signature])) {
            continue;
        }
        $seen[$signature] = true;
        $unique[] = $candidate;
    }
    return $unique;
}

// ---------------------------------------------------------------------------
// Adaptador COTO
// ---------------------------------------------------------------------------

function cotoConfig(array $config): array
{
    return is_array($config['coto'] ?? null) ? $config['coto'] : [];
}

function cotoSearchUrl(array $coto, string $query): string
{
    $base = rtrim((string) ($coto['base'] ?? ''), '/');
    $store = str_pad(
        preg_replace('/\D/', '', (string) ($coto['store'] ?? '200')) ?: '200',
        3,
        '0',
        STR_PAD_LEFT
    );
    $params = http_build_query([
        'key'                   => (string) ($coto['key'] ?? ''),
        'num_results_per_page'  => 12,
        'pre_filter_expression' => json_encode(
            ['name' => 'store_availability', 'value' => $store],
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        ),
    ]);
    return $base . '/products/search/' . rawurlencode($query)
        . '?' . $params . '&us=' . rawurlencode($store) . '&us=' . rawurlencode($store);
}

function cotoPackage(array $data): string
{
    $quantity = $data['product_format_quantity'] ?? null;
    $format = mb_strtolower(trim((string) ($data['product_format'] ?? '')), 'UTF-8');
    $measure = mb_strtolower(trim((string) ($data['product_unit_of_measure'] ?? '')), 'UTF-8');
    $map = [
        'kilogramo' => 'kg', 'kilogramos' => 'kg', 'kilo' => 'kg', 'kilos' => 'kg',
        'gramo' => 'g', 'gramos' => 'g', 'gr' => 'g',
        'litro' => 'L', 'litros' => 'L', 'lt' => 'L',
        'mililitro' => 'ml', 'mililitros' => 'ml', 'cc' => 'ml',
        'unidad' => 'unidad', 'unidades' => 'unidad',
        'metro' => 'm', 'metros' => 'm',
    ];
    $unit = $map[$format] ?? ($map[$measure] ?? '');
    $quantityText = '';
    if (is_numeric($quantity)) {
        $quantityText = rtrim(rtrim(number_format((float) $quantity, 2, '.', ''), '0'), '.');
    }
    if ($quantityText !== '' && $unit !== '') {
        return $quantityText . ' ' . $unit;
    }
    if ($format !== '') {
        return (string) ($data['product_format'] ?? '');
    }
    if ($unit !== '') {
        return $unit;
    }
    return trim((string) ($data['sku_description'] ?? ''));
}

/**
 * @return array{ok: bool, candidates: list<array<string, mixed>>, error: ?string}
 */
function parseCoto(string $body, string $query, array $cotoConfig): array
{
    $decoded = json_decode($body, true);
    if (!is_array($decoded)) {
        return ['ok' => false, 'candidates' => [], 'error' => 'COTO devolvió una respuesta que no es JSON válido.'];
    }
    if (($decoded['response']['total_num_results'] ?? null) === 0) {
        return ['ok' => true, 'candidates' => [], 'error' => null];
    }
    $results = $decoded['response']['results'] ?? null;
    if (!is_array($results)) {
        return ['ok' => false, 'candidates' => [], 'error' => 'COTO no devolvió la lista de resultados esperada.'];
    }

    $store = str_pad(
        preg_replace('/\D/', '', (string) ($cotoConfig['store'] ?? '200')) ?: '200',
        3,
        '0',
        STR_PAD_LEFT
    );

    $candidates = [];
    foreach ($results as $row) {
        if (!is_array($row)) {
            continue;
        }
        $data = $row['data'] ?? null;
        if (!is_array($data)) {
            continue;
        }

        $name = trim((string) ($data['sku_display_name'] ?? $data['value'] ?? ''));
        if ($name === '') {
            continue;
        }
        $id = trim((string) ($data['sku_id'] ?? $data['id'] ?? $data['sku_plu'] ?? ''));
        $brand = trim((string) ($data['product_brand'] ?? ''));

        $price = null;
        $priceForStore = null;
        if (is_array($data['price'] ?? null)) {
            foreach ($data['price'] as $priceRow) {
                if (!is_array($priceRow)) {
                    continue;
                }
                if ((string) ($priceRow['store'] ?? '') !== $store) {
                    continue;
                }
                $priceForStore = toFloat($priceRow['listPrice'] ?? $priceRow['formatPrice'] ?? null);
                if ($priceForStore === null) {
                    $priceForStore = toFloat($priceRow['priceWithoutTax'] ?? null);
                }
                break;
            }
        }
        $price = $priceForStore ?? toFloat($data['product_list_price'] ?? null);
        if ($price === null || $price <= 0) {
            continue;
        }

        $listPrice = toFloat($data['product_list_price'] ?? null) ?? $price;

        $available = $priceForStore !== null;
        if (is_array($data['store_availability'] ?? null)) {
            foreach ($data['store_availability'] as $availability) {
                $availabilityStore = is_array($availability)
                    ? (string) ($availability['store'] ?? $availability['id'] ?? '')
                    : (string) $availability;
                if ($availabilityStore === $store) {
                    $available = true;
                    break;
                }
            }
        }

        $promo = null;
        if (is_array($data['discounts'] ?? null) && isset($data['discounts'][0]) && is_array($data['discounts'][0])) {
            $discount = $data['discounts'][0];
            $discountText = trim((string) ($discount['discountText'] ?? ''));
            $discountPrice = trim((string) ($discount['discountPrice'] ?? ''));
            if ($discountText !== '' || $discountPrice !== '') {
                $promo = trim($discountText . ($discountPrice !== '' ? ' ' . $discountPrice : ''));
            }
        }

        // La API devuelve una ruta relativa (ej. "_/R-00561454-..."); se arma la ficha pública.
        $rawUrl = trim((string) ($data['url'] ?? ''));
        if ($rawUrl === '') {
            continue;
        }
        $productUrl = preg_match('#^https://#i', $rawUrl)
            ? $rawUrl
            : 'https://www.coto.com.ar/productos/' . ltrim($rawUrl, '/');
        $productUrl = safeHttps($productUrl);
        if ($productUrl === null) {
            continue;
        }

        $image = safeHttps((string) (
            $data['product_medium_image_url']
            ?? $data['product_large_image_url']
            ?? $data['image_url']
            ?? ''
        ));

        $candidates[] = [
            'id'        => $id,
            'name'      => $name,
            'brand'     => $brand,
            'package'   => cotoPackage($data),
            'price'     => $price,
            'listPrice' => $listPrice,
            'promo'     => $promo,
            'image'     => $image,
            'url'       => $productUrl,
            'available' => $available,
            'score'     => scoreCandidate($query, $name, $brand),
        ];
    }

    return ['ok' => true, 'candidates' => sortCandidates($candidates), 'error' => null];
}

// ---------------------------------------------------------------------------
// Adaptador ChangoMas
// ---------------------------------------------------------------------------

function masonlineConfig(array $config): array
{
    return is_array($config['masonline'] ?? null) ? $config['masonline'] : [];
}

function masonlineSearchUrl(array $masonline, string $query): string
{
    $base = rtrim((string) ($masonline['base'] ?? ''), '/');
    // VTEX espera %20 para espacios en "ft"; con "+" responde HTTP 400.
    return $base . '/?ft=' . rawurlencode($query) . '&_from=0&_to=11';
}

/**
 * @return array{ok: bool, candidates: list<array<string, mixed>>, error: ?string}
 */
function parseMasonline(string $body, string $query): array
{
    $decoded = json_decode($body, true);
    if (!is_array($decoded)) {
        return ['ok' => false, 'candidates' => [], 'error' => 'ChangoMas devolvió una respuesta que no es JSON válido.'];
    }
    if (isset($decoded['products']) && is_array($decoded['products'])) {
        $decoded = $decoded['products'];
    }
    if (array_is_list($decoded) === false) {
        return ['ok' => false, 'candidates' => [], 'error' => 'ChangoMas no devolvió la lista de productos esperada.'];
    }
    if (count($decoded) === 0) {
        return ['ok' => true, 'candidates' => [], 'error' => null];
    }

    $candidates = [];
    foreach ($decoded as $product) {
        if (!is_array($product)) {
            continue;
        }
        $name = trim((string) ($product['productName'] ?? ''));
        if ($name === '') {
            continue;
        }
        $items = $product['items'] ?? null;
        $item = is_array($items) && isset($items[0]) && is_array($items[0]) ? $items[0] : [];

        $sellers = $item['sellers'] ?? null;
        $seller = null;
        if (is_array($sellers)) {
            foreach ($sellers as $candidateSeller) {
                if (is_array($candidateSeller) && !empty($candidateSeller['sellerDefault'])) {
                    $seller = $candidateSeller;
                    break;
                }
            }
            if ($seller === null && isset($sellers[0]) && is_array($sellers[0])) {
                $seller = $sellers[0];
            }
        }
        $offer = is_array($seller['commertialOffer'] ?? null) ? $seller['commertialOffer'] : [];

        $price = toFloat($offer['Price'] ?? null);
        if ($price === null) {
            continue;
        }
        $listPrice = toFloat($offer['ListPrice'] ?? null) ?? $price;

        $image = null;
        if (is_array($item['images'] ?? null) && isset($item['images'][0]['imageUrl'])) {
            $image = safeHttps((string) $item['images'][0]['imageUrl']);
        }
        if ($image === null) {
            $image = safeHttps((string) ($product['imageUrl'] ?? ''));
        }

        $url = safeHttps((string) ($product['link'] ?? ''));
        if ($url === null) {
            continue;
        }

        $package = trim((string) ($item['name'] ?? ''));
        if ($package === '') {
            $package = trim((string) ($item['measurementUnit'] ?? ''));
        }

        $brand = trim((string) ($product['brand'] ?? ''));

        $candidates[] = [
            'id'        => trim((string) ($product['productId'] ?? $item['itemId'] ?? '')),
            'name'      => $name,
            'brand'     => $brand,
            'package'   => $package,
            'price'     => $price,
            'listPrice' => $listPrice,
            'promo'     => null,
            'image'     => $image,
            'url'       => $url,
            'available' => !empty($offer['IsAvailable']) && $price > 0,
            'score'     => scoreCandidate($query, $name, $brand),
        ];
    }

    return ['ok' => true, 'candidates' => sortCandidates($candidates), 'error' => null];
}

// ---------------------------------------------------------------------------
// Resolución de precios y caché
// ---------------------------------------------------------------------------

function storeName(string $store): string
{
    return $store === 'coto' ? 'COTO' : 'ChangoMas';
}

function storeEnabled(array $config, string $store): bool
{
    return !empty($config[$store]['enabled']);
}

function normalizedStores(mixed $raw, array $config): array
{
    $list = [];
    if (is_array($raw)) {
        $list = $raw;
    } elseif (is_string($raw) && trim($raw) !== '') {
        $list = preg_split('/\s*,\s*/', trim($raw)) ?: [];
    }
    if (!$list) {
        foreach (ALLOWED_STORES as $store) {
            if (storeEnabled($config, $store)) {
                $list[] = $store;
            }
        }
    }
    $valid = [];
    foreach ($list as $store) {
        if (is_string($store) && in_array($store, ALLOWED_STORES, true) && !in_array($store, $valid, true)) {
            $valid[] = $store;
        }
    }
    if (!$valid) {
        foreach (ALLOWED_STORES as $store) {
            if (storeEnabled($config, $store)) {
                $valid[] = $store;
            }
        }
    }
    return $valid;
}

/**
 * @return array<string, mixed>
 */
function storeResult(
    string $store,
    bool $ok,
    array $candidates,
    ?string $error,
    bool $cached,
    ?string $fetchedAt
): array {
    return [
        'ok'         => $ok,
        'store'      => $store,
        'storeName'  => storeName($store),
        'currency'   => 'ARS',
        'candidates' => $candidates,
        'best'       => null,
        'error'      => $error,
        'cached'     => $cached,
        'fetchedAt'  => $fetchedAt,
    ];
}

/**
 * Resuelve precios para un conjunto de consultas ya normalizadas.
 *
 * @param list<array{q: string, norm: string}> $queries
 * @param list<string> $stores
 * @return array{map: array<string, array<string, array<string, mixed>>>, cached: int, fetched: int, timedOut: bool}
 */
function resolvePrices(array $queries, array $stores, array $config, int $limit): array
{
    $map = [];
    $tasks = [];
    $cachedCount = 0;
    $timedOut = false;

    foreach ($queries as $query) {
        $norm = $query['norm'];
        if (isset($map[$norm])) {
            continue;
        }
        $map[$norm] = [];

        foreach ($stores as $store) {
            if (!storeEnabled($config, $store)) {
                $map[$norm][$store] = storeResult($store, false, [], 'Tienda deshabilitada', false, null);
                continue;
            }

            $cacheKey = 'price-' . $store . '-' . md5($norm);
            $hit = cacheGet($cacheKey, (int) $config['price_ttl']);
            if (is_array($hit) && is_array($hit['data']['candidates'] ?? null)) {
                $map[$norm][$store] = storeResult(
                    $store,
                    true,
                    $hit['data']['candidates'],
                    null,
                    true,
                    is_string($hit['fetchedAt'] ?? null) ? $hit['fetchedAt'] : isoNow()
                );
                $cachedCount++;
                continue;
            }

            $storeCfg = $store === 'coto' ? cotoConfig($config) : masonlineConfig($config);
            $url = $store === 'coto'
                ? cotoSearchUrl($storeCfg, $query['q'])
                : masonlineSearchUrl($storeCfg, $query['q']);
            $tasks[] = [
                'norm'  => $norm,
                'store' => $store,
                'url'   => $url,
            ];
        }
    }

    $fetchedCount = 0;
    if ($tasks) {
        $urls = array_map(static fn (array $task): string => $task['url'], $tasks);
        $responses = fetchMany(
            $urls,
            (int) $config['timeout'],
            (string) $config['user_agent'],
            (int) $config['concurrency'],
            REQUEST_BUDGET
        );

        foreach ($tasks as $index => $task) {
            $response = $responses[$index] ?? null;
            $store = $task['store'];
            $norm = $task['norm'];

            if ($response === null) {
                $timedOut = true;
                $map[$norm][$store] = storeResult(
                    $store,
                    false,
                    [],
                    'La consulta no se completó dentro del tiempo disponible. Reintentá en unos segundos.',
                    false,
                    null
                );
                continue;
            }
            if (!empty($response['error'])) {
                $map[$norm][$store] = storeResult(
                    $store,
                    false,
                    [],
                    'Error de red al consultar la tienda: ' . $response['error'],
                    false,
                    null
                );
                continue;
            }
            if ((int) $response['code'] >= 400) {
                $hint = (int) $response['code'] === 429
                    ? 'La tienda limitó las consultas. Esperá unos minutos y reintentá.'
                    : 'La tienda respondió con un error. Reintentá más tarde.';
                $map[$norm][$store] = storeResult(
                    $store,
                    false,
                    [],
                    'HTTP ' . (int) $response['code'] . '. ' . $hint,
                    false,
                    null
                );
                continue;
            }

            $body = (string) ($response['body'] ?? '');
            if ($store === 'coto') {
                $parsed = parseCoto($body, $task['norm'], cotoConfig($config));
            } else {
                $parsed = parseMasonline($body, $task['norm']);
            }
            $fetchedCount++;

            if (!$parsed['ok']) {
                $map[$norm][$store] = storeResult($store, false, [], $parsed['error'], false, null);
                continue;
            }

            $candidates = $parsed['candidates'];
            if (count($candidates) > MAX_CACHE_CANDIDATES) {
                $candidates = array_slice($candidates, 0, MAX_CACHE_CANDIDATES);
            }
            cachePut('price-' . $store . '-' . md5($norm), ['candidates' => $candidates]);
            $map[$norm][$store] = storeResult($store, true, $candidates, null, false, isoNow());
        }
    }

    // Recortar a la cantidad pedida y elegir el mejor candidato automático.
    foreach ($map as $norm => $storeResults) {
        foreach ($storeResults as $store => $result) {
            $candidates = array_slice($result['candidates'], 0, $limit);
            $best = null;
            foreach ($candidates as $candidate) {
                if ((int) ($candidate['score'] ?? 0) >= (int) $config['min_score']) {
                    $best = $candidate;
                    break;
                }
            }
            $map[$norm][$store]['candidates'] = $candidates;
            $map[$norm][$store]['best'] = $best;
        }
    }

    return [
        'map'      => $map,
        'cached'   => $cachedCount,
        'fetched'  => $fetchedCount,
        'timedOut' => $timedOut,
    ];
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------

function actionHealth(array $input, array $config): never
{
    $stores = [];
    foreach (ALLOWED_STORES as $store) {
        if (storeEnabled($config, $store)) {
            $stores[] = $store;
        }
    }

    $deep = !empty($input['deep']) && $input['deep'] !== '0' && $input['deep'] !== 'false';
    $deepStatus = ['coto' => null, 'masonline' => null];

    if ($deep) {
        $urls = [];
        $indexByStore = [];
        foreach ($stores as $store) {
            $indexByStore[$store] = count($urls);
            $storeCfg = $store === 'coto' ? cotoConfig($config) : masonlineConfig($config);
            $urls[] = $store === 'coto'
                ? cotoSearchUrl($storeCfg, 'arroz')
                : masonlineSearchUrl($storeCfg, 'arroz');
        }
        $responses = fetchMany($urls, 8, (string) $config['user_agent'], 2, 20);
        foreach ($stores as $store) {
            $response = $responses[$indexByStore[$store]] ?? null;
            if ($response === null) {
                $deepStatus[$store] = 'error: sin respuesta dentro del tiempo disponible';
                continue;
            }
            if (!empty($response['error'])) {
                $deepStatus[$store] = 'error: ' . $response['error'];
                continue;
            }
            if ((int) $response['code'] >= 400) {
                $deepStatus[$store] = 'error: HTTP ' . (int) $response['code'];
                continue;
            }
            $body = (string) ($response['body'] ?? '');
            $parsed = $store === 'coto'
                ? parseCoto($body, 'arroz', cotoConfig($config))
                : parseMasonline($body, 'arroz');
            $deepStatus[$store] = $parsed['ok']
                ? 'ok'
                : 'error: ' . ($parsed['error'] ?? 'respuesta inválida');
        }
    }

    respond(200, [
        'ok'            => true,
        'backend'       => 'inventario via proxy.php (Laragon Apache)',
        'stores'        => $stores,
        'cacheWritable' => cacheWritable(),
        'curlMulti'     => hasCurlMulti(),
        'coto'          => $deepStatus['coto'],
        'masonline'     => $deepStatus['masonline'],
        'version'       => '1.0',
    ]);
}

function actionPrices(array $input, array $config): never
{
    $query = is_string($input['q'] ?? null) ? trim($input['q']) : '';
    if ($query === '') {
        fail(400, 'Falta el término de búsqueda.', 'Usá ?action=prices&q=arroz');
    }
    if (mb_strlen($query, 'UTF-8') > MAX_QUERY_LEN) {
        fail(400, 'El término de búsqueda es demasiado largo.', 'Máximo ' . MAX_QUERY_LEN . ' caracteres.');
    }

    $stores = normalizedStores($input['stores'] ?? null, $config);
    $limit = (int) ($input['limit'] ?? MAX_CANDIDATES);
    $limit = max(1, min(MAX_CANDIDATES, $limit));

    $norm = normalizeText($query);
    if ($norm === '') {
        respond(200, [
            'ok'       => true,
            'query'    => $query,
            'stores'   => new stdClass(),
            'warnings' => ['El término no contiene texto válido para buscar.'],
        ]);
    }

    $resolved = resolvePrices([['q' => $query, 'norm' => $norm]], $stores, $config, $limit);
    $warnings = [];
    if ($resolved['timedOut']) {
        $warnings[] = 'Algunas consultas no se completaron dentro del tiempo disponible.';
    }

    respond(200, [
        'ok'       => true,
        'query'    => $query,
        'stores'   => $resolved['map'][$norm] ?? new stdClass(),
        'warnings' => $warnings,
    ]);
}

function actionPricesBatch(array $input, array $config): never
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        fail(405, 'Esta acción requiere POST.', 'Enviá un JSON con {action:"prices-batch", items:[...]}.');
    }

    $items = $input['items'] ?? null;
    if (!is_array($items) || !array_is_list($items)) {
        fail(400, 'El campo "items" debe ser un array.', 'Ejemplo: {"items":[{"id":"itm_1","q":"arroz"}]}');
    }
    if (count($items) === 0) {
        fail(400, 'El lote está vacío.', 'Agregá al menos un elemento.');
    }
    $maxBatch = (int) $config['max_batch'];
    if (count($items) > $maxBatch) {
        fail(400, 'El lote supera el máximo de ' . $maxBatch . ' elementos.', 'Dividí la consulta en lotes más chicos.');
    }

    $cleanItems = [];
    $queries = [];
    $queryByNorm = [];
    foreach ($items as $index => $item) {
        if (!is_array($item)) {
            continue;
        }
        $query = is_string($item['q'] ?? null) ? trim($item['q']) : '';
        if ($query === '' || mb_strlen($query, 'UTF-8') > MAX_QUERY_LEN) {
            continue;
        }
        $id = isset($item['id']) && is_scalar($item['id']) ? (string) $item['id'] : 'item_' . $index;
        $id = clampText($id, 64);
        $norm = normalizeText($query);
        if ($norm === '') {
            continue;
        }
        $cleanItems[] = ['id' => $id, 'q' => $query, 'norm' => $norm];
        if (!isset($queryByNorm[$norm])) {
            $queryByNorm[$norm] = ['q' => $query, 'norm' => $norm];
            $queries[] = $queryByNorm[$norm];
        }
    }

    if (!$cleanItems) {
        fail(400, 'No hay consultas válidas en el lote.', 'Cada elemento necesita "q" de 1 a ' . MAX_QUERY_LEN . ' caracteres.');
    }

    $stores = normalizedStores($input['stores'] ?? null, $config);
    $started = microtime(true);
    $resolved = resolvePrices($queries, $stores, $config, MAX_CANDIDATES);
    $elapsedMs = (int) round((microtime(true) - $started) * 1000);

    $results = [];
    foreach ($cleanItems as $item) {
        $results[] = [
            'id'     => $item['id'],
            'query'  => $item['q'],
            'stores' => $resolved['map'][$item['norm']] ?? new stdClass(),
        ];
    }

    $warnings = [];
    if ($resolved['timedOut']) {
        $warnings[] = 'Algunas consultas no se completaron dentro del tiempo disponible. Reintentá para completar los precios.';
    }

    respond(200, [
        'ok'      => true,
        'results' => $results,
        'meta'    => [
            'requested' => count($cleanItems),
            'queries'   => count($queries),
            'cached'    => $resolved['cached'],
            'fetched'   => $resolved['fetched'],
            'elapsedMs' => $elapsedMs,
        ],
        'warnings' => $warnings,
    ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

$config = loadConfig();

switch ($action) {
    case 'health':
        actionHealth($input, $config);
    case 'prices':
        actionPrices($input, $config);
    case 'prices-batch':
        actionPricesBatch($input, $config);
    case '':
        fail(400, 'Falta la acción.', 'Usa ?action=health | ?action=prices&q=arroz | POST ?action=prices-batch');
    default:
        fail(400, 'Acción no válida.', 'Usa ?action=health | ?action=prices&q=arroz | POST ?action=prices-batch');
}

<?php
declare(strict_types=1);

header('Cache-Control: no-store');

function app_root_path(): string
{
    return dirname(__DIR__, 2);
}

function data_root_path(): string
{
    return app_root_path() . '/data';
}

function ensure_data_root(): void
{
    $path = data_root_path();
    if (is_dir($path)) {
        return;
    }

    if (!@mkdir($path, 0775, true) && !is_dir($path)) {
        throw new RuntimeException('Nao foi possivel criar a pasta de dados do OAuth no servidor.');
    }
}

function data_file_path(string $fileName): string
{
    ensure_data_root();
    return rtrim(data_root_path(), '/\\') . '/' . ltrim($fileName, '/\\');
}

function request_scheme(): string
{
    $forwardedProto = $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '';
    if ($forwardedProto !== '') {
        $first = strtolower(trim(explode(',', $forwardedProto)[0]));
        return $first === 'https' ? 'https' : 'http';
    }

    $https = strtolower((string) ($_SERVER['HTTPS'] ?? ''));
    return ($https !== '' && $https !== 'off') ? 'https' : 'http';
}

function detect_base_path(): string
{
    $scriptName = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? '/api/index.php'));
    $basePath = dirname(dirname($scriptName));
    if ($basePath === DIRECTORY_SEPARATOR || $basePath === '\\' || $basePath === '.') {
        return '';
    }

    return rtrim(str_replace('\\', '/', $basePath), '/');
}

function detect_base_url(): string
{
    $forwardedHost = $_SERVER['HTTP_X_FORWARDED_HOST'] ?? '';
    $rawHost = $forwardedHost !== '' ? $forwardedHost : (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
    $host = trim(explode(',', $rawHost)[0]);
    return request_scheme() . '://' . $host . detect_base_path();
}

function start_app_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    $basePath = detect_base_path();
    session_name('sf_session');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => $basePath !== '' ? $basePath . '/' : '/',
        'secure' => request_scheme() === 'https',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

function json_response(int $statusCode, array $payload)
{
    http_response_code($statusCode);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function redirect_response(string $location)
{
    header('Location: ' . $location, true, 302);
    exit;
}

function read_json_file(string $path): array
{
    if (!is_file($path)) {
        return [];
    }

    $raw = file_get_contents($path);
    if ($raw === false || trim($raw) === '') {
        return [];
    }

    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function write_json_file(string $path, array $payload): void
{
    $directory = dirname($path);
    if (!is_dir($directory)) {
        if (!@mkdir($directory, 0775, true) && !is_dir($directory)) {
            throw new RuntimeException('Nao foi possivel preparar a pasta de dados do OAuth.');
        }
    }

    $written = file_put_contents(
        $path,
        json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        LOCK_EX
    );

    if ($written === false) {
        throw new RuntimeException('Nao foi possivel gravar os dados do OAuth no servidor.');
    }
}

function delete_file_if_exists(string $path): void
{
    if (is_file($path)) {
        @unlink($path);
    }
}

function config_bool($value, bool $default): bool
{
    if (is_bool($value)) {
        return $value;
    }

    if ($value === null || $value === '') {
        return $default;
    }

    $parsed = filter_var($value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    return $parsed ?? $default;
}

function parse_public_drive_config(string $path): array
{
    $defaults = [
        'clientId' => '',
        'fileName' => 'sf-data.json',
        'legacyFileNames' => ['financeos-data.json'],
        'useAppDataFolder' => true,
        'autoSync' => true,
    ];

    if (!is_file($path)) {
        return $defaults;
    }

    $content = file_get_contents($path);
    if ($content === false) {
        return $defaults;
    }

    if (preg_match('/clientId\s*:\s*"([^"]*)"/', $content, $matches)) {
        $defaults['clientId'] = $matches[1];
    }

    if (preg_match('/fileName\s*:\s*"([^"]*)"/', $content, $matches)) {
        $defaults['fileName'] = $matches[1];
    }

    if (preg_match('/legacyFileNames\s*:\s*\[(.*?)\]/s', $content, $matches)) {
        preg_match_all('/"([^"]+)"/', $matches[1], $legacyMatches);
        if (!empty($legacyMatches[1])) {
            $defaults['legacyFileNames'] = array_values($legacyMatches[1]);
        }
    }

    if (preg_match('/useAppDataFolder\s*:\s*(true|false)/', $content, $matches)) {
        $defaults['useAppDataFolder'] = $matches[1] === 'true';
    }

    if (preg_match('/autoSync\s*:\s*(true|false)/', $content, $matches)) {
        $defaults['autoSync'] = $matches[1] === 'true';
    }

    return $defaults;
}

function test_client_id(string $clientId): bool
{
    return $clientId !== ''
        && str_ends_with($clientId, '.apps.googleusercontent.com')
        && !str_contains($clientId, 'COLOQUE')
        && !str_contains($clientId, 'SEU_CLIENT_ID');
}

function test_client_secret(string $clientSecret): bool
{
    return $clientSecret !== ''
        && !str_contains($clientSecret, 'COLOQUE')
        && !str_contains($clientSecret, 'SEU_CLIENT_SECRET');
}

function get_server_config(): array
{
    static $config = null;
    if ($config !== null) {
        return $config;
    }

    $appRoot = app_root_path();
    $oauthConfig = read_json_file($appRoot . '/config/oauth.local.json');
    $publicConfig = parse_public_drive_config(dirname(__DIR__) . '/drive-config.js');

    $clientId = trim((string) ($oauthConfig['clientId'] ?? $publicConfig['clientId'] ?? ''));
    $clientSecret = trim((string) ($oauthConfig['clientSecret'] ?? ''));
    $fileName = trim((string) ($oauthConfig['fileName'] ?? $publicConfig['fileName'] ?? 'sf-data.json'));
    $legacyFileNames = $oauthConfig['legacyFileNames'] ?? $publicConfig['legacyFileNames'] ?? ['financeos-data.json'];
    $legacyFileNames = array_values(array_filter(array_map(static fn ($item) => trim((string) $item), is_array($legacyFileNames) ? $legacyFileNames : [])));
    if ($legacyFileNames === []) {
        $legacyFileNames = ['financeos-data.json'];
    }

    $useAppDataFolder = config_bool($oauthConfig['useAppDataFolder'] ?? $publicConfig['useAppDataFolder'] ?? true, true);
    $scope = $useAppDataFolder
        ? 'https://www.googleapis.com/auth/drive.appdata'
        : 'https://www.googleapis.com/auth/drive.file';

    $baseUrl = rtrim(trim((string) ($oauthConfig['baseUrl'] ?? detect_base_url())), '/');
    $configured = test_client_id($clientId) && test_client_secret($clientSecret);

    $config = [
        'configured' => $configured,
        'clientId' => $clientId,
        'clientSecret' => $clientSecret,
        'fileName' => $fileName !== '' ? $fileName : 'sf-data.json',
        'legacyFileNames' => $legacyFileNames,
        'useAppDataFolder' => $useAppDataFolder,
        'scope' => $scope,
        'baseUrl' => $baseUrl,
        'redirectUri' => $baseUrl . '/api/auth/google/callback',
        'appUrl' => $baseUrl . '/',
    ];

    return $config;
}

function oauth_session_data(): array
{
    return read_json_file(data_file_path('oauth-session.json'));
}

function save_oauth_session(array $session): void
{
    write_json_file(data_file_path('oauth-session.json'), $session);
}

function clear_oauth_session(): void
{
    delete_file_if_exists(data_file_path('oauth-session.json'));
}

function oauth_state_data(): array
{
    return read_json_file(data_file_path('oauth-state.json'));
}

function save_oauth_state(string $state): void
{
    write_json_file(data_file_path('oauth-state.json'), [
        'value' => $state,
        'createdAt' => gmdate(DATE_ATOM),
    ]);
}

function clear_oauth_state(): void
{
    delete_file_if_exists(data_file_path('oauth-state.json'));
}

function base64url_random_token(): string
{
    return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
}

function build_query_string(array $parameters): string
{
    return http_build_query(array_filter($parameters, static fn ($value) => $value !== null && $value !== ''), '', '&', PHP_QUERY_RFC3986);
}

function http_request(string $method, string $url, array $headers = [], ?string $body = null, ?string $contentType = null): array
{
    $curl = curl_init($url);
    if ($curl === false) {
        throw new RuntimeException('Nao foi possivel iniciar a chamada HTTP.');
    }

    $normalizedHeaders = [];
    foreach ($headers as $name => $value) {
        $normalizedHeaders[] = $name . ': ' . $value;
    }
    if ($contentType !== null && $contentType !== '') {
        $normalizedHeaders[] = 'Content-Type: ' . $contentType;
    }

    curl_setopt_array($curl, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_HTTPHEADER => $normalizedHeaders,
    ]);

    if ($body !== null) {
        curl_setopt($curl, CURLOPT_POSTFIELDS, $body);
    }

    $rawBody = curl_exec($curl);
    if ($rawBody === false) {
        $message = curl_error($curl);
        curl_close($curl);
        throw new RuntimeException($message !== '' ? $message : 'Falha na comunicacao HTTP.');
    }

    $statusCode = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);

    return [
        'status' => $statusCode,
        'body' => $rawBody,
    ];
}

function decode_json_response(array $response): array
{
    $decoded = json_decode((string) $response['body'], true);
    if (($response['status'] ?? 0) >= 400) {
        $message = $decoded['error_description']
            ?? $decoded['error']['message']
            ?? $decoded['error']
            ?? $response['body']
            ?? 'Falha na requisicao remota.';
        throw new RuntimeException((string) $message);
    }

    return is_array($decoded) ? $decoded : [];
}

function form_request(string $url, array $body): array
{
    $response = http_request(
        'POST',
        $url,
        [],
        build_query_string($body),
        'application/x-www-form-urlencoded'
    );

    return decode_json_response($response);
}

function google_request(string $method, string $url, string $accessToken, ?string $body = null, ?string $contentType = null): array
{
    $response = http_request($method, $url, ['Authorization' => 'Bearer ' . $accessToken], $body, $contentType);
    return decode_json_response($response);
}

function exchange_google_auth_code(array $config, string $code): array
{
    return form_request('https://oauth2.googleapis.com/token', [
        'code' => $code,
        'client_id' => $config['clientId'],
        'client_secret' => $config['clientSecret'],
        'redirect_uri' => $config['redirectUri'],
        'grant_type' => 'authorization_code',
    ]);
}

function refresh_google_access_token(array $config, string $refreshToken): array
{
    return form_request('https://oauth2.googleapis.com/token', [
        'client_id' => $config['clientId'],
        'client_secret' => $config['clientSecret'],
        'refresh_token' => $refreshToken,
        'grant_type' => 'refresh_token',
    ]);
}

function oauth_authenticated(array $config): bool
{
    if (!$config['configured']) {
        return false;
    }

    $session = oauth_session_data();
    return trim((string) ($session['refresh_token'] ?? '')) !== '';
}

function get_valid_access_token(array $config): string
{
    $session = oauth_session_data();
    $refreshToken = trim((string) ($session['refresh_token'] ?? ''));
    if ($refreshToken === '') {
        throw new RuntimeException('Nenhuma sessao OAuth ativa para o Drive.');
    }

    $accessToken = trim((string) ($session['access_token'] ?? ''));
    $expiresAt = strtotime((string) ($session['expires_at'] ?? '')) ?: 0;
    if ($accessToken !== '' && $expiresAt > (time() + 60)) {
        return $accessToken;
    }

    try {
        $refreshed = refresh_google_access_token($config, $refreshToken);
    } catch (Throwable $error) {
        clear_oauth_session();
        throw $error;
    }

    $session['access_token'] = (string) ($refreshed['access_token'] ?? '');
    $session['expires_at'] = gmdate(DATE_ATOM, time() + max(((int) ($refreshed['expires_in'] ?? 3600)) - 60, 60));
    $session['updated_at'] = gmdate(DATE_ATOM);
    save_oauth_session($session);

    return $session['access_token'];
}

function escape_drive_query_value(string $value): string
{
    return str_replace(['\\', '\''], ['\\\\', '\\\''], $value);
}

function build_drive_search_url(array $config, string $fileName): string
{
    $baseQuery = sprintf("name='%s' and trashed=false", escape_drive_query_value($fileName));
    $spaces = $config['useAppDataFolder'] ? 'appDataFolder' : 'drive';
    $query = $config['useAppDataFolder']
        ? $baseQuery . " and 'appDataFolder' in parents"
        : $baseQuery;

    return 'https://www.googleapis.com/drive/v3/files?' . build_query_string([
        'fields' => 'files(id,name,modifiedTime)',
        'pageSize' => '1',
        'spaces' => $spaces,
        'q' => $query,
    ]);
}

function get_drive_file_by_id(string $accessToken, string $fileId): ?array
{
    if (trim($fileId) === '') {
        return null;
    }

    try {
        return google_request(
            'GET',
            'https://www.googleapis.com/drive/v3/files/' . rawurlencode($fileId) . '?fields=id,name,modifiedTime',
            $accessToken
        );
    } catch (Throwable) {
        return null;
    }
}

function find_drive_file(array $config, string $accessToken): ?array
{
    $candidateNames = array_values(array_unique(array_merge(
        [$config['fileName']],
        array_filter($config['legacyFileNames'], static fn ($name) => $name !== '' && $name !== $config['fileName'])
    )));

    foreach ($candidateNames as $candidateName) {
        $payload = google_request('GET', build_drive_search_url($config, $candidateName), $accessToken);
        $file = $payload['files'][0] ?? null;
        if (is_array($file)) {
            return [
                'id' => (string) ($file['id'] ?? ''),
                'name' => (string) ($file['name'] ?? ''),
                'isLegacy' => $candidateName !== $config['fileName'],
            ];
        }
    }

    return null;
}

function rename_drive_file(string $accessToken, string $fileId, string $fileName): array
{
    return google_request(
        'PATCH',
        'https://www.googleapis.com/drive/v3/files/' . rawurlencode($fileId),
        $accessToken,
        json_encode(['name' => $fileName], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        'application/json; charset=utf-8'
    );
}

function ensure_preferred_drive_file(array $config, string $accessToken, ?array $file): ?array
{
    if (!$file || trim((string) ($file['id'] ?? '')) === '') {
        return $file;
    }

    $currentName = (string) ($file['name'] ?? '');
    if ($currentName === $config['fileName']) {
        return $file;
    }

    if (!in_array($currentName, $config['legacyFileNames'], true)) {
        return $file;
    }

    $renamed = rename_drive_file($accessToken, (string) $file['id'], $config['fileName']);
    return [
        'id' => (string) ($file['id'] ?? ''),
        'name' => (string) ($renamed['name'] ?? $config['fileName']),
        'isLegacy' => false,
    ];
}

function fetch_drive_envelope(string $accessToken, string $fileId): array
{
    return google_request(
        'GET',
        'https://www.googleapis.com/drive/v3/files/' . rawurlencode($fileId) . '?alt=media',
        $accessToken
    );
}

function create_drive_file(array $config, string $accessToken, string $envelopeJson): array
{
    $boundary = 'sf-' . bin2hex(random_bytes(8));
    $metadata = ['name' => $config['fileName']];
    if ($config['useAppDataFolder']) {
        $metadata['parents'] = ['appDataFolder'];
    }

    $body =
        "--{$boundary}\r\n" .
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" .
        json_encode($metadata, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\r\n" .
        "--{$boundary}\r\n" .
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" .
        $envelopeJson . "\r\n" .
        "--{$boundary}--";

    return google_request(
        'POST',
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        $accessToken,
        $body,
        'multipart/related; boundary=' . $boundary
    );
}

function update_drive_file(string $accessToken, string $fileId, string $envelopeJson): array
{
    return google_request(
        'PATCH',
        'https://www.googleapis.com/upload/drive/v3/files/' . rawurlencode($fileId) . '?uploadType=media',
        $accessToken,
        $envelopeJson,
        'application/json; charset=utf-8'
    );
}

function current_drive_file(array $config, string $accessToken): ?array
{
    $session = oauth_session_data();
    $fileId = trim((string) ($session['file_id'] ?? ''));
    $file = $fileId !== '' ? get_drive_file_by_id($accessToken, $fileId) : null;
    if ($file) {
        return $file;
    }

    return find_drive_file($config, $accessToken);
}

function save_drive_file_id(string $fileId): void
{
    $session = oauth_session_data();
    if ($session === []) {
        return;
    }

    $session['file_id'] = $fileId;
    $session['updated_at'] = gmdate(DATE_ATOM);
    save_oauth_session($session);
}

function auth_session_payload(): array
{
    $config = get_server_config();
    $session = oauth_session_data();

    return [
        'configured' => (bool) $config['configured'],
        'authenticated' => oauth_authenticated($config),
        'fileName' => (string) $config['fileName'],
        'useAppDataFolder' => (bool) $config['useAppDataFolder'],
        'fileId' => (string) ($session['file_id'] ?? ''),
        'redirectUri' => (string) $config['redirectUri'],
        'baseUrl' => (string) $config['baseUrl'],
    ];
}

function is_drive_not_found_error(Throwable $error): bool
{
    $message = strtolower(trim($error->getMessage()));
    return str_contains($message, 'file not found')
        || str_contains($message, '=media')
        || str_contains($message, 'notfound');
}

function handle_auth_start()
{
    $config = get_server_config();
    if (!$config['configured']) {
        json_response(500, [
            'error' => 'OAuth do servidor ainda nao foi configurado. Preencha config/oauth.local.json com clientId, clientSecret e baseUrl.',
            'redirectUri' => $config['redirectUri'],
        ]);
    }

    $state = base64url_random_token();
    save_oauth_state($state);

    $authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' . build_query_string([
        'client_id' => $config['clientId'],
        'redirect_uri' => $config['redirectUri'],
        'response_type' => 'code',
        'scope' => $config['scope'],
        'access_type' => 'offline',
        'include_granted_scopes' => 'true',
        'prompt' => 'consent',
        'state' => $state,
    ]);

    redirect_response($authUrl);
}

function handle_auth_callback()
{
    $config = get_server_config();
    if (!$config['configured']) {
        redirect_response($config['appUrl'] . '?auth=error&message=' . rawurlencode('oauth-config-missing'));
    }

    if (isset($_GET['error'])) {
        redirect_response($config['appUrl'] . '?auth=error&message=' . rawurlencode((string) $_GET['error']));
    }

    $savedState = oauth_state_data();
    $stateValue = (string) ($savedState['value'] ?? '');
    $stateCreatedAt = strtotime((string) ($savedState['createdAt'] ?? '')) ?: 0;
    $isValidState = $stateValue !== ''
        && hash_equals($stateValue, (string) ($_GET['state'] ?? ''))
        && $stateCreatedAt > 0
        && $stateCreatedAt >= (time() - 900);

    if (!$isValidState) {
        clear_oauth_state();
        redirect_response($config['appUrl'] . '?auth=error&message=' . rawurlencode('state-invalid'));
    }

    $code = trim((string) ($_GET['code'] ?? ''));
    if ($code === '') {
        clear_oauth_state();
        redirect_response($config['appUrl'] . '?auth=error&message=' . rawurlencode('missing-code'));
    }

    try {
        $tokens = exchange_google_auth_code($config, $code);
        $existingSession = oauth_session_data();
        $refreshToken = trim((string) ($tokens['refresh_token'] ?? $existingSession['refresh_token'] ?? ''));
        if ($refreshToken === '') {
            throw new RuntimeException('Google nao retornou refresh token. Revise o consentimento e o access_type=offline.');
        }

        save_oauth_session([
            'refresh_token' => $refreshToken,
            'access_token' => (string) ($tokens['access_token'] ?? ''),
            'expires_at' => gmdate(DATE_ATOM, time() + max(((int) ($tokens['expires_in'] ?? 3600)) - 60, 60)),
            'file_id' => (string) ($existingSession['file_id'] ?? ''),
            'scope' => (string) ($tokens['scope'] ?? ''),
            'updated_at' => gmdate(DATE_ATOM),
        ]);

        clear_oauth_state();
        redirect_response($config['appUrl'] . '?auth=success');
    } catch (Throwable $error) {
        clear_oauth_state();
        redirect_response($config['appUrl'] . '?auth=error&message=' . rawurlencode($error->getMessage()));
    }
}

function handle_auth_logout()
{
    clear_oauth_session();
    clear_oauth_state();
    json_response(200, ['ok' => true]);
}

function handle_drive_envelope_get()
{
    $config = get_server_config();
    if (!oauth_authenticated($config)) {
        json_response(401, ['error' => 'Nao autenticado no Google Drive.']);
    }

    try {
        $accessToken = get_valid_access_token($config);
        $file = current_drive_file($config, $accessToken);
        if (!$file || trim((string) ($file['id'] ?? '')) === '') {
            json_response(200, ['fileId' => '', 'envelope' => null]);
        }

        save_drive_file_id((string) $file['id']);
        try {
            $envelope = fetch_drive_envelope($accessToken, (string) $file['id']);
        } catch (Throwable $error) {
            if (is_drive_not_found_error($error)) {
                save_drive_file_id('');
                json_response(200, ['fileId' => '', 'envelope' => null]);
            }
            throw $error;
        }

        json_response(200, [
            'fileId' => (string) $file['id'],
            'envelope' => $envelope,
        ]);
    } catch (Throwable $error) {
        json_response(500, ['error' => $error->getMessage()]);
    }
}

function handle_drive_envelope_save()
{
    $config = get_server_config();
    if (!oauth_authenticated($config)) {
        json_response(401, ['error' => 'Nao autenticado no Google Drive.']);
    }

    $payload = trim((string) ($_POST['payload'] ?? ''));
    if ($payload === '') {
        json_response(400, ['error' => 'Payload ausente.']);
    }

    $decodedPayload = json_decode($payload, true);
    if (!is_array($decodedPayload)) {
        json_response(400, ['error' => 'Payload JSON invalido.']);
    }

    try {
        $accessToken = get_valid_access_token($config);
        $file = current_drive_file($config, $accessToken);
        if (!$file || trim((string) ($file['id'] ?? '')) === '') {
            $created = create_drive_file($config, $accessToken, $payload);
            $fileId = (string) ($created['id'] ?? '');
            save_drive_file_id($fileId);
            json_response(200, ['fileId' => $fileId, 'status' => 'created']);
        }

        $preferredFile = ensure_preferred_drive_file($config, $accessToken, $file);
        try {
            $updated = update_drive_file($accessToken, (string) ($preferredFile['id'] ?? ''), $payload);
        } catch (Throwable $error) {
            if (!is_drive_not_found_error($error)) {
                throw $error;
            }

            save_drive_file_id('');
            $created = create_drive_file($config, $accessToken, $payload);
            $fileId = (string) ($created['id'] ?? '');
            save_drive_file_id($fileId);
            json_response(200, ['fileId' => $fileId, 'status' => 'created']);
        }

        $fileId = (string) ($updated['id'] ?? ($preferredFile['id'] ?? ''));
        save_drive_file_id($fileId);
        json_response(200, ['fileId' => $fileId, 'status' => 'updated']);
    } catch (Throwable $error) {
        json_response(500, ['error' => $error->getMessage()]);
    }
}

$requestPath = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';
$basePath = detect_base_path();
$routePath = $requestPath;
if ($basePath !== '' && str_starts_with($requestPath, $basePath)) {
    $routePath = substr($requestPath, strlen($basePath)) ?: '/';
}

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));

switch ($method . ' ' . $routePath) {
    case 'GET /api/auth/session':
        json_response(200, auth_session_payload());
    case 'GET /api/auth/google/start':
        handle_auth_start();
    case 'GET /api/auth/google/callback':
        handle_auth_callback();
    case 'POST /api/auth/logout':
        handle_auth_logout();
    case 'GET /api/drive/envelope':
        handle_drive_envelope_get();
    case 'POST /api/drive/envelope':
        handle_drive_envelope_save();
    default:
        json_response(404, ['error' => 'Rota API nao encontrada.']);
}

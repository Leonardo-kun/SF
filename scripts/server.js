#!/usr/bin/env node

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const projectRoot = path.resolve(__dirname, '..');
const publicRoot = path.join(projectRoot, 'public');
const configRoot = path.join(projectRoot, 'config');
const dataRoot = path.join(projectRoot, 'data');
const oauthConfigPath = path.join(configRoot, 'oauth.local.json');
const publicDriveConfigPath = path.join(publicRoot, 'drive-config.js');
const oauthStatePath = path.join(dataRoot, 'oauth-state.json');
const oauthSessionPath = path.join(dataRoot, 'oauth-session.json');
const debugLogPath = path.join(dataRoot, 'server-debug.log');
const defaultFile = 'index.html';
const serverPort = parsePort(process.argv, process.env.PORT || '8080');

fs.mkdirSync(configRoot, { recursive: true });
fs.mkdirSync(dataRoot, { recursive: true });

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

function parsePort(argv, fallback) {
  const args = [...argv];
  const flagIndex = args.findIndex((value) => value === '--port' || value === '-p');
  const rawValue = flagIndex >= 0 ? args[flagIndex + 1] : fallback;
  const port = Number.parseInt(String(rawValue || ''), 10);
  return Number.isInteger(port) && port > 0 ? port : 8080;
}

function isoNow() {
  return new Date().toISOString();
}

function ensureDataRoot() {
  fs.mkdirSync(dataRoot, { recursive: true });
}

function writeDebugLog(message) {
  ensureDataRoot();
  fs.appendFileSync(debugLogPath, `[${isoNow()}] ${message}\n`, 'utf8');
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (error) {
    writeDebugLog(`Falha ao ler JSON em ${filePath}: ${error.message}`);
    return null;
  }
}

function writeJsonFile(filePath, value) {
  ensureDataRoot();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function removeFileIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function getPublicDriveConfig() {
  const defaults = {
    clientId: '',
    fileName: 'sf-data.json',
    legacyFileNames: ['financeos-data.json'],
    useAppDataFolder: true,
    autoSync: true,
  };

  if (!fs.existsSync(publicDriveConfigPath)) {
    return defaults;
  }

  const content = fs.readFileSync(publicDriveConfigPath, 'utf8');
  const clientIdMatch = content.match(/clientId\s*:\s*"([^"]*)"/);
  const fileNameMatch = content.match(/fileName\s*:\s*"([^"]*)"/);
  const legacyMatch = content.match(/legacyFileNames\s*:\s*\[(.*?)\]/s);
  const appDataMatch = content.match(/useAppDataFolder\s*:\s*(true|false)/);
  const autoSyncMatch = content.match(/autoSync\s*:\s*(true|false)/);

  if (clientIdMatch) defaults.clientId = clientIdMatch[1];
  if (fileNameMatch) defaults.fileName = fileNameMatch[1];
  if (legacyMatch) {
    const legacyNames = [...legacyMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    if (legacyNames.length) defaults.legacyFileNames = legacyNames;
  }
  if (appDataMatch) defaults.useAppDataFolder = appDataMatch[1] === 'true';
  if (autoSyncMatch) defaults.autoSync = autoSyncMatch[1] === 'true';

  return defaults;
}

function testClientId(clientId) {
  return Boolean(
    clientId &&
    clientId.endsWith('.apps.googleusercontent.com') &&
    !clientId.includes('COLOQUE') &&
    !clientId.includes('SEU_CLIENT_ID')
  );
}

function testClientSecret(clientSecret) {
  return Boolean(
    clientSecret &&
    !clientSecret.includes('COLOQUE') &&
    !clientSecret.includes('SEU_CLIENT_SECRET')
  );
}

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function getRequestBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const host = forwardedHost || req.headers.host || `localhost:${serverPort}`;
  return `${protocol}://${host}`;
}

function getDriveServerConfig(req) {
  const publicConfig = getPublicDriveConfig();
  const oauthConfig = readJsonFile(oauthConfigPath) || {};
  const clientId = String(oauthConfig.clientId || publicConfig.clientId || '').trim();
  const clientSecret = String(oauthConfig.clientSecret || '').trim();
  const fileName = String(oauthConfig.fileName || publicConfig.fileName || 'sf-data.json').trim() || 'sf-data.json';
  const legacyFileNames = Array.isArray(oauthConfig.legacyFileNames)
    ? oauthConfig.legacyFileNames.map((value) => String(value || '').trim()).filter(Boolean)
    : publicConfig.legacyFileNames;
  const useAppDataFolder = normalizeBoolean(
    oauthConfig.useAppDataFolder,
    normalizeBoolean(publicConfig.useAppDataFolder, true)
  );
  const baseUrl = req
    ? getRequestBaseUrl(req)
    : String(oauthConfig.baseUrl || '').trim().replace(/\/+$/, '') || `http://localhost:${serverPort}`;
  const scope = useAppDataFolder
    ? 'https://www.googleapis.com/auth/drive.appdata'
    : 'https://www.googleapis.com/auth/drive.file';

  return {
    configured: testClientId(clientId) && testClientSecret(clientSecret),
    clientId,
    clientSecret,
    fileName,
    legacyFileNames: legacyFileNames.length ? legacyFileNames : ['financeos-data.json'],
    useAppDataFolder,
    scope,
    baseUrl,
    redirectUri: `${baseUrl}/api/auth/google/callback`,
  };
}

function readOauthSession() {
  return readJsonFile(oauthSessionPath);
}

function saveOauthSession(session) {
  writeJsonFile(oauthSessionPath, session);
}

function clearOauthSession() {
  removeFileIfExists(oauthSessionPath);
}

function readOauthState() {
  return readJsonFile(oauthStatePath);
}

function saveOauthState(state) {
  writeJsonFile(oauthStatePath, {
    value: state,
    createdAt: isoNow(),
  });
}

function clearOauthState() {
  removeFileIfExists(oauthStatePath);
}

function newRandomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function escapeDriveQueryValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function buildDriveSearchUrl(config, fileName) {
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  const baseQuery = `name='${escapeDriveQueryValue(fileName)}' and trashed=false`;
  url.searchParams.set('fields', 'files(id,name,modifiedTime)');
  url.searchParams.set('pageSize', '1');
  url.searchParams.set('orderBy', 'modifiedTime desc');
  if (config.useAppDataFolder) {
    url.searchParams.set('spaces', 'appDataFolder');
    url.searchParams.set('q', `${baseQuery} and 'appDataFolder' in parents`);
  } else {
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('q', baseQuery);
  }
  return url.toString();
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function decodeJsonResponse(response) {
  const raw = await response.text();
  let payload = null;
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      payload?.error_description ||
      payload?.error?.message ||
      payload?.error ||
      raw ||
      `HTTP ${response.status}`;
    throw new Error(String(message));
  }

  return payload || {};
}

async function formRequest(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
  return decodeJsonResponse(response);
}

async function googleRequest(method, url, accessToken, body = null, contentType = '', extraHeaders = {}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...extraHeaders,
  };
  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
  });

  return decodeJsonResponse(response);
}

async function exchangeGoogleAuthCode(config, code) {
  return formRequest('https://oauth2.googleapis.com/token', {
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  });
}

async function refreshGoogleAccessToken(config, refreshToken) {
  return formRequest('https://oauth2.googleapis.com/token', {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
}

function testOauthAuthenticated(config) {
  if (!config.configured) return false;
  const session = readOauthSession();
  return Boolean(session?.refresh_token);
}

async function getValidAccessToken(config) {
  const session = readOauthSession();
  if (!session?.refresh_token) {
    throw new Error('Nenhuma sessao OAuth ativa para o Drive.');
  }

  const expiresAt = session.expires_at ? Date.parse(session.expires_at) : 0;
  const now = Date.now();
  if (session.access_token && Number.isFinite(expiresAt) && expiresAt > now + 60_000) {
    return String(session.access_token);
  }

  try {
    const refreshed = await refreshGoogleAccessToken(config, String(session.refresh_token));
    session.access_token = String(refreshed.access_token || '');
    session.expires_at = new Date(Date.now() + (Number(refreshed.expires_in || 3600) - 60) * 1000).toISOString();
    session.updated_at = isoNow();
    saveOauthSession(session);
    return String(session.access_token);
  } catch (error) {
    const message = String(error.message || error);
    if (message.toLowerCase().includes('invalid_grant')) {
      clearOauthSession();
    } else if (session.access_token) {
      writeDebugLog(`Falha ao renovar o token do Drive; reutilizando o token atual. Motivo: ${message}`);
      return String(session.access_token);
    }
    throw error;
  }
}

function testDriveNotFoundError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('file not found') ||
    message.includes('notfound') ||
    message.includes('404')
  );
}

async function getDriveFileById(accessToken, fileId) {
  if (!fileId) return null;
  try {
    return await googleRequest(
      'GET',
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,modifiedTime`,
      accessToken
    );
  } catch {
    return null;
  }
}

async function findDriveFile(config, accessToken) {
  const candidateNames = [config.fileName, ...config.legacyFileNames.filter((name) => name && name !== config.fileName)];
  for (const candidateName of candidateNames) {
    const payload = await googleRequest('GET', buildDriveSearchUrl(config, candidateName), accessToken);
    const file = Array.isArray(payload.files) ? payload.files[0] : null;
    if (file?.id) {
      return {
        id: String(file.id),
        name: String(file.name || candidateName),
        isLegacy: candidateName !== config.fileName,
      };
    }
  }
  return null;
}

async function renameDriveFile(accessToken, fileId, fileName) {
  return googleRequest(
    'PATCH',
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
    accessToken,
    JSON.stringify({ name: fileName }),
    'application/json; charset=utf-8'
  );
}

async function ensurePreferredDriveFile(config, accessToken, file) {
  if (!file?.id) return file;
  if (String(file.name) === String(config.fileName)) return file;
  if (!config.legacyFileNames.includes(String(file.name))) return file;

  try {
    const renamed = await renameDriveFile(accessToken, String(file.id), config.fileName);
    return {
      id: String(file.id),
      name: String(renamed.name || config.fileName),
      isLegacy: false,
    };
  } catch (error) {
    writeDebugLog(`Nao foi possivel promover o backup legado para o nome novo: ${error.message}`);
    return file;
  }
}

async function fetchDriveEnvelope(accessToken, fileId) {
  return googleRequest(
    'GET',
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    accessToken
  );
}

async function createDriveFile(config, accessToken, envelopeJson) {
  const boundary = `sf-${crypto.randomBytes(12).toString('hex')}`;
  const metadata = { name: config.fileName };
  if (config.useAppDataFolder) {
    metadata.parents = ['appDataFolder'];
  }

  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${envelopeJson}\r\n` +
    `--${boundary}--`;

  return googleRequest(
    'POST',
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    accessToken,
    Buffer.from(body, 'utf8'),
    `multipart/related; boundary=${boundary}`
  );
}

async function updateDriveFile(accessToken, fileId, envelopeJson) {
  return googleRequest(
    'PATCH',
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
    accessToken,
    envelopeJson,
    'application/json; charset=utf-8'
  );
}

async function getOrFindDriveFile(config, accessToken) {
  const session = readOauthSession();
  let file = null;
  if (session?.file_id) {
    file = await getDriveFileById(accessToken, String(session.file_id));
  }
  if (!file) {
    file = await findDriveFile(config, accessToken);
  }
  return file;
}

function saveDriveFileId(fileId) {
  const session = readOauthSession();
  if (!session) return;
  session.file_id = fileId;
  session.updated_at = isoNow();
  saveOauthSession(session);
}

function getAuthSessionPayload(req) {
  const config = getDriveServerConfig(req);
  const session = readOauthSession();
  return {
    configured: Boolean(config.configured),
    authenticated: Boolean(testOauthAuthenticated(config)),
    fileName: config.fileName,
    useAppDataFolder: Boolean(config.useAppDataFolder),
    fileId: session?.file_id ? String(session.file_id) : '',
    baseUrl: config.baseUrl,
    redirectUri: config.redirectUri,
  };
}

function sendResponse(req, res, statusCode, headers, bodyBuffer = Buffer.alloc(0)) {
  const finalHeaders = {
    'Cache-Control': 'no-store',
    'Content-Length': bodyBuffer.length,
    ...headers,
  };
  res.writeHead(statusCode, finalHeaders);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(bodyBuffer);
}

function sendJson(req, res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  sendResponse(req, res, statusCode, { 'Content-Type': 'application/json; charset=utf-8' }, body);
}

function sendText(req, res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  sendResponse(req, res, statusCode, { 'Content-Type': contentType }, body);
}

function sendRedirect(req, res, location) {
  const body = Buffer.from('Redirecting...', 'utf8');
  sendResponse(req, res, 302, { Location: location, 'Content-Type': 'text/plain; charset=utf-8' }, body);
}

async function handleAuthStart(req, res) {
  const config = getDriveServerConfig(req);
  if (!config.configured) {
    sendJson(req, res, 500, { error: 'OAuth do servidor ainda nao foi configurado. Preencha config/oauth.local.json.' });
    return;
  }

  const state = newRandomToken();
  saveOauthState(state);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', config.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', config.scope);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);

  sendRedirect(req, res, authUrl.toString());
}

async function handleAuthCallback(req, res, requestUrl) {
  const config = getDriveServerConfig(req);
  if (!config.configured) {
    sendRedirect(req, res, '/?auth=error&message=oauth-config-missing');
    return;
  }

  const authError = requestUrl.searchParams.get('error');
  if (authError) {
    sendRedirect(req, res, `/?auth=error&message=${encodeURIComponent(authError)}`);
    return;
  }

  const savedState = readOauthState();
  const receivedState = requestUrl.searchParams.get('state') || '';
  const stateCreatedAt = savedState?.createdAt ? Date.parse(savedState.createdAt) : 0;
  const stateValid =
    Boolean(savedState?.value) &&
    savedState.value === receivedState &&
    Number.isFinite(stateCreatedAt) &&
    stateCreatedAt + 15 * 60_000 >= Date.now();

  if (!stateValid) {
    clearOauthState();
    sendRedirect(req, res, '/?auth=error&message=state-invalid');
    return;
  }

  const code = requestUrl.searchParams.get('code');
  if (!code) {
    clearOauthState();
    sendRedirect(req, res, '/?auth=error&message=missing-code');
    return;
  }

  try {
    const tokens = await exchangeGoogleAuthCode(config, code);
    const existingSession = readOauthSession();
    const refreshToken = tokens.refresh_token || existingSession?.refresh_token || '';

    if (!refreshToken) {
      throw new Error('Google nao retornou refresh token. Revise o consentimento e o access_type=offline.');
    }

    saveOauthSession({
      refresh_token: String(refreshToken),
      access_token: String(tokens.access_token || ''),
      expires_at: new Date(Date.now() + (Number(tokens.expires_in || 3600) - 60) * 1000).toISOString(),
      file_id: existingSession?.file_id ? String(existingSession.file_id) : '',
      scope: tokens.scope ? String(tokens.scope) : '',
      updated_at: isoNow(),
    });

    clearOauthState();
    sendRedirect(req, res, '/?auth=success');
  } catch (error) {
    clearOauthState();
    writeDebugLog(`Falha no callback OAuth: ${error.message}`);
    sendRedirect(req, res, `/?auth=error&message=${encodeURIComponent(String(error.message || error))}`);
  }
}

async function handleAuthLogout(req, res) {
  clearOauthSession();
  clearOauthState();
  sendJson(req, res, 200, { ok: true });
}

async function handleDriveEnvelopeGet(req, res) {
  const config = getDriveServerConfig(req);
  if (!testOauthAuthenticated(config)) {
    sendJson(req, res, 401, { error: 'Nao autenticado no Google Drive.' });
    return;
  }

  try {
    const accessToken = await getValidAccessToken(config);
    const file = await getOrFindDriveFile(config, accessToken);

    if (!file?.id) {
      sendJson(req, res, 200, { fileId: '', envelope: null });
      return;
    }

    saveDriveFileId(String(file.id));

    try {
      const envelope = await fetchDriveEnvelope(accessToken, String(file.id));
      sendJson(req, res, 200, { fileId: String(file.id), envelope });
    } catch (error) {
      if (testDriveNotFoundError(error)) {
        saveDriveFileId('');
        sendJson(req, res, 200, { fileId: '', envelope: null });
        return;
      }
      throw error;
    }
  } catch (error) {
    writeDebugLog(`Drive envelope GET falhou: ${error.message}`);
    sendJson(req, res, 500, { error: String(error.message || error) });
  }
}

async function handleDriveEnvelopeSave(req, res, requestBody) {
  const config = getDriveServerConfig(req);
  if (!testOauthAuthenticated(config)) {
    sendJson(req, res, 401, { error: 'Nao autenticado no Google Drive.' });
    return;
  }

  const params = new URLSearchParams(requestBody);
  const payload = params.get('payload');
  if (!payload || !payload.trim()) {
    sendJson(req, res, 400, { error: 'Payload ausente.' });
    return;
  }

  try {
    JSON.parse(payload);
  } catch {
    sendJson(req, res, 400, { error: 'Payload JSON invalido.' });
    return;
  }

  try {
    const accessToken = await getValidAccessToken(config);
    const file = await getOrFindDriveFile(config, accessToken);

    if (!file?.id) {
      const created = await createDriveFile(config, accessToken, payload);
      const createdId = String(created.id || '');
      saveDriveFileId(createdId);
      sendJson(req, res, 200, { fileId: createdId, status: 'created' });
      return;
    }

    const preferredFile = await ensurePreferredDriveFile(config, accessToken, file);

    try {
      const updated = await updateDriveFile(accessToken, String(preferredFile.id), payload);
      const fileId = String(updated.id || preferredFile.id || '');
      saveDriveFileId(fileId);
      sendJson(req, res, 200, { fileId, status: 'updated' });
    } catch (error) {
      if (!testDriveNotFoundError(error)) {
        throw error;
      }

      saveDriveFileId('');
      const created = await createDriveFile(config, accessToken, payload);
      const createdId = String(created.id || '');
      saveDriveFileId(createdId);
      sendJson(req, res, 200, { fileId: createdId, status: 'created' });
    }
  } catch (error) {
    writeDebugLog(`Drive envelope SAVE falhou: ${error.message}`);
    sendJson(req, res, 500, { error: String(error.message || error) });
  }
}

function resolveStaticPath(requestUrl) {
  const pathname = decodeURIComponent(requestUrl.pathname);
  const relativePath = pathname === '/' ? defaultFile : pathname.replace(/^\/+/, '');
  const fullPath = path.resolve(publicRoot, relativePath);
  const publicBase = path.resolve(publicRoot);
  if (fullPath !== publicBase && !fullPath.startsWith(`${publicBase}${path.sep}`)) {
    return null;
  }
  return fullPath;
}

async function handleStaticFile(req, res, requestUrl) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    sendText(req, res, 405, 'Metodo nao suportado para arquivos estaticos.');
    return;
  }

  const fullPath = resolveStaticPath(requestUrl);
  if (!fullPath) {
    sendText(req, res, 404, 'Arquivo nao encontrado.');
    return;
  }

  try {
    const stats = await fsp.stat(fullPath);
    if (!stats.isFile()) {
      sendText(req, res, 404, 'Arquivo nao encontrado.');
      return;
    }

    const body = await fsp.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = contentTypes.get(ext) || 'application/octet-stream';
    sendResponse(req, res, 200, { 'Content-Type': contentType }, body);
  } catch {
    sendText(req, res, 404, 'Arquivo nao encontrado.');
  }
}

async function handleApiRequest(req, res, requestUrl, requestBody) {
  const routeKey = `${req.method} ${requestUrl.pathname}`;
  switch (routeKey) {
    case 'GET /api/auth/session':
    case 'HEAD /api/auth/session':
      sendJson(req, res, 200, getAuthSessionPayload(req));
      return;
    case 'GET /api/auth/google/start':
    case 'HEAD /api/auth/google/start':
      await handleAuthStart(req, res);
      return;
    case 'GET /api/auth/google/callback':
    case 'HEAD /api/auth/google/callback':
      await handleAuthCallback(req, res, requestUrl);
      return;
    case 'POST /api/auth/logout':
      await handleAuthLogout(req, res);
      return;
    case 'GET /api/drive/envelope':
    case 'HEAD /api/drive/envelope':
      await handleDriveEnvelopeGet(req, res);
      return;
    case 'POST /api/drive/envelope':
      await handleDriveEnvelopeSave(req, res, requestBody);
      return;
    default:
      sendJson(req, res, 404, { error: 'Rota API nao encontrada.' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `localhost:${serverPort}`}`);
    if (!['GET', 'HEAD', 'POST'].includes(req.method || '')) {
      sendText(req, res, 405, 'Metodo nao suportado.');
      return;
    }

    const requestBody = req.method === 'POST' ? await readRequestBody(req) : '';
    if (requestUrl.pathname.startsWith('/api/')) {
      await handleApiRequest(req, res, requestUrl, requestBody);
      return;
    }

    await handleStaticFile(req, res, requestUrl);
  } catch (error) {
    writeDebugLog(`Loop principal falhou: ${error.message}`);
    sendText(req, res, 500, String(error.message || error));
  }
});

server.listen(serverPort, '127.0.0.1', () => {
  console.log(`SF em http://localhost:${serverPort}`);
  console.log(`Pasta servida: ${publicRoot}`);
  console.log(`Config do OAuth: ${oauthConfigPath}`);
  console.log('Pressione Ctrl+C para encerrar.');
});

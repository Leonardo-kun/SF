#!/usr/bin/env node

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const projectRoot = path.resolve(__dirname, '..');
const publicRoot = path.join(projectRoot, 'public');
const configRoot = resolveOptionalPath(process.env.SF_CONFIG_DIR, path.join(projectRoot, 'config'));
const dataRoot = resolveOptionalPath(process.env.SF_DATA_DIR || process.env.DATA_ROOT, path.join(projectRoot, 'data'));
const oauthConfigPath = path.join(configRoot, 'oauth.local.json');
const publicDriveConfigPath = path.join(publicRoot, 'drive-config.js');
const debugLogPath = path.join(dataRoot, 'server-debug.log');
const sessionsRoot = path.join(dataRoot, 'sessions');
const defaultFile = 'index.html';
const localPort = parsePort(process.argv, '8080');
const PORT = Number.parseInt(String(process.env.PORT || ''), 10) || localPort;
const SESSION_COOKIE_NAME = 'sf_session';
const SESSION_SECRET = String(
  process.env.SF_SESSION_SECRET ||
  process.env.SESSION_SECRET ||
  'sf-local-dev-only-change-me'
);

fs.mkdirSync(configRoot, { recursive: true });
fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(sessionsRoot, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

function resolveOptionalPath(value, fallbackPath) {
  if (!value) return fallbackPath;
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

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
  fs.mkdirSync(sessionsRoot, { recursive: true });
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

function sessionFilePath(sessionId) {
  return path.join(sessionsRoot, `${sessionId}.json`);
}

function createEmptySessionData() {
  const now = isoNow();
  return {
    createdAt: now,
    updatedAt: now,
    oauthState: null,
    oauthSession: null,
  };
}

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) return result;
  for (const part of String(cookieHeader).split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) continue;
    result[rawKey] = decodeURIComponent(rawValue.join('=') || '');
  }
  return result;
}

function signSessionId(sessionId) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(sessionId).digest('base64url');
}

function encodeSessionCookie(sessionId) {
  return `${sessionId}.${signSessionId(sessionId)}`;
}

function decodeSessionCookie(cookieValue) {
  if (!cookieValue || !String(cookieValue).includes('.')) return null;
  const value = String(cookieValue);
  const separatorIndex = value.lastIndexOf('.');
  const sessionId = value.slice(0, separatorIndex);
  const providedSignature = value.slice(separatorIndex + 1);
  if (!sessionId || !providedSignature) return null;

  const expectedSignature = signSessionId(sessionId);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return null;
  return sessionId;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}

function setSessionCookie(req, res, sessionId) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, encodeSessionCookie(sessionId), {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    maxAge: 60 * 60 * 24 * 30,
  }));
}

function readSessionDataById(sessionId) {
  if (!sessionId) return null;
  return readJsonFile(sessionFilePath(sessionId));
}

function writeSessionDataById(sessionId, data) {
  const nextData = {
    ...createEmptySessionData(),
    ...data,
    updatedAt: isoNow(),
  };
  writeJsonFile(sessionFilePath(sessionId), nextData);
  return nextData;
}

function attachSession(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const rawCookie = cookies[SESSION_COOKIE_NAME];
    const sessionIdFromCookie = decodeSessionCookie(rawCookie);
    let sessionId = sessionIdFromCookie;
    let sessionData = sessionId ? readSessionDataById(sessionId) : null;

    if (!sessionId || !sessionData) {
      sessionId = crypto.randomBytes(24).toString('base64url');
      sessionData = writeSessionDataById(sessionId, createEmptySessionData());
      setSessionCookie(req, res, sessionId);
    }

    req.sfSession = {
      id: sessionId,
      data: sessionData,
    };

    next();
  } catch (error) {
    next(error);
  }
}

function persistRequestSession(req) {
  req.sfSession.data = writeSessionDataById(req.sfSession.id, req.sfSession.data);
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

function readPublicDriveConfigFile() {
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

function parseEnvList(value) {
  if (!value) return null;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getPublicDriveConfig() {
  const fileConfig = readPublicDriveConfigFile();
  const envLegacyNames = parseEnvList(process.env.DRIVE_LEGACY_FILE_NAMES);

  return {
    clientId: String(process.env.GOOGLE_CLIENT_ID || process.env.CLIENT_ID || fileConfig.clientId || '').trim(),
    fileName: String(process.env.DRIVE_FILE_NAME || fileConfig.fileName || 'sf-data.json').trim() || 'sf-data.json',
    legacyFileNames: envLegacyNames?.length ? envLegacyNames : fileConfig.legacyFileNames,
    useAppDataFolder: normalizeBoolean(process.env.DRIVE_USE_APP_DATA_FOLDER, fileConfig.useAppDataFolder),
    autoSync: normalizeBoolean(process.env.DRIVE_AUTO_SYNC, fileConfig.autoSync),
  };
}

function getRequestBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || (req.secure ? 'https' : 'http');
  const host = forwardedHost || req.get('host') || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

function getDriveServerConfig(req) {
  const publicConfig = getPublicDriveConfig();
  const oauthConfig = readJsonFile(oauthConfigPath) || {};
  const envLegacyNames = parseEnvList(process.env.DRIVE_LEGACY_FILE_NAMES);

  const clientId = String(
    process.env.GOOGLE_CLIENT_ID ||
      process.env.CLIENT_ID ||
      oauthConfig.clientId ||
      publicConfig.clientId ||
      ''
  ).trim();
  const clientSecret = String(
    process.env.GOOGLE_CLIENT_SECRET ||
      process.env.CLIENT_SECRET ||
      oauthConfig.clientSecret ||
      ''
  ).trim();
  const fileName = String(
    process.env.DRIVE_FILE_NAME ||
      oauthConfig.fileName ||
      publicConfig.fileName ||
      'sf-data.json'
  ).trim() || 'sf-data.json';
  const legacyFileNamesSource = envLegacyNames?.length
    ? envLegacyNames
    : Array.isArray(oauthConfig.legacyFileNames)
      ? oauthConfig.legacyFileNames
      : publicConfig.legacyFileNames;
  const legacyFileNames = legacyFileNamesSource
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const useAppDataFolder = normalizeBoolean(
    process.env.DRIVE_USE_APP_DATA_FOLDER,
    normalizeBoolean(
      oauthConfig.useAppDataFolder,
      normalizeBoolean(publicConfig.useAppDataFolder, true)
    )
  );
  const scope = useAppDataFolder
    ? 'https://www.googleapis.com/auth/drive.appdata'
    : 'https://www.googleapis.com/auth/drive.file';
  const configuredBaseUrl = String(
    process.env.APP_BASE_URL ||
      process.env.BASE_URL ||
      oauthConfig.baseUrl ||
      ''
  ).trim().replace(/\/+$/, '');
  const baseUrl = configuredBaseUrl || getRequestBaseUrl(req);

  return {
    configured: testClientId(clientId) && testClientSecret(clientSecret),
    clientId,
    clientSecret,
    fileName,
    legacyFileNames: legacyFileNames.length ? legacyFileNames : ['financeos-data.json'],
    useAppDataFolder,
    autoSync: publicConfig.autoSync,
    scope,
    baseUrl,
    redirectUri: `${baseUrl}/api/auth/google/callback`,
  };
}

function readOauthSession(req) {
  return req.sfSession?.data?.oauthSession || null;
}

function saveOauthSession(req, session) {
  req.sfSession.data.oauthSession = session;
  persistRequestSession(req);
}

function clearOauthSession(req) {
  req.sfSession.data.oauthSession = null;
  persistRequestSession(req);
}

function readOauthState(req) {
  return req.sfSession?.data?.oauthState || null;
}

function saveOauthState(req, state) {
  req.sfSession.data.oauthState = {
    value: state,
    createdAt: isoNow(),
  };
  persistRequestSession(req);
}

function clearOauthState(req) {
  req.sfSession.data.oauthState = null;
  persistRequestSession(req);
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

function testOauthAuthenticated(req, config) {
  if (!config.configured) return false;
  const session = readOauthSession(req);
  return Boolean(session?.refresh_token);
}

async function getValidAccessToken(req, config) {
  const session = readOauthSession(req);
  if (!session?.refresh_token) {
    throw new Error('Nenhuma sessao OAuth ativa para o Drive.');
  }

  const expiresAt = session.expires_at ? Date.parse(session.expires_at) : 0;
  if (session.access_token && Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000) {
    return String(session.access_token);
  }

  try {
    const refreshed = await refreshGoogleAccessToken(config, String(session.refresh_token));
    session.access_token = String(refreshed.access_token || '');
    session.expires_at = new Date(Date.now() + (Number(refreshed.expires_in || 3600) - 60) * 1000).toISOString();
    session.updated_at = isoNow();
    saveOauthSession(req, session);
    return String(session.access_token);
  } catch (error) {
    const message = String(error.message || error);
    if (message.toLowerCase().includes('invalid_grant')) {
      clearOauthSession(req);
    } else if (session.access_token) {
      writeDebugLog(`Falha ao renovar o token do Drive; reutilizando o token atual. Motivo: ${message}`);
      return String(session.access_token);
    }
    throw error;
  }
}

function testDriveNotFoundError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('file not found') || message.includes('notfound') || message.includes('404');
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

async function getOrFindDriveFile(req, config, accessToken) {
  const session = readOauthSession(req);
  let file = null;
  if (session?.file_id) {
    file = await getDriveFileById(accessToken, String(session.file_id));
  }
  if (!file) {
    file = await findDriveFile(config, accessToken);
  }
  return file;
}

function saveDriveFileId(req, fileId) {
  const session = readOauthSession(req);
  if (!session) return;
  session.file_id = fileId;
  session.updated_at = isoNow();
  saveOauthSession(req, session);
}

function getAuthSessionPayload(req) {
  const config = getDriveServerConfig(req);
  const session = readOauthSession(req);
  return {
    configured: Boolean(config.configured),
    authenticated: Boolean(testOauthAuthenticated(req, config)),
    fileName: config.fileName,
    useAppDataFolder: Boolean(config.useAppDataFolder),
    fileId: session?.file_id ? String(session.file_id) : '',
    baseUrl: config.baseUrl,
    redirectUri: config.redirectUri,
  };
}

function buildDriveConfigScript(req) {
  const config = getDriveServerConfig(req);
  const payload = {
    clientId: config.clientId,
    fileName: config.fileName,
    legacyFileNames: config.legacyFileNames,
    autoSync: config.autoSync,
    useAppDataFolder: config.useAppDataFolder,
  };

  return [
    `window.SF_DRIVE_CONFIG = ${JSON.stringify(payload, null, 2)};`,
    'window.FINANCEOS_DRIVE_CONFIG = window.SF_DRIVE_CONFIG;',
    '',
  ].join('\n');
}

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use('/api', attachSession);

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'sf', runtime: 'express' });
});

app.get('/drive-config.js', (req, res) => {
  res.type('application/javascript; charset=utf-8').send(buildDriveConfigScript(req));
});

app.get('/api/auth/session', (req, res) => {
  res.status(200).json(getAuthSessionPayload(req));
});

app.get('/api/auth/google/start', async (req, res) => {
  const config = getDriveServerConfig(req);
  if (!config.configured) {
    res.status(500).json({ error: 'OAuth do servidor ainda nao foi configurado. Preencha as variaveis do ambiente ou config/oauth.local.json.' });
    return;
  }

  const state = newRandomToken();
  saveOauthState(req, state);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', config.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', config.scope);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);

  res.redirect(authUrl.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  const config = getDriveServerConfig(req);
  if (!config.configured) {
    res.redirect('/?auth=error&message=oauth-config-missing');
    return;
  }

  if (req.query.error) {
    res.redirect(`/?auth=error&message=${encodeURIComponent(String(req.query.error))}`);
    return;
  }

  const savedState = readOauthState(req);
  const receivedState = String(req.query.state || '');
  const stateCreatedAt = savedState?.createdAt ? Date.parse(savedState.createdAt) : 0;
  const stateValid =
    Boolean(savedState?.value) &&
    savedState.value === receivedState &&
    Number.isFinite(stateCreatedAt) &&
    stateCreatedAt + 15 * 60_000 >= Date.now();

  if (!stateValid) {
    clearOauthState(req);
    res.redirect('/?auth=error&message=state-invalid');
    return;
  }

  const code = String(req.query.code || '');
  if (!code) {
    clearOauthState(req);
    res.redirect('/?auth=error&message=missing-code');
    return;
  }

  try {
    const tokens = await exchangeGoogleAuthCode(config, code);
    const existingSession = readOauthSession(req);
    const refreshToken = tokens.refresh_token || existingSession?.refresh_token || '';

    if (!refreshToken) {
      throw new Error('Google nao retornou refresh token. Revise o consentimento e o access_type=offline.');
    }

    saveOauthSession(req, {
      refresh_token: String(refreshToken),
      access_token: String(tokens.access_token || ''),
      expires_at: new Date(Date.now() + (Number(tokens.expires_in || 3600) - 60) * 1000).toISOString(),
      file_id: existingSession?.file_id ? String(existingSession.file_id) : '',
      scope: tokens.scope ? String(tokens.scope) : '',
      updated_at: isoNow(),
    });

    clearOauthState(req);
    res.redirect('/?auth=success');
  } catch (error) {
    clearOauthState(req);
    writeDebugLog(`Falha no callback OAuth: ${error.message}`);
    res.redirect(`/?auth=error&message=${encodeURIComponent(String(error.message || error))}`);
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearOauthSession(req);
  clearOauthState(req);
  res.status(200).json({ ok: true });
});

app.get('/api/drive/envelope', async (req, res) => {
  const config = getDriveServerConfig(req);
  if (!testOauthAuthenticated(req, config)) {
    res.status(401).json({ error: 'Nao autenticado no Google Drive.' });
    return;
  }

  try {
    const accessToken = await getValidAccessToken(req, config);
    const file = await getOrFindDriveFile(req, config, accessToken);

    if (!file?.id) {
      res.status(200).json({ fileId: '', envelope: null });
      return;
    }

    saveDriveFileId(req, String(file.id));

    try {
      const envelope = await fetchDriveEnvelope(accessToken, String(file.id));
      res.status(200).json({ fileId: String(file.id), envelope });
    } catch (error) {
      if (testDriveNotFoundError(error)) {
        saveDriveFileId(req, '');
        res.status(200).json({ fileId: '', envelope: null });
        return;
      }
      throw error;
    }
  } catch (error) {
    writeDebugLog(`Drive envelope GET falhou: ${error.message}`);
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post('/api/drive/envelope', async (req, res) => {
  const config = getDriveServerConfig(req);
  if (!testOauthAuthenticated(req, config)) {
    res.status(401).json({ error: 'Nao autenticado no Google Drive.' });
    return;
  }

  const payload = typeof req.body?.payload === 'string' ? req.body.payload : '';
  if (!payload.trim()) {
    res.status(400).json({ error: 'Payload ausente.' });
    return;
  }

  try {
    JSON.parse(payload);
  } catch {
    res.status(400).json({ error: 'Payload JSON invalido.' });
    return;
  }

  try {
    const accessToken = await getValidAccessToken(req, config);
    const file = await getOrFindDriveFile(req, config, accessToken);

    if (!file?.id) {
      const created = await createDriveFile(config, accessToken, payload);
      const createdId = String(created.id || '');
      saveDriveFileId(req, createdId);
      res.status(200).json({ fileId: createdId, status: 'created' });
      return;
    }

    const preferredFile = await ensurePreferredDriveFile(config, accessToken, file);

    try {
      const updated = await updateDriveFile(accessToken, String(preferredFile.id), payload);
      const fileId = String(updated.id || preferredFile.id || '');
      saveDriveFileId(req, fileId);
      res.status(200).json({ fileId, status: 'updated' });
    } catch (error) {
      if (!testDriveNotFoundError(error)) {
        throw error;
      }

      saveDriveFileId(req, '');
      const created = await createDriveFile(config, accessToken, payload);
      const createdId = String(created.id || '');
      saveDriveFileId(req, createdId);
      res.status(200).json({ fileId: createdId, status: 'created' });
    }
  } catch (error) {
    writeDebugLog(`Drive envelope SAVE falhou: ${error.message}`);
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.use(express.static(publicRoot, {
  index: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicRoot, defaultFile));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Rota API nao encontrada.' });
    return;
  }
  res.status(404).type('text/plain; charset=utf-8').send('Arquivo nao encontrado.');
});

app.use((error, req, res, _next) => {
  writeDebugLog(`Loop principal falhou: ${error.message}`);
  if (req.path.startsWith('/api/')) {
    res.status(500).json({ error: String(error.message || error) });
    return;
  }
  res.status(500).type('text/plain; charset=utf-8').send(String(error.message || error));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SF em http://localhost:${PORT}`);
  console.log(`Pasta servida: ${publicRoot}`);
  console.log(`Config do OAuth: ${oauthConfigPath}`);
  console.log(`Dados do OAuth: ${dataRoot}`);
  console.log('Pressione Ctrl+C para encerrar.');
});

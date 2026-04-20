#!/usr/bin/env node

const { spawn } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const serverScript = path.join(__dirname, 'server.js');
const phpApiScript = path.join(projectRoot, 'public', 'api', 'index.php');
const publicHtaccess = path.join(projectRoot, 'public', '.htaccess');
const port = 8093;

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, attempts = 20) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      return response;
    } catch (error) {
      lastError = error;
      await wait(300);
    }
  }
  throw lastError || new Error('Nao foi possivel iniciar o servidor local.');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  assert(require('node:fs').existsSync(phpApiScript), 'Arquivo de API para hospedagem nao encontrado em public/api/index.php.');
  assert(require('node:fs').existsSync(publicHtaccess), 'Arquivo .htaccess de hospedagem nao encontrado em public/.htaccess.');

  const child = spawn(process.execPath, [serverScript, '--port', String(port)], {
    cwd: projectRoot,
    stdio: 'ignore',
  });

  try {
    const root = await waitForServer(`http://localhost:${port}/`);
    const configExample = await fetch(`http://localhost:${port}/drive-config.example.js`, { cache: 'no-store' });
    const authSession = await fetch(`http://localhost:${port}/api/auth/session`, { cache: 'no-store' });

    const rootText = await root.text();
    const authText = await authSession.text();

    assert(root.status === 200, `Falha ao abrir a raiz do app. Status: ${root.status}`);
    assert(configExample.status === 200, `Falha ao abrir drive-config.example.js. Status: ${configExample.status}`);
    assert(authSession.status === 200, `Falha ao abrir /api/auth/session. Status: ${authSession.status}`);
    assert(rootText.includes('SF'), 'A pagina principal nao parece conter o app SF.');
    assert(authText.includes('"configured"'), 'A rota /api/auth/session nao retornou o payload esperado.');
    assert(authText.includes('"redirectUri"'), 'A rota /api/auth/session nao retornou o redirectUri esperado.');

    console.log('Smoke check ok.');
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

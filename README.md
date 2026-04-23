# SF com backend Express, login Google e Drive

O app principal continua em [public/index.html](/C:/Users/Ac/Documents/Finance/public/index.html), mas agora ele trabalha em dois modos:

- com backend Express em [scripts/server.js](/C:/Users/Ac/Documents/Finance/scripts/server.js), usando `authorization code` + `refresh token`;
- com fallback no navegador, usando apenas o `clientId` configurado em [public/drive-config.js](/C:/Users/Ac/Documents/Finance/public/drive-config.js), para que o login Google e a sincronizacao continuem funcionando mesmo sem `clientSecret`.
- com backend PHP em [public/api/index.php](/C:/Users/Ac/Documents/Finance/public/api/index.php), mantido apenas como opcao para hospedagem compartilhada sem Node.

Quando o `clientSecret` estiver preenchido em [config/oauth.local.json](/C:/Users/Ac/Documents/Finance/config/oauth.local.json) ou nas variaveis de ambiente do servidor, o app prioriza automaticamente o backend com refresh token. Se ele nao estiver preenchido, o app usa o fluxo direto do Google no navegador.

O backend Express agora isola o OAuth por navegador usando cookie proprio de sessao. Isso evita compartilhar uma unica conta Google entre visitantes diferentes no mesmo deploy.

## Estrutura

- [public/index.html](/C:/Users/Ac/Documents/Finance/public/index.html): interface do app
- [public/drive-config.js](/C:/Users/Ac/Documents/Finance/public/drive-config.js): configuracao publica do app e do Drive
- [public/drive-config.example.js](/C:/Users/Ac/Documents/Finance/public/drive-config.example.js): modelo da configuracao publica
- [scripts/server.js](/C:/Users/Ac/Documents/Finance/scripts/server.js): servidor Express com arquivos estaticos, OAuth e proxy do Drive
- [scripts/smoke-check.js](/C:/Users/Ac/Documents/Finance/scripts/smoke-check.js): checagem rapida do servidor Node
- [public/api/index.php](/C:/Users/Ac/Documents/Finance/public/api/index.php): backend PHP para hospedagem
- [public/.htaccess](/C:/Users/Ac/Documents/Finance/public/.htaccess): reescrita de rotas `/api/*`
- [config/oauth.local.json](/C:/Users/Ac/Documents/Finance/config/oauth.local.json): configuracao privada do backend OAuth
- [config/oauth.local.example.json](/C:/Users/Ac/Documents/Finance/config/oauth.local.example.json): modelo da configuracao privada
- [HOSTGATOR.md](/C:/Users/Ac/Documents/Finance/HOSTGATOR.md): passo a passo de deploy no HostGator

## 1. Configurar o Google Cloud

1. Ative a Google Drive API no seu projeto.
2. Configure a tela de consentimento OAuth.
3. Crie uma credencial do tipo `Web application`.
4. Em `Authorized JavaScript origins`, adicione a origem local e a origem publica do seu dominio.
5. Em `Authorized redirect URIs`, adicione o callback local e o callback publico do seu dominio.
6. Copie o `Client ID` e o `Client Secret`.

## 2. Configurar o projeto

### Configuracao publica

Em ambiente local, voce pode editar [public/drive-config.js](/C:/Users/Ac/Documents/Finance/public/drive-config.js) e confirmar o `clientId`:

```js
clientId: "SEU_CLIENT_ID.apps.googleusercontent.com"
```

### Configuracao privada

Edite [config/oauth.local.json](/C:/Users/Ac/Documents/Finance/config/oauth.local.json):

```json
{
  "clientSecret": "SEU_CLIENT_SECRET",
  "clientId": "SEU_CLIENT_ID.apps.googleusercontent.com",
  "baseUrl": "https://seudominio.com",
  "fileName": "sf-data.json",
  "legacyFileNames": ["financeos-data.json"],
  "useAppDataFolder": true
}
```

Observacoes:

- `clientSecret` e obrigatorio.
- `clientId` ja pode ser o mesmo do `public/drive-config.js`.
- `baseUrl` deve ser a URL publica final do app quando ele estiver hospedado.
- `config/oauth.local.json` esta no `.gitignore`.

### Variaveis de ambiente para Render

No Render, o caminho mais seguro e usar variaveis de ambiente em vez de salvar segredo em arquivo. O backend Express ja le:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SF_SESSION_SECRET`
- `APP_BASE_URL`
- `DRIVE_FILE_NAME`
- `DRIVE_LEGACY_FILE_NAMES`
- `DRIVE_USE_APP_DATA_FOLDER`
- `DRIVE_AUTO_SYNC`
- `SF_DATA_DIR`
- `SF_CONFIG_DIR`

Configuracao recomendada no Render:

```text
GOOGLE_CLIENT_ID=SEU_CLIENT_ID.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=SEU_CLIENT_SECRET
SF_SESSION_SECRET=um-segredo-longo-e-aleatorio
APP_BASE_URL=https://seu-app.onrender.com
DRIVE_FILE_NAME=sf-data.json
DRIVE_LEGACY_FILE_NAMES=financeos-data.json
DRIVE_USE_APP_DATA_FOLDER=true
DRIVE_AUTO_SYNC=true
SF_DATA_DIR=/var/data/sf
```

Observacoes:

- `APP_BASE_URL` precisa bater com a URL publica final do Render.
- `SF_SESSION_SECRET` deve ser um segredo forte e exclusivo do ambiente.
- `SF_DATA_DIR` deve apontar para um disco persistente se voce quiser manter a sessao OAuth entre reinicios/deploys.
- o servidor gera `GET /drive-config.js` dinamicamente, entao o front recebe o `clientId` e as flags do Drive sem rebuild manual.

## 3. Rodar localmente

```powershell
npm start
```

Depois abra:

[http://localhost:8080](http://localhost:8080)

## 4. Validacao rapida

```powershell
npm run smoke
```

Esse smoke test valida:

- `/`
- `/health`
- `/drive-config.js`
- `/api/auth/session`

## 5. Como o login funciona agora

1. Voce abre o app e clica em `entrar`.
2. Se houver `clientSecret`, o app usa o backend local.
3. O Google devolve um `authorization code` para `http://localhost:8080/api/auth/google/callback`.
4. O backend troca esse codigo por `access token` e `refresh token`.
5. O backend guarda o estado OAuth dentro da sessao do navegador, em vez de compartilhar uma sessao global para todo mundo.
6. O `refresh token` fica salvo na area de dados do servidor, isolado por sessao.
7. O front passa a sincronizar pelos endpoints locais `/api/auth/session` e `/api/drive/envelope`.
8. Se o `clientSecret` ainda nao existir, o app cai automaticamente no login Google direto no navegador usando o `clientId`.

## 6. Deploy no HostGator

Use o backend PHP em [public/api/index.php](/C:/Users/Ac/Documents/Finance/public/api/index.php). O resumo do deploy e:

1. subir o conteudo de [public](/C:/Users/Ac/Documents/Finance/public) para `public_html`
2. manter [config/oauth.local.json](/C:/Users/Ac/Documents/Finance/config/oauth.local.json) fora da pasta publica
3. garantir permissao de escrita para a pasta `data/` fora do `public_html`
4. ajustar `baseUrl` com a URL real do dominio
5. registrar no Google Cloud a URL `https://SEU_DOMINIO/api/auth/google/callback`

Se o app ficar em subpasta, a URL de callback muda junto. O passo a passo completo ficou em [HOSTGATOR.md](/C:/Users/Ac/Documents/Finance/HOSTGATOR.md).

Se voce quiser rodar o mesmo backend Node.js em producao, o hosting precisa aceitar processo Node persistente. Em hospedagem compartilhada comum da HostGator, o caminho mais seguro continua sendo o adapter PHP.

## 7. Deploy no Render

O backend Express foi preparado para esse cenario. No Render:

1. crie um `Web Service` Node
2. use `npm install` no build command
3. use `npm start` no start command
4. configure as variaveis de ambiente listadas acima
5. se quiser manter a sessao OAuth mesmo apos restart/deploy, anexe um disco persistente e aponte `SF_DATA_DIR` para ele
6. no Google Cloud, registre:

- `Authorized JavaScript origins`: `https://SEU_APP.onrender.com`
- `Authorized redirect URIs`: `https://SEU_APP.onrender.com/api/auth/google/callback`

Rotas uteis para conferir no Render:

- `/health`
- `/api/auth/session`

O `redirectUri` retornado por `/api/auth/session` precisa bater exatamente com o cadastro do Google Cloud.

## 8. Sincronizacao

- o app continua usando `localStorage` como cache local;
- o Drive continua usando `sf-data.json` como arquivo principal;
- backups antigos `financeos-data.json` ainda sao encontrados e promovidos quando necessario;
- se local e nuvem divergem, o app compara `updatedAt` antes de escolher a versao mais recente;
- em caso de conflito, a versao perdedora fica salva no backup local de conflito.

## 9. Observacoes

- com `useAppDataFolder: true`, o arquivo fica salvo na area privada do app no Google Drive;
- a pasta `data/` tambem esta no `.gitignore`, porque nela o servidor guarda estado OAuth local;
- no Render sem disco persistente, o token salvo pode ser perdido quando a instancia reiniciar;
- em producao, use sempre `SF_SESSION_SECRET` e disco persistente se quiser manter as sessoes OAuth entre reinicios;
- o botao de nuvem agora tambem serve para sair da conta e limpar a sessao local;
- com apenas `clientId`, o login funciona, mas a renovacao silenciosa total do token depende do fluxo com `clientSecret` no backend.

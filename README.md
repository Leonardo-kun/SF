# SF com login Google, Drive e deploy em hospedagem

O app principal continua em [public/index.html](/C:/Users/Ac/Documents/Finance/public/index.html), mas agora ele trabalha em dois modos:

- com backend OAuth em [scripts/server.ps1](/C:/Users/Ac/Documents/Finance/scripts/server.ps1), usando `authorization code` + `refresh token`;
- com fallback no navegador, usando apenas o `clientId` configurado em [public/drive-config.js](/C:/Users/Ac/Documents/Finance/public/drive-config.js), para que o login Google e a sincronizacao continuem funcionando mesmo sem `clientSecret`.
- com backend PHP em [public/api/index.php](/C:/Users/Ac/Documents/Finance/public/api/index.php), pronto para hospedagem compartilhada como HostGator.

Quando o `clientSecret` estiver preenchido em [config/oauth.local.json](/C:/Users/Ac/Documents/Finance/config/oauth.local.json), o app prioriza automaticamente o backend com refresh token. Se ele nao estiver preenchido, o app usa o fluxo direto do Google no navegador.

## Estrutura

- [public/index.html](/C:/Users/Ac/Documents/Finance/public/index.html): interface do app
- [public/drive-config.js](/C:/Users/Ac/Documents/Finance/public/drive-config.js): configuracao publica do app e do Drive
- [public/drive-config.example.js](/C:/Users/Ac/Documents/Finance/public/drive-config.example.js): modelo da configuracao publica
- [public/api/index.php](/C:/Users/Ac/Documents/Finance/public/api/index.php): backend PHP para hospedagem
- [public/.htaccess](/C:/Users/Ac/Documents/Finance/public/.htaccess): reescrita de rotas `/api/*`
- [config/oauth.local.json](/C:/Users/Ac/Documents/Finance/config/oauth.local.json): configuracao privada do backend OAuth
- [config/oauth.local.example.json](/C:/Users/Ac/Documents/Finance/config/oauth.local.example.json): modelo da configuracao privada
- [scripts/server.ps1](/C:/Users/Ac/Documents/Finance/scripts/server.ps1): servidor local com arquivos estaticos, OAuth e proxy do Drive
- [scripts/smoke-check.ps1](/C:/Users/Ac/Documents/Finance/scripts/smoke-check.ps1): checagem rapida do servidor e das rotas principais
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

Edite [public/drive-config.js](/C:/Users/Ac/Documents/Finance/public/drive-config.js) e confirme o `clientId`:

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

## 3. Rodar localmente

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\server.ps1
```

Ou, se voce tiver Node/npm instalado:

```powershell
npm start
```

Depois abra:

[http://localhost:8080](http://localhost:8080)

## 4. Validacao rapida

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\smoke-check.ps1
```

Ou:

```powershell
npm run smoke
```

## 5. Como o login funciona agora

1. Voce abre o app e clica em `entrar`.
2. Se houver `clientSecret`, o app usa o backend local.
3. O Google devolve um `authorization code` para `http://localhost:8080/api/auth/google/callback`.
4. O backend troca esse codigo por `access token` e `refresh token`.
5. O `refresh token` fica salvo em `data/oauth-session.json` no seu computador.
6. O front passa a sincronizar pelos endpoints locais `/api/auth/session` e `/api/drive/envelope`.
7. Se o `clientSecret` ainda nao existir, o app cai automaticamente no login Google direto no navegador usando o `clientId`.

## 6. Deploy no HostGator

Use o backend PHP em [public/api/index.php](/C:/Users/Ac/Documents/Finance/public/api/index.php). O resumo do deploy e:

1. subir o conteudo de [public](/C:/Users/Ac/Documents/Finance/public) para `public_html`
2. manter [config/oauth.local.json](/C:/Users/Ac/Documents/Finance/config/oauth.local.json) fora da pasta publica
3. garantir permissao de escrita para a pasta `data/` fora do `public_html`
4. ajustar `baseUrl` com a URL real do dominio
5. registrar no Google Cloud a URL `https://SEU_DOMINIO/api/auth/google/callback`

Se o app ficar em subpasta, a URL de callback muda junto. O passo a passo completo ficou em [HOSTGATOR.md](/C:/Users/Ac/Documents/Finance/HOSTGATOR.md).

## 7. Sincronizacao

- o app continua usando `localStorage` como cache local;
- o Drive continua usando `sf-data.json` como arquivo principal;
- backups antigos `financeos-data.json` ainda sao encontrados e promovidos quando necessario;
- se local e nuvem divergem, o app compara `updatedAt` antes de escolher a versao mais recente;
- em caso de conflito, a versao perdedora fica salva no backup local de conflito.

## 8. Observacoes

- com `useAppDataFolder: true`, o arquivo fica salvo na area privada do app no Google Drive;
- a pasta `data/` tambem esta no `.gitignore`, porque nela o servidor guarda estado OAuth local;
- o botao de nuvem agora tambem serve para sair da conta e limpar a sessao local;
- com apenas `clientId`, o login funciona, mas a renovacao silenciosa total do token depende do fluxo com `clientSecret` no backend.

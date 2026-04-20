# Deploy no HostGator

O projeto agora esta pronto para hospedagem compartilhada com PHP, sem depender do backend em PowerShell.

## O que foi preparado

- [public/api/index.php](/C:/Users/Ac/Documents/Finance/public/api/index.php): backend OAuth + Drive em PHP
- [public/.htaccess](/C:/Users/Ac/Documents/Finance/public/.htaccess): reescrita das rotas `/api/*`
- [public/index.html](/C:/Users/Ac/Documents/Finance/public/index.html): front ajustado para usar rotas relativas
- [config/oauth.local.example.json](/C:/Users/Ac/Documents/Finance/config/oauth.local.example.json): configuracao com `baseUrl`

## Estrutura recomendada no HostGator

Suba os arquivos assim:

- conteudo da pasta [public](/C:/Users/Ac/Documents/Finance/public) para `public_html/`
- pasta [config](/C:/Users/Ac/Documents/Finance/config) para a mesma raiz acima de `public_html`

Exemplo:

```text
/home/SEU_USUARIO/
  config/
    oauth.local.json
  data/
    oauth-session.json
    oauth-state.json
  public_html/
    index.html
    drive-config.js
    .htaccess
    api/
      index.php
```

Observacao:

- a pasta `data/` pode ser criada automaticamente pelo app, mas o usuario da hospedagem precisa ter permissao de escrita nessa area

## Configuracao do oauth.local.json

Edite [config/oauth.local.json](/C:/Users/Ac/Documents/Finance/config/oauth.local.json) e ajuste:

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

Se o app ficar em subpasta, use a URL completa da subpasta:

```json
"baseUrl": "https://seudominio.com/sf"
```

## O que registrar no Google Cloud

Se o app estiver em `https://seudominio.com`:

- `Authorized JavaScript origins`: `https://seudominio.com`
- `Authorized redirect URIs`: `https://seudominio.com/api/auth/google/callback`

Se o app estiver em `https://seudominio.com/sf`:

- `Authorized JavaScript origins`: `https://seudominio.com`
- `Authorized redirect URIs`: `https://seudominio.com/sf/api/auth/google/callback`

## Como conferir a URL exata do redirect

Depois do upload, abra:

- `https://SEU_DOMINIO/api/auth/session`

ou, se estiver em subpasta:

- `https://SEU_DOMINIO/SUA_PASTA/api/auth/session`

Esse endpoint agora devolve um campo `redirectUri`. O valor dele precisa bater exatamente com o que estiver cadastrado no Google Cloud.

## Requisitos da hospedagem

- PHP com extensao `curl`
- PHP 8.0 ou superior
- HTTPS ativo no dominio
- `mod_rewrite` habilitado
- permissao de escrita na pasta `data/` fora do `public_html`

## Observacoes

- o backend em [scripts/server.ps1](/C:/Users/Ac/Documents/Finance/scripts/server.ps1) continua valendo para desenvolvimento local
- no HostGator, quem atende o OAuth e o Drive passa a ser [public/api/index.php](/C:/Users/Ac/Documents/Finance/public/api/index.php)

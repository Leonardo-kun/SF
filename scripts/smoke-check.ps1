param(
  [int]$Port = 8093
)

$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverScript = Join-Path $PSScriptRoot 'server.ps1'
$phpApiScript = Join-Path $projectRoot 'public\api\index.php'
$publicHtaccess = Join-Path $projectRoot 'public\.htaccess'

if (-not (Test-Path -LiteralPath $phpApiScript -PathType Leaf)) {
  throw 'Arquivo de API para hospedagem nao encontrado em public/api/index.php.'
}

if (-not (Test-Path -LiteralPath $publicHtaccess -PathType Leaf)) {
  throw 'Arquivo .htaccess de hospedagem nao encontrado em public/.htaccess.'
}

$proc = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$serverScript,'-Port',$Port -PassThru

try {
  Start-Sleep -Seconds 2

  $root = Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing
  $configExample = Invoke-WebRequest -Uri "http://localhost:$Port/drive-config.example.js" -UseBasicParsing
  $authSession = Invoke-WebRequest -Uri "http://localhost:$Port/api/auth/session" -UseBasicParsing

  if ($root.StatusCode -ne 200) {
    throw "Falha ao abrir a raiz do app. Status: $($root.StatusCode)"
  }

  if ($configExample.StatusCode -ne 200) {
    throw "Falha ao abrir drive-config.example.js. Status: $($configExample.StatusCode)"
  }

  if ($authSession.StatusCode -ne 200) {
    throw "Falha ao abrir /api/auth/session. Status: $($authSession.StatusCode)"
  }

  if ($root.Content -notmatch 'SF') {
    throw 'A pagina principal nao parece conter o app SF.'
  }

  if ($authSession.Content -notmatch '"configured"') {
    throw 'A rota /api/auth/session nao retornou o payload esperado.'
  }

  if ($authSession.Content -notmatch '"redirectUri"') {
    throw 'A rota /api/auth/session nao retornou o redirectUri esperado.'
  }

  Write-Host 'Smoke check ok.'
}
finally {
  if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
    Stop-Process -Id $proc.Id -Force
  }
}

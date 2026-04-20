param(
  [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
[System.Net.ServicePointManager]::Expect100Continue = $false

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$publicRoot = Join-Path $projectRoot 'public'
$configRoot = Join-Path $projectRoot 'config'
$dataRoot = Join-Path $projectRoot 'data'
$oauthConfigPath = Join-Path $configRoot 'oauth.local.json'
$publicDriveConfigPath = Join-Path $publicRoot 'drive-config.js'
$oauthStatePath = Join-Path $dataRoot 'oauth-state.json'
$oauthSessionPath = Join-Path $dataRoot 'oauth-session.json'
$debugLogPath = Join-Path $dataRoot 'server-debug.log'
$defaultFile = 'index.html'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

New-Item -ItemType Directory -Force -Path $configRoot | Out-Null
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null

function Get-ContentType {
  param([string]$Path)
  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    '.html' { 'text/html; charset=utf-8' }
    '.js' { 'application/javascript; charset=utf-8' }
    '.json' { 'application/json; charset=utf-8' }
    '.css' { 'text/css; charset=utf-8' }
    '.svg' { 'image/svg+xml' }
    '.png' { 'image/png' }
    '.jpg' { 'image/jpeg' }
    '.jpeg' { 'image/jpeg' }
    default { 'application/octet-stream' }
  }
}

function Resolve-RequestPath {
  param([string]$RequestTarget)
  $pathOnly = ($RequestTarget -split '\?')[0]
  $relativePath = if ([string]::IsNullOrWhiteSpace($pathOnly) -or $pathOnly -eq '/') { $defaultFile } else { [System.Uri]::UnescapeDataString($pathOnly.TrimStart('/')) }
  $candidatePath = Join-Path $publicRoot $relativePath
  $fullPath = [System.IO.Path]::GetFullPath($candidatePath)
  $workspaceRoot = [System.IO.Path]::GetFullPath($publicRoot)
  if (-not $fullPath.StartsWith($workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
  return $fullPath
}

function Write-Response {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    [string]$ContentType,
    [byte[]]$BodyBytes,
    [bool]$IsHead,
    [hashtable]$Headers = @{}
  )
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("HTTP/1.1 $StatusCode $StatusText")
  $lines.Add('Connection: close')
  $lines.Add('Cache-Control: no-store')
  if ($ContentType) { $lines.Add("Content-Type: $ContentType") }
  foreach ($entry in $Headers.GetEnumerator()) { $lines.Add("$($entry.Key): $($entry.Value)") }
  $lines.Add("Content-Length: $(if($BodyBytes){$BodyBytes.Length}else{0})")
  $lines.Add('')
  $lines.Add('')
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes(($lines -join "`r`n"))
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if (-not $IsHead -and $BodyBytes -and $BodyBytes.Length -gt 0) { $Stream.Write($BodyBytes, 0, $BodyBytes.Length) }
}

function Write-TextResponse {
  param([System.Net.Sockets.NetworkStream]$Stream,[int]$StatusCode,[string]$StatusText,[string]$Content,[bool]$IsHead,[hashtable]$Headers = @{})
  Write-Response -Stream $Stream -StatusCode $StatusCode -StatusText $StatusText -ContentType 'text/plain; charset=utf-8' -BodyBytes $utf8NoBom.GetBytes($Content) -IsHead $IsHead -Headers $Headers
}

function Write-JsonResponse {
  param([System.Net.Sockets.NetworkStream]$Stream,[int]$StatusCode,[object]$Payload,[bool]$IsHead)
  Write-Response -Stream $Stream -StatusCode $StatusCode -StatusText 'OK' -ContentType 'application/json; charset=utf-8' -BodyBytes $utf8NoBom.GetBytes(($Payload | ConvertTo-Json -Depth 20 -Compress)) -IsHead $IsHead
}

function Write-RedirectResponse {
  param([System.Net.Sockets.NetworkStream]$Stream,[string]$Location,[bool]$IsHead)
  Write-Response -Stream $Stream -StatusCode 302 -StatusText 'Found' -ContentType 'text/plain; charset=utf-8' -BodyBytes $utf8NoBom.GetBytes('Redirecting...') -IsHead $IsHead -Headers @{ Location = $Location }
}

function Read-RequestBody {
  param([System.IO.StreamReader]$Reader,[int]$ContentLength)
  if ($ContentLength -le 0) { return '' }
  $buffer = New-Object char[] $ContentLength
  $offset = 0
  while ($offset -lt $ContentLength) {
    $read = $Reader.Read($buffer, $offset, $ContentLength - $offset)
    if ($read -le 0) { break }
    $offset += $read
  }
  if ($offset -gt 0) { return (-join $buffer[0..($offset - 1)]) }
  return ''
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $raw = [System.IO.File]::ReadAllText($Path, $utf8NoBom)
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return $raw | ConvertFrom-Json
}

function Write-JsonFile {
  param([string]$Path,[object]$Value)
  $directory = Split-Path -Parent $Path
  if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
  [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20), $utf8NoBom)
}

function Remove-FileIfExists { param([string]$Path) if (Test-Path -LiteralPath $Path -PathType Leaf) { Remove-Item -LiteralPath $Path -Force } }

function Write-DebugLog {
  param([string]$Message)
  $timestamp = [DateTimeOffset]::UtcNow.ToString('o')
  [System.IO.File]::AppendAllText($debugLogPath, "[$timestamp] $Message`r`n", $utf8NoBom)
}

function Decode-FormValue { param([string]$Value) if ($null -eq $Value) { return '' } return [System.Uri]::UnescapeDataString(($Value -replace '\+', ' ')) }

function Parse-FormEncoded {
  param([string]$InputText)
  $result = @{}
  if ([string]::IsNullOrWhiteSpace($InputText)) { return $result }
  foreach ($pair in $InputText.Split('&', [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $parts = $pair.Split('=', 2)
    $key = Decode-FormValue $parts[0]
    $value = if ($parts.Length -gt 1) { Decode-FormValue $parts[1] } else { '' }
    $result[$key] = $value
  }
  return $result
}

function Parse-RequestTarget {
  param([string]$RequestTarget)
  $uri = [System.Uri]::new("http://localhost$RequestTarget")
  return [ordered]@{ Path = $uri.AbsolutePath; Query = Parse-FormEncoded $uri.Query.TrimStart('?') }
}

function ConvertTo-BooleanOrDefault {
  param([object]$Value,[bool]$Default)
  if ($null -eq $Value) { return $Default }
  if ($Value -is [bool]) { return $Value }
  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) { return $Default }
  return $text.ToLowerInvariant() -eq 'true'
}

function Test-ClientId {
  param([string]$ClientId)
  return (-not [string]::IsNullOrWhiteSpace($ClientId) -and $ClientId.EndsWith('.apps.googleusercontent.com') -and -not $ClientId.Contains('COLOQUE') -and -not $ClientId.Contains('SEU_CLIENT_ID'))
}

function Test-ClientSecret {
  param([string]$ClientSecret)
  return (-not [string]::IsNullOrWhiteSpace($ClientSecret) -and -not $ClientSecret.Contains('COLOQUE') -and -not $ClientSecret.Contains('SEU_CLIENT_SECRET'))
}

function Get-PublicDriveConfig {
  $defaults = [ordered]@{
    ClientId = ''
    FileName = 'sf-data.json'
    LegacyFileNames = @('financeos-data.json')
    UseAppDataFolder = $true
    AutoSync = $true
  }
  if (-not (Test-Path -LiteralPath $publicDriveConfigPath -PathType Leaf)) { return $defaults }
  $content = [System.IO.File]::ReadAllText($publicDriveConfigPath, $utf8NoBom)
  $clientIdMatch = [regex]::Match($content, 'clientId\s*:\s*"([^"]*)"')
  if ($clientIdMatch.Success) { $defaults.ClientId = $clientIdMatch.Groups[1].Value }
  $fileNameMatch = [regex]::Match($content, 'fileName\s*:\s*"([^"]*)"')
  if ($fileNameMatch.Success) { $defaults.FileName = $fileNameMatch.Groups[1].Value }
  $legacyMatch = [regex]::Match($content, 'legacyFileNames\s*:\s*\[(.*?)\]', [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if ($legacyMatch.Success) {
    $legacyNames = [regex]::Matches($legacyMatch.Groups[1].Value, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
    if ($legacyNames.Count -gt 0) { $defaults.LegacyFileNames = @($legacyNames) }
  }
  $appDataMatch = [regex]::Match($content, 'useAppDataFolder\s*:\s*(true|false)')
  if ($appDataMatch.Success) { $defaults.UseAppDataFolder = $appDataMatch.Groups[1].Value -eq 'true' }
  $autoSyncMatch = [regex]::Match($content, 'autoSync\s*:\s*(true|false)')
  if ($autoSyncMatch.Success) { $defaults.AutoSync = $autoSyncMatch.Groups[1].Value -eq 'true' }
  return $defaults
}

function Get-DriveServerConfig {
  $publicConfig = Get-PublicDriveConfig
  $oauthConfig = Read-JsonFile $oauthConfigPath
  $clientId = if ($oauthConfig -and $oauthConfig.clientId) { [string]$oauthConfig.clientId } else { [string]$publicConfig.ClientId }
  $clientSecret = if ($oauthConfig -and $oauthConfig.clientSecret) { [string]$oauthConfig.clientSecret } else { '' }
  $fileName = if ($oauthConfig -and $oauthConfig.fileName) { [string]$oauthConfig.fileName } else { [string]$publicConfig.FileName }
  $legacyFileNames = if ($oauthConfig -and $oauthConfig.legacyFileNames) { @($oauthConfig.legacyFileNames | ForEach-Object { [string]$_ }) } else { @($publicConfig.LegacyFileNames) }
  if ($legacyFileNames.Count -eq 0) { $legacyFileNames = @('financeos-data.json') }
  $useAppDataFolder = if ($oauthConfig -and $null -ne $oauthConfig.useAppDataFolder) { ConvertTo-BooleanOrDefault -Value $oauthConfig.useAppDataFolder -Default $true } else { [bool]$publicConfig.UseAppDataFolder }
  $baseUrl = if ($oauthConfig -and $oauthConfig.baseUrl -and -not [string]::IsNullOrWhiteSpace([string]$oauthConfig.baseUrl)) { ([string]$oauthConfig.baseUrl).TrimEnd('/') } else { "http://localhost:$Port" }
  $configured = (Test-ClientId $clientId) -and (Test-ClientSecret $clientSecret)
  $scope = if ($useAppDataFolder) { 'https://www.googleapis.com/auth/drive.appdata' } else { 'https://www.googleapis.com/auth/drive.file' }
  return [ordered]@{
    Configured = $configured
    ClientId = $clientId
    ClientSecret = $clientSecret
    FileName = $fileName
    LegacyFileNames = @($legacyFileNames | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    UseAppDataFolder = $useAppDataFolder
    Scope = $scope
    BaseUrl = $baseUrl
    RedirectUri = "$baseUrl/api/auth/google/callback"
  }
}

function Read-OAuthSession { Read-JsonFile $oauthSessionPath }
function Save-OAuthSession { param([object]$Session) Write-JsonFile -Path $oauthSessionPath -Value $Session }
function Clear-OAuthSession { Remove-FileIfExists $oauthSessionPath }
function Read-OAuthState { Read-JsonFile $oauthStatePath }
function Save-OAuthState { param([string]$State) Write-JsonFile -Path $oauthStatePath -Value ([ordered]@{ value = $State; createdAt = ([DateTimeOffset]::UtcNow.ToString('o')) }) }
function Clear-OAuthState { Remove-FileIfExists $oauthStatePath }

function New-RandomToken {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertTo-QueryString {
  param([hashtable]$Parameters)
  $pairs = foreach ($entry in $Parameters.GetEnumerator()) {
    if ($null -eq $entry.Value) { continue }
    '{0}={1}' -f [System.Uri]::EscapeDataString([string]$entry.Key), [System.Uri]::EscapeDataString([string]$entry.Value)
  }
  return ($pairs -join '&')
}

function Get-WebErrorMessage {
  param([System.Management.Automation.ErrorRecord]$ErrorRecord)
  $message = $ErrorRecord.Exception.Message
  $response = $ErrorRecord.Exception.Response
  if ($response) {
    try {
      $stream = $response.GetResponseStream()
      if ($stream) {
        $reader = [System.IO.StreamReader]::new($stream)
        try {
          $raw = $reader.ReadToEnd()
          if (-not [string]::IsNullOrWhiteSpace($raw)) { return $raw }
        }
        finally { $reader.Dispose() }
      }
    }
    catch { return $message }
  }
  return $message
}

function Invoke-FormRequest {
  param([string]$Method,[string]$Uri,[hashtable]$Body)
  try {
    $response = Invoke-WebRequest -Method $Method -Uri $Uri -Body $Body -ContentType 'application/x-www-form-urlencoded' -UseBasicParsing
    if ([string]::IsNullOrWhiteSpace($response.Content)) { return @{} }
    return ($response.Content | ConvertFrom-Json)
  }
  catch { throw (Get-WebErrorMessage $_) }
}

function Invoke-GoogleRequest {
  param(
    [string]$Method,
    [string]$Uri,
    [string]$AccessToken,
    [object]$Body = $null,
    [string]$ContentType = '',
    [hashtable]$ExtraHeaders = @{}
  )
  $headers = @{ Authorization = "Bearer $AccessToken" }
  foreach ($entry in $ExtraHeaders.GetEnumerator()) {
    $headers[$entry.Key] = $entry.Value
  }
  try {
    if ($null -eq $Body) {
      $response = Invoke-WebRequest -Method $Method -Uri $Uri -Headers $headers -UseBasicParsing
    }
    elseif ([string]::IsNullOrWhiteSpace($ContentType)) {
      $response = Invoke-WebRequest -Method $Method -Uri $Uri -Headers $headers -Body $Body -UseBasicParsing
    }
    else {
      $response = Invoke-WebRequest -Method $Method -Uri $Uri -Headers $headers -Body $Body -ContentType $ContentType -UseBasicParsing
    }

    if ([string]::IsNullOrWhiteSpace($response.Content)) { return @{} }
    return ($response.Content | ConvertFrom-Json)
  }
  catch { throw (Get-WebErrorMessage $_) }
}

function Exchange-GoogleAuthCode {
  param([hashtable]$Config,[string]$Code)
  return Invoke-FormRequest -Method 'Post' -Uri 'https://oauth2.googleapis.com/token' -Body @{
    code = $Code
    client_id = $Config.ClientId
    client_secret = $Config.ClientSecret
    redirect_uri = $Config.RedirectUri
    grant_type = 'authorization_code'
  }
}

function Refresh-GoogleAccessToken {
  param([hashtable]$Config,[string]$RefreshToken)
  return Invoke-FormRequest -Method 'Post' -Uri 'https://oauth2.googleapis.com/token' -Body @{
    client_id = $Config.ClientId
    client_secret = $Config.ClientSecret
    refresh_token = $RefreshToken
    grant_type = 'refresh_token'
  }
}

function Test-OAuthAuthenticated {
  param([hashtable]$Config)
  if (-not $Config.Configured) { return $false }
  $session = Read-OAuthSession
  return ($session -and -not [string]::IsNullOrWhiteSpace([string]$session.refresh_token))
}

function Get-ValidAccessToken {
  param([hashtable]$Config)
  $session = Read-OAuthSession
  if (-not $session -or [string]::IsNullOrWhiteSpace([string]$session.refresh_token)) { throw 'Nenhuma sessao OAuth ativa para o Drive.' }
  $expiresAt = 0
  if ($session.expires_at) {
    try { $expiresAt = [DateTimeOffset]::Parse([string]$session.expires_at).ToUnixTimeSeconds() } catch { $expiresAt = 0 }
  }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  if (-not [string]::IsNullOrWhiteSpace([string]$session.access_token) -and $expiresAt -gt ($now + 60)) { return [string]$session.access_token }
  try {
    $refreshed = Refresh-GoogleAccessToken -Config $Config -RefreshToken ([string]$session.refresh_token)
  }
  catch {
    $refreshError = [string]$_.Exception.Message
    if ($refreshError.ToLowerInvariant().Contains('invalid_grant')) {
      Clear-OAuthSession
    }
    elseif (-not [string]::IsNullOrWhiteSpace([string]$session.access_token)) {
      Write-DebugLog "Falha ao renovar o token do Drive; reutilizando o access token atual. Motivo: $refreshError"
      return [string]$session.access_token
    }
    throw $_
  }
  $session.access_token = [string]$refreshed.access_token
  $session.expires_at = ([DateTimeOffset]::UtcNow.AddSeconds([int]$refreshed.expires_in - 60).ToString('o'))
  $session.updated_at = ([DateTimeOffset]::UtcNow.ToString('o'))
  Save-OAuthSession $session
  return [string]$session.access_token
}

function Escape-DriveQueryValue { param([string]$Value) return ([string]$Value).Replace('\', '\\').Replace("'", "\'") }

function Build-DriveSearchUrl {
  param([hashtable]$Config,[string]$FileName)
  $baseQuery = "name='$(Escape-DriveQueryValue $FileName)' and trashed=false"
  if ($Config.UseAppDataFolder) { $spaces = 'appDataFolder'; $query = "$baseQuery and 'appDataFolder' in parents" } else { $spaces = 'drive'; $query = $baseQuery }
  return 'https://www.googleapis.com/drive/v3/files?' + (ConvertTo-QueryString @{ fields = 'files(id,name,modifiedTime)'; pageSize = '1'; spaces = $spaces; q = $query; orderBy = 'modifiedTime desc' })
}

function Get-DriveFileById {
  param([string]$AccessToken,[string]$FileId)
  if ([string]::IsNullOrWhiteSpace($FileId)) { return $null }
  try { return Invoke-GoogleRequest -Method 'Get' -Uri "https://www.googleapis.com/drive/v3/files/${FileId}?fields=id,name,modifiedTime" -AccessToken $AccessToken }
  catch { return $null }
}

function Find-DriveFile {
  param([hashtable]$Config,[string]$AccessToken)
  $candidateNames = @($Config.FileName) + @($Config.LegacyFileNames | Where-Object { $_ -and $_ -ne $Config.FileName })
  foreach ($candidateName in $candidateNames) {
    $payload = Invoke-GoogleRequest -Method 'Get' -Uri (Build-DriveSearchUrl -Config $Config -FileName $candidateName) -AccessToken $AccessToken
    $file = if ($payload.files) { $payload.files[0] } else { $null }
    if ($file) { return [ordered]@{ id = [string]$file.id; name = [string]$file.name; isLegacy = ([string]$candidateName -ne [string]$Config.FileName) } }
  }
  return $null
}

function Rename-DriveFile {
  param([string]$AccessToken,[string]$FileId,[string]$FileName)
  return Invoke-GoogleRequest `
    -Method 'Post' `
    -Uri "https://www.googleapis.com/drive/v3/files/${FileId}" `
    -AccessToken $AccessToken `
    -Body (@{ name = $FileName } | ConvertTo-Json -Compress) `
    -ContentType 'application/json; charset=utf-8' `
    -ExtraHeaders @{ 'X-HTTP-Method-Override' = 'PATCH' }
}

function Ensure-PreferredDriveFile {
  param([hashtable]$Config,[string]$AccessToken,[object]$File)
  if (-not $File -or -not $File.id) { return $File }
  if ([string]$File.name -eq [string]$Config.FileName) { return $File }
  if (-not ($Config.LegacyFileNames -contains [string]$File.name)) { return $File }
  try {
    $renamed = Rename-DriveFile -AccessToken $AccessToken -FileId ([string]$File.id) -FileName $Config.FileName
    return [ordered]@{ id = [string]$File.id; name = if ($renamed.name) { [string]$renamed.name } else { [string]$Config.FileName }; isLegacy = $false }
  }
  catch {
    Write-DebugLog "Nao foi possivel promover o backup legado para o nome novo: $($_.Exception.Message)"
    return $File
  }
}

function Fetch-DriveEnvelope { param([string]$AccessToken,[string]$FileId) return Invoke-GoogleRequest -Method 'Get' -Uri "https://www.googleapis.com/drive/v3/files/${FileId}?alt=media" -AccessToken $AccessToken }

function Create-DriveFile {
  param([hashtable]$Config,[string]$AccessToken,[string]$EnvelopeJson)
  $boundary = 'sf-' + ([Guid]::NewGuid().ToString('N'))
  $metadata = [ordered]@{ name = $Config.FileName }
  if ($Config.UseAppDataFolder) { $metadata.parents = @('appDataFolder') }
  $body = "--$boundary`r`nContent-Type: application/json; charset=UTF-8`r`n`r`n$($metadata | ConvertTo-Json -Compress)`r`n--$boundary`r`nContent-Type: application/json; charset=UTF-8`r`n`r`n$EnvelopeJson`r`n--$boundary--"
  return Invoke-GoogleRequest -Method 'Post' -Uri 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart' -AccessToken $AccessToken -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType "multipart/related; boundary=$boundary"
}

function Update-DriveFile {
  param([string]$AccessToken,[string]$FileId,[string]$EnvelopeJson)
  return Invoke-GoogleRequest `
    -Method 'Post' `
    -Uri "https://www.googleapis.com/upload/drive/v3/files/${FileId}?uploadType=media" `
    -AccessToken $AccessToken `
    -Body $EnvelopeJson `
    -ContentType 'application/json; charset=utf-8' `
    -ExtraHeaders @{ 'X-HTTP-Method-Override' = 'PATCH' }
}

function Get-OrFindDriveFile {
  param([hashtable]$Config,[string]$AccessToken)
  $session = Read-OAuthSession
  $file = $null
  if ($session -and $session.file_id) { $file = Get-DriveFileById -AccessToken $AccessToken -FileId ([string]$session.file_id) }
  if (-not $file) { $file = Find-DriveFile -Config $Config -AccessToken $AccessToken }
  return $file
}

function Save-DriveFileId {
  param([string]$FileId)
  $session = Read-OAuthSession
  if (-not $session) { return }
  $session.file_id = $FileId
  $session.updated_at = ([DateTimeOffset]::UtcNow.ToString('o'))
  Save-OAuthSession $session
}

function Test-DriveNotFoundError {
  param([string]$Message)
  if ([string]::IsNullOrWhiteSpace($Message)) { return $false }
  $normalized = $Message.ToLowerInvariant()
  return $normalized.Contains('file not found') -or $normalized.Contains('=media') -or $normalized.Contains('notfound')
}

function Test-DriveTransportFallbackError {
  param([string]$Message)
  if ([string]::IsNullOrWhiteSpace($Message)) { return $false }
  $normalized = $Message.ToLowerInvariant()
  return (
    $normalized.Contains('conexao subjacente estava fechada') -or
    $normalized.Contains('erro inesperado em um recebimento') -or
    $normalized.Contains('erro ao enviar a solicitacao') -or
    $normalized.Contains('credenciais nao disponiveis no pacote de seguranca')
  )
}

function Get-AuthSessionPayload {
  $config = Get-DriveServerConfig
  $session = Read-OAuthSession
  return [ordered]@{
    configured = [bool]$config.Configured
    authenticated = [bool](Test-OAuthAuthenticated -Config $config)
    fileName = [string]$config.FileName
    useAppDataFolder = [bool]$config.UseAppDataFolder
    fileId = if ($session -and $session.file_id) { [string]$session.file_id } else { '' }
    baseUrl = [string]$config.BaseUrl
    redirectUri = [string]$config.RedirectUri
  }
}

function Handle-AuthStart {
  param([System.Net.Sockets.NetworkStream]$Stream,[bool]$IsHead)
  $config = Get-DriveServerConfig
  if (-not $config.Configured) {
    Write-JsonResponse -Stream $Stream -StatusCode 500 -Payload ([ordered]@{ error = 'OAuth do servidor ainda nao foi configurado. Preencha config/oauth.local.json.' }) -IsHead $IsHead
    return
  }
  $state = New-RandomToken
  Save-OAuthState $state
  $authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + (ConvertTo-QueryString @{
    client_id = $config.ClientId
    redirect_uri = $config.RedirectUri
    response_type = 'code'
    scope = $config.Scope
    access_type = 'offline'
    include_granted_scopes = 'true'
    prompt = 'consent'
    state = $state
  })
  Write-RedirectResponse -Stream $Stream -Location $authUrl -IsHead $IsHead
}

function Handle-AuthCallback {
  param([System.Net.Sockets.NetworkStream]$Stream,[bool]$IsHead,[hashtable]$Query)
  $config = Get-DriveServerConfig
  if (-not $config.Configured) { Write-RedirectResponse -Stream $Stream -Location '/?auth=error&message=oauth-config-missing' -IsHead $IsHead; return }
  if ($Query.error) { Write-RedirectResponse -Stream $Stream -Location ('/?auth=error&message=' + [System.Uri]::EscapeDataString([string]$Query.error)) -IsHead $IsHead; return }
  $savedState = Read-OAuthState
  $isValidState = $savedState -and $savedState.value -and ([string]$savedState.value -eq [string]$Query.state)
  if ($isValidState -and $savedState.createdAt) {
    try { if ([DateTimeOffset]::Parse([string]$savedState.createdAt).AddMinutes(15) -lt [DateTimeOffset]::UtcNow) { $isValidState = $false } } catch { $isValidState = $false }
  }
  if (-not $isValidState) { Clear-OAuthState; Write-RedirectResponse -Stream $Stream -Location '/?auth=error&message=state-invalid' -IsHead $IsHead; return }
  if (-not $Query.code) { Clear-OAuthState; Write-RedirectResponse -Stream $Stream -Location '/?auth=error&message=missing-code' -IsHead $IsHead; return }
  try {
    $tokens = Exchange-GoogleAuthCode -Config $config -Code ([string]$Query.code)
    $existingSession = Read-OAuthSession
    $refreshToken = if ($tokens.refresh_token) { [string]$tokens.refresh_token } elseif ($existingSession -and $existingSession.refresh_token) { [string]$existingSession.refresh_token } else { '' }
    if ([string]::IsNullOrWhiteSpace($refreshToken)) { throw 'Google nao retornou refresh token. Revise o consentimento e o access_type=offline.' }
    Save-OAuthSession ([ordered]@{
      refresh_token = $refreshToken
      access_token = [string]$tokens.access_token
      expires_at = ([DateTimeOffset]::UtcNow.AddSeconds([int]$tokens.expires_in - 60).ToString('o'))
      file_id = if ($existingSession -and $existingSession.file_id) { [string]$existingSession.file_id } else { '' }
      scope = if ($tokens.scope) { [string]$tokens.scope } else { '' }
      updated_at = ([DateTimeOffset]::UtcNow.ToString('o'))
    })
    Clear-OAuthState
    Write-RedirectResponse -Stream $Stream -Location '/?auth=success' -IsHead $IsHead
  }
  catch {
    Clear-OAuthState
    Write-RedirectResponse -Stream $Stream -Location ('/?auth=error&message=' + [System.Uri]::EscapeDataString([string]$_)) -IsHead $IsHead
  }
}

function Handle-AuthLogout {
  param([System.Net.Sockets.NetworkStream]$Stream,[bool]$IsHead)
  Clear-OAuthSession
  Write-JsonResponse -Stream $Stream -StatusCode 200 -Payload ([ordered]@{ ok = $true }) -IsHead $IsHead
}

function Handle-DriveEnvelopeGet {
  param([System.Net.Sockets.NetworkStream]$Stream,[bool]$IsHead)
  $config = Get-DriveServerConfig
  if (-not (Test-OAuthAuthenticated -Config $config)) { Write-JsonResponse -Stream $Stream -StatusCode 401 -Payload ([ordered]@{ error = 'Nao autenticado no Google Drive.' }) -IsHead $IsHead; return }
  try {
    $accessToken = Get-ValidAccessToken -Config $config
    $file = Get-OrFindDriveFile -Config $config -AccessToken $accessToken
    if (-not $file -or -not $file.id) {
      Write-JsonResponse -Stream $Stream -StatusCode 200 -Payload ([ordered]@{ fileId = ''; envelope = $null }) -IsHead $IsHead
      return
    }
    Save-DriveFileId -FileId ([string]$file.id)
    try {
      $envelope = Fetch-DriveEnvelope -AccessToken $accessToken -FileId ([string]$file.id)
    }
    catch {
      if (Test-DriveNotFoundError ([string]$_)) {
        Save-DriveFileId -FileId ''
        Write-JsonResponse -Stream $Stream -StatusCode 200 -Payload ([ordered]@{ fileId = ''; envelope = $null }) -IsHead $IsHead
        return
      }
      throw
    }
    Write-JsonResponse -Stream $Stream -StatusCode 200 -Payload ([ordered]@{ fileId = [string]$file.id; envelope = $envelope }) -IsHead $IsHead
  }
  catch {
    Write-DebugLog "Drive envelope GET falhou: $($_.Exception.Message)"
    Write-JsonResponse -Stream $Stream -StatusCode 500 -Payload ([ordered]@{ error = [string]$_.Exception.Message }) -IsHead $IsHead
  }
}

function Handle-DriveEnvelopeSave {
  param([System.Net.Sockets.NetworkStream]$Stream,[bool]$IsHead,[string]$RequestBody)
  $config = Get-DriveServerConfig
  if (-not (Test-OAuthAuthenticated -Config $config)) { Write-JsonResponse -Stream $Stream -StatusCode 401 -Payload ([ordered]@{ error = 'Nao autenticado no Google Drive.' }) -IsHead $IsHead; return }
  $form = Parse-FormEncoded $RequestBody
  if (-not $form.ContainsKey('payload') -or [string]::IsNullOrWhiteSpace([string]$form.payload)) { Write-JsonResponse -Stream $Stream -StatusCode 400 -Payload ([ordered]@{ error = 'Payload ausente.' }) -IsHead $IsHead; return }
  try { $null = $form.payload | ConvertFrom-Json } catch { Write-JsonResponse -Stream $Stream -StatusCode 400 -Payload ([ordered]@{ error = 'Payload JSON invalido.' }) -IsHead $IsHead; return }
  try {
    $accessToken = Get-ValidAccessToken -Config $config
    $file = Get-OrFindDriveFile -Config $config -AccessToken $accessToken
    if (-not $file -or -not $file.id) {
      $created = Create-DriveFile -Config $config -AccessToken $accessToken -EnvelopeJson ([string]$form.payload)
      Save-DriveFileId -FileId ([string]$created.id)
      Write-JsonResponse -Stream $Stream -StatusCode 200 -Payload ([ordered]@{ fileId = [string]$created.id; status = 'created' }) -IsHead $IsHead
      return
    }
    $preferredFile = Ensure-PreferredDriveFile -Config $config -AccessToken $accessToken -File $file
    try {
      $updated = Update-DriveFile -AccessToken $accessToken -FileId ([string]$preferredFile.id) -EnvelopeJson ([string]$form.payload)
    }
    catch {
      $updateError = [string]$_.Exception.Message
      if (Test-DriveNotFoundError $updateError) {
        Save-DriveFileId -FileId ''
        $created = Create-DriveFile -Config $config -AccessToken $accessToken -EnvelopeJson ([string]$form.payload)
        Save-DriveFileId -FileId ([string]$created.id)
        Write-JsonResponse -Stream $Stream -StatusCode 200 -Payload ([ordered]@{ fileId = [string]$created.id; status = 'created' }) -IsHead $IsHead
        return
      }
      if (Test-DriveTransportFallbackError $updateError) {
        Write-DebugLog "Atualizacao direta do backup falhou; criando um novo arquivo no Drive. Motivo: $updateError"
        $created = Create-DriveFile -Config $config -AccessToken $accessToken -EnvelopeJson ([string]$form.payload)
        Save-DriveFileId -FileId ([string]$created.id)
        Write-JsonResponse -Stream $Stream -StatusCode 200 -Payload ([ordered]@{ fileId = [string]$created.id; status = 'recreated' }) -IsHead $IsHead
        return
      }
      throw
    }
    $fileId = if ($updated.id) { [string]$updated.id } else { [string]$preferredFile.id }
    Save-DriveFileId -FileId $fileId
    Write-JsonResponse -Stream $Stream -StatusCode 200 -Payload ([ordered]@{ fileId = $fileId; status = 'updated' }) -IsHead $IsHead
  }
  catch {
    Write-DebugLog "Drive envelope SAVE falhou: $($_.Exception.Message)"
    Write-JsonResponse -Stream $Stream -StatusCode 500 -Payload ([ordered]@{ error = [string]$_.Exception.Message }) -IsHead $IsHead
  }
}

function Handle-ApiRequest {
  param([System.Net.Sockets.NetworkStream]$Stream,[string]$Method,[string]$Path,[hashtable]$Query,[string]$RequestBody,[bool]$IsHead)
  switch ("$Method $Path") {
    'GET /api/auth/session' { Write-JsonResponse -Stream $Stream -StatusCode 200 -Payload (Get-AuthSessionPayload) -IsHead $IsHead; return }
    'GET /api/auth/google/start' { Handle-AuthStart -Stream $Stream -IsHead $IsHead; return }
    'GET /api/auth/google/callback' { Handle-AuthCallback -Stream $Stream -IsHead $IsHead -Query $Query; return }
    'POST /api/auth/logout' { Handle-AuthLogout -Stream $Stream -IsHead $IsHead; return }
    'GET /api/drive/envelope' { Handle-DriveEnvelopeGet -Stream $Stream -IsHead $IsHead; return }
    'POST /api/drive/envelope' { Handle-DriveEnvelopeSave -Stream $Stream -IsHead $IsHead -RequestBody $RequestBody; return }
    default { Write-JsonResponse -Stream $Stream -StatusCode 404 -Payload ([ordered]@{ error = 'Rota API nao encontrada.' }) -IsHead $IsHead; return }
  }
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()

Write-Host "SF em http://localhost:$Port"
Write-Host "Pasta servida: $publicRoot"
Write-Host "Config do OAuth: $oauthConfigPath"
Write-Host 'Pressione Ctrl+C para encerrar.'

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    $reader = $null
    $stream = $null
    try {
      $stream = $client.GetStream()
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $false, 8192, $true)
      $requestLine = $reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }

      $headers = @{}
      while (($line = $reader.ReadLine()) -ne '') {
        if ($null -eq $line) { break }
        $separator = $line.IndexOf(':')
        if ($separator -lt 0) { continue }
        $headers[$line.Substring(0, $separator).Trim().ToLowerInvariant()] = $line.Substring($separator + 1).Trim()
      }

      $parts = $requestLine.Split(' ')
      if ($parts.Length -lt 2) { Write-TextResponse -Stream $stream -StatusCode 400 -StatusText 'Bad Request' -Content 'Requisicao invalida.' -IsHead $false; continue }
      $method = $parts[0].ToUpperInvariant()
      $target = $parts[1]
      $isHead = $method -eq 'HEAD'
      if ($method -notin @('GET', 'HEAD', 'POST')) { Write-TextResponse -Stream $stream -StatusCode 405 -StatusText 'Method Not Allowed' -Content 'Metodo nao suportado.' -IsHead $isHead; continue }

      $contentLength = 0
      if ($headers.ContainsKey('content-length')) { [int]::TryParse($headers['content-length'], [ref]$contentLength) | Out-Null }
      $requestBody = Read-RequestBody -Reader $reader -ContentLength $contentLength
      $parsedTarget = Parse-RequestTarget -RequestTarget $target
      $path = [string]$parsedTarget.Path
      $query = $parsedTarget.Query

      if ($path.StartsWith('/api/', [System.StringComparison]::OrdinalIgnoreCase)) {
        Handle-ApiRequest -Stream $stream -Method $method -Path $path -Query $query -RequestBody $requestBody -IsHead $isHead
        continue
      }

      if ($method -notin @('GET', 'HEAD')) { Write-TextResponse -Stream $stream -StatusCode 405 -StatusText 'Method Not Allowed' -Content 'Metodo nao suportado para arquivos estaticos.' -IsHead $isHead; continue }
      $fullPath = Resolve-RequestPath -RequestTarget $target
      if ($null -eq $fullPath -or -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { Write-TextResponse -Stream $stream -StatusCode 404 -StatusText 'Not Found' -Content 'Arquivo nao encontrado.' -IsHead $isHead; continue }
      Write-Response -Stream $stream -StatusCode 200 -StatusText 'OK' -ContentType (Get-ContentType -Path $fullPath) -BodyBytes ([System.IO.File]::ReadAllBytes($fullPath)) -IsHead $isHead
    }
    catch {
      Write-DebugLog "Loop principal falhou: $($_.Exception.Message)"
      if ($stream) { Write-TextResponse -Stream $stream -StatusCode 500 -StatusText 'Internal Server Error' -Content ($_.Exception.Message) -IsHead $false }
    }
    finally {
      if ($reader) { $reader.Dispose() }
      if ($stream) { $stream.Dispose() }
      $client.Close()
    }
  }
}
finally {
  $listener.Stop()
}

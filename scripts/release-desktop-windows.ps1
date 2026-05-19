param(
  [switch]$NoVersionBump,
  [switch]$SkipInstall,
  [switch]$SkipGitPull,
  [switch]$NoUpload
)

$ErrorActionPreference = 'Stop'

function Write-Step($message) {
  Write-Host ""
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Run-Cmd($file, $arguments) {
  Write-Host "> $file $arguments" -ForegroundColor DarkGray
  $process = Start-Process -FilePath $file -ArgumentList $arguments -NoNewWindow -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Comando falhou ($($process.ExitCode)): $file $arguments"
  }
}

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root

function Assert-FileContains($filePath, $needle, $message) {
  if (-not (Test-Path $filePath)) {
    throw $message
  }
  $content = Get-Content -Raw -Path $filePath
  if ($content.IndexOf($needle, [System.StringComparison]::Ordinal) -lt 0) {
    throw $message
  }
}

function Assert-SourceReady() {
  Write-Step 'A validar source antes de publicar'
  Assert-FileContains (Join-Path $Root 'electron\main.js') 'wa:financas-at-profile' 'Source incompleto: falta o endpoint AT no electron/main.js. Atualiza a pasta fonte antes de publicar.'
  Assert-FileContains (Join-Path $Root 'electron\preload.js') 'financasAtProfile' 'Source incompleto: falta financasAtProfile no electron/preload.js. Atualiza a pasta fonte antes de publicar.'
  Assert-FileContains (Join-Path $Root 'electron\financas-at-profile.js') 'collectFinancasAtProfile' 'Source incompleto: falta electron/financas-at-profile.js. Atualiza a pasta fonte antes de publicar.'
}

Write-Host "WA PRO Desktop Release" -ForegroundColor Green
Write-Host "Pasta: $Root"

if (-not $SkipGitPull -and (Test-Path '.git')) {
  Write-Step 'A atualizar código pelo Git'
  Run-Cmd 'git' 'pull --ff-only'
}

Assert-SourceReady

if (-not $SkipInstall) {
  Write-Step 'A instalar dependências'
  Run-Cmd 'npm' 'ci'
}

if (-not $NoVersionBump) {
  Write-Step 'A subir versão patch'
  Run-Cmd 'npm' 'run version:bump:patch'
}

$Version = node -p "require('./package.json').version"
$Version = "$Version".Trim()
if (-not $Version) { throw 'Não consegui ler a versão do package.json.' }

Write-Step "A gerar build web + instalador Windows v$Version"
Run-Cmd 'npm' 'run build'
Run-Cmd 'npx' 'electron-builder --win nsis --x64 --config.npmRebuild=false --publish never'

$ReleaseDir = Join-Path $Root 'release'
$Exe = Join-Path $ReleaseDir "WA-PRO-v$Version-win-x64.exe"
$Blockmap = Join-Path $ReleaseDir "WA-PRO-v$Version-win-x64.exe.blockmap"
$Latest = Join-Path $ReleaseDir 'latest.yml'

if (-not (Test-Path $Exe)) { throw "Installer não encontrado: $Exe" }
if (-not (Test-Path $Latest)) { throw "latest.yml não encontrado: $Latest" }

$BundleDir = Join-Path $ReleaseDir "desktop-update-v$Version"
if (Test-Path $BundleDir) { Remove-Item $BundleDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $BundleDir | Out-Null
Copy-Item $Exe $BundleDir -Force
Copy-Item $Latest $BundleDir -Force
if (Test-Path $Blockmap) { Copy-Item $Blockmap $BundleDir -Force }

Write-Step 'Pacote preparado'
Get-ChildItem $BundleDir | Format-Table Name, Length, LastWriteTime

$DeployHost = if ($env:WAPRO_DEPLOY_HOST) { $env:WAPRO_DEPLOY_HOST } else { 'wa.mpr.pt' }
$DeployUser = if ($env:WAPRO_DEPLOY_USER) { $env:WAPRO_DEPLOY_USER } else { 'ubuntu' }
$DeployPath = if ($env:WAPRO_DEPLOY_PATH) { $env:WAPRO_DEPLOY_PATH } else { '/home/ubuntu/programas/mprWA/release' }
$DeployKey = $env:WAPRO_DEPLOY_KEY

if (-not $NoUpload -and $DeployHost -and $DeployUser -and $DeployPath) {
  Write-Step "A enviar para ${DeployUser}@${DeployHost}:${DeployPath}"
  $scpArgs = @()
  if ($DeployKey) {
    $scpArgs += '-i'
    $scpArgs += $DeployKey
  }
  $scpArgs += $Exe
  if (Test-Path $Blockmap) { $scpArgs += $Blockmap }
  $scpArgs += $Latest
  $scpArgs += "${DeployUser}@${DeployHost}:${DeployPath}/"

  Write-Host "> scp $($scpArgs -join ' ')" -ForegroundColor DarkGray
  $scp = Start-Process -FilePath 'scp' -ArgumentList $scpArgs -NoNewWindow -Wait -PassThru
  if ($scp.ExitCode -ne 0) { throw "Upload por scp falhou ($($scp.ExitCode))." }

  Write-Step 'A validar latest.yml no servidor'
  try {
    $response = Invoke-WebRequest -Uri 'https://wa.mpr.pt/api/desktop/updates/latest.yml' -UseBasicParsing -TimeoutSec 20
    Write-Host $response.Content
  } catch {
    Write-Warning "Upload feito, mas não consegui validar o latest.yml publicamente: $($_.Exception.Message)"
  }

  Write-Step 'A confirmar ficheiros no Oracle'
  $sshArgs = @()
  if ($DeployKey) {
    $sshArgs += '-i'
    $sshArgs += $DeployKey
  }
  $sshArgs += "${DeployUser}@${DeployHost}"
  $sshArgs += "ls -lh '$DeployPath/latest.yml' '$DeployPath/WA-PRO-v$Version-win-x64.exe' '$DeployPath/WA-PRO-v$Version-win-x64.exe.blockmap' 2>/dev/null || true"
  $ssh = Start-Process -FilePath 'ssh' -ArgumentList $sshArgs -NoNewWindow -Wait -PassThru
  if ($ssh.ExitCode -ne 0) {
    Write-Warning "Upload feito, mas a confirmação por ssh falhou ($($ssh.ExitCode))."
  }
} else {
  Write-Step 'Upload automático desligado'
  Write-Host "Copia estes ficheiros para a pasta release/ do servidor:" -ForegroundColor Yellow
  Write-Host $BundleDir -ForegroundColor Yellow
}

Write-Step "Release desktop v$Version concluída"

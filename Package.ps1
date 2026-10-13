param([string]$Destination)
$ErrorActionPreference = 'Stop'
$packageVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json).version
if (-not $Destination) { $Destination = Join-Path (Split-Path $PSScriptRoot -Parent) "st-worldbook-updater-${packageVersion}.zip" }
if (Test-Path -LiteralPath $Destination) { throw "压缩包已存在，未覆盖：${Destination}" }
$packageFiles = @('manifest.json', 'index.js', 'core.js', 'editor.js', 'editor-model.js', 'editor.css', 'manager-model.js', 'manager-host.js', 'manager-ui.js', 'launcher.js', 'README.md', 'CHECKS.md', 'NEXT.md', 'SOURCE_CONTRACT.json', 'Install.ps1', 'Verify-Source.ps1', 'Package.ps1', 'package.json', 'editor-preview.png', 'editor-preview-0.3.png', 'tests')
$packageFiles += @('ui-day.jpg', 'ui-night.jpg', 'ui-mobile.jpg')
$packageFiles += 'update-check.js'
$packageFiles += 'extension-update-preview.png'
Compress-Archive -LiteralPath ($packageFiles | ForEach-Object { Join-Path $PSScriptRoot $_ }) -DestinationPath $Destination
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packageArchive = [IO.Compression.ZipFile]::OpenRead($Destination)
try {
    $packageArchive.Entries | Where-Object FullName -Match '(manifest.json|editor.js|editor-model.js|editor.css|README.md)$' | Select-Object FullName, Length
} finally { $packageArchive.Dispose() }
Write-Output "已打包：${Destination}"

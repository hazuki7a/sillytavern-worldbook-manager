param([string]$Destination = (Join-Path (Split-Path $PSScriptRoot -Parent) 'st-worldbook-updater-0.2.0.zip'))
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Destination) { throw "压缩包已存在，未覆盖：${Destination}" }
Compress-Archive -LiteralPath $PSScriptRoot -DestinationPath $Destination
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packageArchive = [IO.Compression.ZipFile]::OpenRead($Destination)
try {
    $packageArchive.Entries | Where-Object FullName -Match '(manifest.json|editor.js|editor-model.js|editor.css|README.md)$' | Select-Object FullName, Length
} finally { $packageArchive.Dispose() }
Write-Output "已打包：${Destination}"

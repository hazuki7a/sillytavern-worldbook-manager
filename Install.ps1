param(
    [string]$SillyTavernRoot = 'D:\sillytaverns\SillyTavern',
    [string]$UserHandle = 'default-user',
    [switch]$Install
)
$ErrorActionPreference = 'Stop'
if ($UserHandle -notmatch '^[A-Za-z0-9_-]+$') { throw '账户名只允许字母、数字、下划线或连字符。' }
& (Join-Path $PSScriptRoot 'Verify-Source.ps1') -SillyTavernRoot $SillyTavernRoot
$rootPath = (Resolve-Path -LiteralPath $SillyTavernRoot).Path
$accountPath = Join-Path (Join-Path $rootPath 'data') $UserHandle
if (-not (Test-Path -LiteralPath $accountPath -PathType Container)) { throw "未找到酒馆账户目录：${accountPath}" }
$extensionsPath = [IO.Path]::GetFullPath((Join-Path $accountPath 'extensions'))
$targetPath = [IO.Path]::GetFullPath((Join-Path $extensionsPath 'st-worldbook-updater'))
if (-not $targetPath.StartsWith($rootPath.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '安装目标超出了酒馆目录。' }
if (Test-Path -LiteralPath $targetPath) { throw "目标已存在，未覆盖：${targetPath}" }
$files = @('manifest.json', 'index.js', 'core.js', 'editor.js', 'editor-model.js', 'editor.css', 'manager-model.js', 'manager-host.js', 'manager-ui.js', 'launcher.js', 'README.md', 'SOURCE_CONTRACT.json')
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $file) -PathType Leaf)) { throw "安装包缺少 ${file}" }
}
Write-Output "安装目标：${targetPath}"
Write-Output ('安装文件：' + ($files -join ', '))
if (-not $Install) { Write-Output '仅预览，未写入。使用 -Install 才会安装。'; exit 0 }
New-Item -ItemType Directory -Path $targetPath -ErrorAction Stop | Out-Null
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $targetPath $file) -ErrorAction Stop
}
Write-Output '扩展文件已安装。请刷新酒馆并使用测试卡验收；尚未证明宿主加载成功。'

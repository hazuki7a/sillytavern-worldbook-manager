param([string]$SillyTavernRoot = 'D:\sillytaverns\SillyTavern')
$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path -LiteralPath $SillyTavernRoot).Path
$version = (Get-Content -LiteralPath (Join-Path $rootPath 'package.json') -Raw | ConvertFrom-Json).version
if ($version -ne '1.18.0') { throw "仅核对了 1.18.0；目标为 ${version}，请复核接口后安装。" }
$checks = @{
    'public/scripts/st-context.js' = @('getRequestHeaders,', 'convertCharacterBook,', 'getOneCharacter,', 'updateWorldInfoList,', 'reloadWorldInfoEditor: reloadEditor', 'eventTypes: event_types', 'POPUP_RESULT,', 'saveMetadata,', 'chatMetadata: chat_metadata', 'chatId: selected_group')
    'public/scripts/world-info.js' = @('export let world_info', 'export let selected_world_info', 'export const worldInfoCache', 'export async function deleteWorldInfo', 'export const newWorldInfoEntryDefinition', 'export const newWorldInfoEntryTemplate', 'export const originalWIDataKeyMap', 'export function updateWorldInfoSettings', 'export let world_names', 'await eventSource.emit(event_types.WORLDINFO_ENTRIES_LOADED, { globalLore, characterLore, chatLore, personaLore })')
    'public/script.js' = @('export const isGenerating', 'export function select_selected_character')
    'public/scripts/events.js' = @('APP_READY:', 'CHARACTER_PAGE_LOADED:', 'CHARACTER_EDITOR_OPENED:', 'CHARACTER_EDITED:', 'CHAT_CHANGED:', 'GENERATION_ENDED:', 'WORLDINFO_UPDATED:', 'WORLDINFO_SETTINGS_UPDATED:', 'WORLDINFO_ENTRIES_LOADED:')
    'src/endpoints/worldinfo.js' = @("router.post('/list'", "router.post('/get'", "router.post('/edit'", "router.post('/delete'")
    'src/endpoints/characters.js' = @("router.post('/merge-attributes'", "router.post('/get'", "router.post('/all'")
    'src/endpoints/files.js' = @("router.post('/upload'", "router.post('/sanitize-filename'")
    'src/endpoints/chats.js' = @("router.post('/recent'", "router.post('/get'", 'request.body.metadata')
    'public/lib/eventemitter.js' = @('autoFireLastArgs', 'EventEmitter.prototype.removeListener')
}
foreach ($relative in $checks.Keys) {
    $sourceText = Get-Content -LiteralPath (Join-Path $rootPath $relative) -Raw
    foreach ($needle in $checks[$relative]) {
        if (-not $sourceText.Contains($needle)) { throw "接口检查失败：${relative} 缺少 ${needle}" }
    }
}
Write-Output '通过：本机 1.18.0 必需源码接口存在。这不代表浏览器实际运行已验收。'

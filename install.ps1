# 把三个规划 skill 装到本机 DSH（Windows）。
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# 装到 $env:DSH_HOME\skills（没设就是 %USERPROFILE%\.dsh\skills）。
$ErrorActionPreference = 'Stop'

$Skills = @('grilling', 'brainstorming', 'explore')
$Src = Join-Path $PSScriptRoot 'skills'

if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
$Dest = Join-Path $DshHome 'skills'

Write-Host "源目录 : $Src"
Write-Host "目标   : $Dest"
Write-Host ""

# ── 先校验包完整 ──────────────────────────────────────────────
$missing = $false
foreach ($d in $Skills) {
    $f = Join-Path (Join-Path $Src $d) 'SKILL.md'
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) {
        Write-Host "[缺少] $f" -ForegroundColor Red
        $missing = $true
    }
}
if ($missing) {
    Write-Host "包不完整，请重新克隆后再试。" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $Dest)) {
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
}

# ── 逐个安装（已存在则先备份，不静默覆盖）──────────────────────
foreach ($d in $Skills) {
    $target = Join-Path $Dest $d
    if (Test-Path -LiteralPath $target) {
        $backup = "$target.bak-" + (Get-Date -Format 'yyyyMMddHHmmss')
        Move-Item -LiteralPath $target -Destination $backup
        Write-Host "[备份] $d 已存在，旧版备份为 $(Split-Path -Leaf $backup)"
    }
    Copy-Item -LiteralPath (Join-Path $Src $d) -Destination $target -Recurse -Force
    Write-Host "[完成] 已安装 $d" -ForegroundColor Green
}

# ── 装后自检：frontmatter 的 name 必须和目录名一致 ─────────────
# DSH 遇到写错的 frontmatter 会静默丢弃整个 skill，所以这里必须自己拦一道。
Write-Host ""
Write-Host "自检："
$ok = $true
foreach ($d in $Skills) {
    $dir = Join-Path $Dest $d
    $f = Join-Path $dir 'SKILL.md'
    $name = $null
    $sep = 0
    foreach ($line in (Get-Content -LiteralPath $f -Encoding UTF8)) {
        if ($line -match '^---\s*$') { $sep++; continue }
        if ($sep -eq 1 -and $line -match '^name:\s*(.+?)\s*$') {
            $name = $Matches[1].Trim('"', "'")
            break
        }
    }
    $refs = ''
    if (Test-Path -LiteralPath (Join-Path $dir 'references')) { $refs = ' +references/' }
    if ($name -eq $d) {
        Write-Host "  [OK] $d  (name 匹配$refs)" -ForegroundColor Green
    } else {
        Write-Host "  [错误] $d  frontmatter name = '$name'，与目录名不一致 —— DSH 会丢弃这个 skill" -ForegroundColor Red
        $ok = $false
    }
}

Write-Host ""
if ($ok) {
    Write-Host "安装完成。DSH 会自动发现这些 skill（无需重启）："
    Write-Host "  /grilling    /brainstorming    /explore"
    Write-Host ""
    Write-Host "两个断言插件在 Windows 上按 README 的手动步骤装（同样是「复制 + 改 patch」两件事）。"
} else {
    Write-Host "有 skill 未通过自检，详见上面的 [错误] 行。" -ForegroundColor Red
    exit 1
}

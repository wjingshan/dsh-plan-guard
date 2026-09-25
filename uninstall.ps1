# 卸载三个规划 skill（Windows）。
#
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#
# 只删这三个名字，不动 $env:DSH_HOME\skills 下的其他任何内容。
$ErrorActionPreference = 'Stop'

$Skills = @('grilling', 'brainstorming', 'explore')

if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
$Dest = Join-Path $DshHome 'skills'

Write-Host "目标 : $Dest"
Write-Host ""

if (-not (Test-Path -LiteralPath $Dest)) {
    Write-Host "· $Dest 不存在，无需卸载。"
    exit 0
}

foreach ($d in $Skills) {
    $target = Join-Path $Dest $d
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
        Write-Host "[完成] 已移除 $d" -ForegroundColor Green
    } else {
        Write-Host "· $d 未安装，跳过"
    }
}

Write-Host ""
Write-Host "完成。留下的 .bak-<时间戳> 备份目录（如果有）不会自动删除。"

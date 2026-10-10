$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'release-notes.ps1')

$checks = 0
function Assert-Fails([scriptblock]$Action, [string]$Pattern) {
    try { & $Action } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
        $script:checks++
        return
    }
    throw "Expected failure: $Pattern"
}
function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Unexpected value: $Actual" }
    $script:checks++
}
function Invoke-FixtureGit([string[]]$Arguments) {
    & git -C $fixtureRoot @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Fixture git failed: $Arguments" }
}

$notes = "## 1.2.0（2026-10-09）`n`n### 修复`n`n- 保留失败后的原数据。"
$old = "## 1.1.0 - 2026-09-19`n`n- 增加数据备份。"
$text = "# 更新日志`n`n$notes`n`n$old`n"
Assert-Equal (Get-ChangelogReleaseNotes -Text $text -Version '1.2.0' -RequirePublished) $notes
Assert-Equal (Get-ChangelogReleaseNotes -Text $text.Replace("`n", "`r`n") -Version '1.1.0' -RequirePublished) $old
Assert-Equal (Get-ChangelogReleaseNotes -Text "$text`n## 未发布迭代记录`n### 1.2.0（未发布迭代）`n- 旧方案" -Version '1.1.0') $old
Assert-Fails { Get-ChangelogReleaseNotes -Text $text -Version '1.2' } '仅包含一个'
Assert-Fails { Get-ChangelogReleaseNotes -Text "$text`n$notes" -Version '1.2.0' } '仅包含一个'
Assert-Fails { Get-ChangelogReleaseNotes -Text "## 1.2.0（未发布）`n- 修复" -Version '1.2.0' -RequirePublished } '发布日期'
Assert-Fails { Get-ChangelogReleaseNotes -Text "## 1.2.0`n- 修复" -Version '1.2.0' -RequirePublished } '发布日期'
Assert-Fails { Get-ChangelogReleaseNotes -Text "## 1.2.0（2026-10-09）`n### 修复`n" -Version '1.2.0' } '没有发布正文'
Assert-Equal (Get-ChangelogReleaseNotes -Text "## 1.2.0（未发布）`n- 修复" -Version '1.2.0') "## 1.2.0（未发布）`n- 修复"

$fixtureRoot = Join-Path $PSScriptRoot ('release-notes-test-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    Invoke-FixtureGit @('init', '--quiet')
    Invoke-FixtureGit @('config', 'user.name', 'Release Notes Test')
    Invoke-FixtureGit @('config', 'user.email', 'release-notes@example.invalid')
    $changelog = Join-Path $fixtureRoot 'CHANGELOG.md'
    Set-Content -LiteralPath $changelog -Value "# 更新日志`n`n$old" -Encoding utf8
    Invoke-FixtureGit @('add', 'CHANGELOG.md')
    Invoke-FixtureGit @('commit', '--quiet', '-m', 'docs: release 1.1.0')
    Invoke-FixtureGit @('tag', 'v1.1.0')
    Set-Content -LiteralPath $changelog -Value $text -Encoding utf8
    Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0'
    $checks++
    Set-Content -LiteralPath $changelog -Value $text.Replace('增加数据备份。', '增加新版才支持的合并。') -Encoding utf8
    Assert-Fails { Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0' } '与 v1.1.0 不一致'
    Set-Content -LiteralPath $changelog -Value $notes -Encoding utf8
    Assert-Fails { Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0' } '仅包含一个'
    Set-Content -LiteralPath $changelog -Value $text -Encoding utf8
    Invoke-FixtureGit @('add', 'CHANGELOG.md')
    Invoke-FixtureGit @('commit', '--quiet', '-m', 'docs: release 1.2.0')
    Invoke-FixtureGit @('tag', 'v1.2.0')
    Set-Content -LiteralPath $changelog -Value $text.Replace('保留失败后的原数据。', '本版本允许继续整理。') -Encoding utf8
    Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0'
    $checks++
    $futureTree = & git -C $fixtureRoot rev-parse 'HEAD^{tree}'
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read fixture tree' }
    $futureCommit = 'Unrelated future release' | & git -C $fixtureRoot commit-tree $futureTree
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create fixture commit' }
    Invoke-FixtureGit @('tag', 'v9.0.0', $futureCommit)
    Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0'
    $checks++

    $approvedOld = $old.Replace('增加数据备份。', '提供数据备份。')
    $approvedText = $text.Replace($old, $approvedOld)
    $approvedCommit = & git -C $fixtureRoot rev-parse 'v1.1.0^{commit}'
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read approved baseline commit' }
    $entry = [ordered]@{
        version = '1.1.0'; tagCommit = $approvedCommit
        originalSha256 = Get-ChangelogNotesDigest $old
        correctedSha256 = Get-ChangelogNotesDigest $approvedOld
        reason = 'Correct the wording to describe delivered behavior.'
        evidence = @('v1.1.0:CHANGELOG.md')
    }
    $record = [ordered]@{schemaVersion=1;entries=@($entry)}
    $correctionDirectory = Join-Path $fixtureRoot '.github'
    New-Item -ItemType Directory -Force -Path $correctionDirectory | Out-Null
    $correctionFile = Join-Path $correctionDirectory 'changelog-corrections.json'
    function Write-CorrectionFixture { $record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $correctionFile -Encoding utf8 }
    Write-CorrectionFixture
    Set-Content -LiteralPath $changelog -Value $approvedText -Encoding utf8
    Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0'
    $checks++
    Set-Content -LiteralPath $changelog -Value $approvedText.Replace('提供数据备份。', '新版才有的合并。') -Encoding utf8
    Assert-Fails { Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0' } '修正文案不一致'
    Set-Content -LiteralPath $changelog -Value $approvedText -Encoding utf8
    $entry.originalSha256 = '0' * 64; Write-CorrectionFixture
    Assert-Fails { Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0' } '原文摘要不一致'
    $entry.originalSha256 = Get-ChangelogNotesDigest $old
    $entry.tagCommit = '0' * 40; Write-CorrectionFixture
    Assert-Fails { Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0' } '标签提交不一致'
    $entry.tagCommit = $approvedCommit
    $entry.correctedSha256 = '0' * 64; Write-CorrectionFixture
    Assert-Fails { Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0' } '修正文案不一致'
    $entry.correctedSha256 = Get-ChangelogNotesDigest $approvedOld
    $record.schemaVersion = 2; Write-CorrectionFixture
    Assert-Fails { Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0' } 'schemaVersion'
    $record.schemaVersion = 1
    $entry.reason = ''; Write-CorrectionFixture
    Assert-Fails { Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0' } '修正依据'
    $entry.reason = $true; Write-CorrectionFixture
    Assert-Fails { Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0' } '字符串'
    $entry.reason = 'Verified wording correction.'
    $entry.evidence = @($true); Write-CorrectionFixture
    Assert-Fails { Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0' } '修正依据'
    $entry.evidence = @('v1.1.0:CHANGELOG.md')
    $record.entries = @($entry, $entry); Write-CorrectionFixture
    Assert-Fails { Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0' } '重复'
    Set-Content -LiteralPath $correctionFile -Value '{broken json' -Encoding utf8
    Assert-Fails { Assert-ChangelogHistory -RepositoryRoot $fixtureRoot -CurrentVersion '1.2.0' } '无法读取'
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        $resolved = [IO.Path]::GetFullPath($fixtureRoot)
        $parent = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
        if (-not $resolved.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected fixture path' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
Write-Host "Release notes tests passed: $checks checks"

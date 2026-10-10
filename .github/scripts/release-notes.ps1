function Get-ChangelogReleaseNotes {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Text,
        [Parameter(Mandatory)][string]$Version,
        [switch]$RequirePublished
    )
    $normalized = $Text.TrimStart([char]0xFEFF).Replace("`r`n", "`n").Replace("`r", "`n")
    $headings = [regex]::Matches($normalized, '(?m)^##[ \t]+([^\s（(]+)[^\n]*$')
    $matching = @($headings | Where-Object { $_.Groups[1].Value -ceq $Version })
    if ($matching.Count -ne 1) { throw "CHANGELOG.md 必须包含且仅包含一个版本 $Version 的二级标题，实际为 $($matching.Count) 个" }
    $heading = $matching[0]
    if ($RequirePublished -and ($heading.Value -match '未发布|Unreleased' -or $heading.Value -notmatch '\b\d{4}-\d{2}-\d{2}\b')) {
        throw "CHANGELOG.md 的 $Version 必须填写发布日期，不能保留未发布状态"
    }
    $end = $normalized.Length
    foreach ($next in $headings) { if ($next.Index -gt $heading.Index) { $end = $next.Index; break } }
    $notes = $normalized.Substring($heading.Index, $end - $heading.Index).Trim()
    if ([string]::IsNullOrWhiteSpace([regex]::Replace($notes, '(?m)^#{2,6}[^\n]*$', '').Trim())) {
        throw "CHANGELOG.md 的 $Version 没有发布正文"
    }
    return $notes
}

function Get-ChangelogNotesDigest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-ChangelogCorrections([string]$RepositoryRoot) {
    $result = @{}
    $path = Join-Path $RepositoryRoot '.github/changelog-corrections.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $result }
    try { $record = Get-Content -LiteralPath $path -Raw -Encoding utf8 | ConvertFrom-Json }
    catch { throw '无法读取历史文案修正记录' }
    if (-not ($record.PSObject.Properties.Name -contains 'schemaVersion') -or $record.schemaVersion -ne 1 -or
            -not ($record.PSObject.Properties.Name -contains 'entries') -or $record.entries -isnot [array]) {
        throw '历史文案修正记录的 schemaVersion 或 entries 无效'
    }
    foreach ($entry in $record.entries) {
        foreach ($property in @('version', 'tagCommit', 'originalSha256', 'correctedSha256', 'reason', 'evidence')) {
            if (-not ($entry.PSObject.Properties.Name -contains $property)) { throw "历史文案修正记录缺少 $property" }
            if ($property -ne 'evidence' -and $entry.$property -isnot [string]) { throw "历史文案修正记录的 $property 必须为字符串" }
        }
        if ($entry.version -cnotmatch '^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$' -or
                $entry.tagCommit -cnotmatch '^[0-9a-f]{40}$' -or $entry.originalSha256 -cnotmatch '^[0-9a-f]{64}$' -or
                $entry.correctedSha256 -cnotmatch '^[0-9a-f]{64}$' -or $entry.originalSha256 -ceq $entry.correctedSha256) {
            throw '历史文案修正记录的版本或摘要无效'
        }
        if ([string]::IsNullOrWhiteSpace($entry.reason) -or $entry.evidence -isnot [array] -or $entry.evidence.Count -eq 0 -or
                @($entry.evidence | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
            throw '历史文案修正记录缺少修正依据'
        }
        if ($result.ContainsKey($entry.version)) { throw "历史文案修正记录的版本 $($entry.version) 重复" }
        $result[$entry.version] = $entry
    }
    return $result
}

function Assert-ChangelogHistory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [Parameter(Mandatory)][string]$CurrentVersion
    )
    $shallow = & git -C $RepositoryRoot rev-parse --is-shallow-repository
    if ($LASTEXITCODE -ne 0) { throw '无法读取 Git 历史' }
    if ($shallow -eq 'true') { throw '更新日志历史核对需要完整 Git 历史和版本标签，请使用 fetch-depth: 0' }
    $tags = @(& git -C $RepositoryRoot tag --merged HEAD --list 'v*')
    if ($LASTEXITCODE -ne 0) { throw '无法读取版本标签' }
    $corrections = Get-ChangelogCorrections $RepositoryRoot
    $currentText = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'CHANGELOG.md') -Raw -Encoding utf8
    $checked = 0
    $corrected = 0
    foreach ($tag in $tags) {
        if ($tag -notmatch '^v(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$') { continue }
        $version = $Matches[1]
        if ($version -ceq $CurrentVersion) { continue }
        $tagText = @(& git -C $RepositoryRoot show "${tag}:CHANGELOG.md") -join "`n"
        if ($LASTEXITCODE -ne 0) { throw "无法读取 $tag 的更新日志" }
        $expected = Get-ChangelogReleaseNotes -Text $tagText -Version $version
        $actual = Get-ChangelogReleaseNotes -Text $currentText -Version $version
        if ($corrections.ContainsKey($version)) {
            $entry = $corrections[$version]
            $commit = & git -C $RepositoryRoot rev-parse --verify "${tag}^{commit}"
            if ($LASTEXITCODE -ne 0 -or $commit -cne $entry.tagCommit) { throw "历史文案修正记录与 $tag 的标签提交不一致" }
            if ((Get-ChangelogNotesDigest $expected) -cne $entry.originalSha256) { throw "历史文案修正记录与 $tag 的原文摘要不一致" }
            if ((Get-ChangelogNotesDigest $actual) -cne $entry.correctedSha256) { throw "历史版本 $version 与已核实的修正文案不一致" }
            $corrected++
        } elseif ($actual -cne $expected) {
            throw "历史版本 $version 的更新日志与 $tag 不一致；请核对 CHANGELOG.md 修改历史，恢复混入的后续版本行为"
        }
        $checked++
    }
    Write-Host "Changelog history verified against $checked version tags ($corrected documented corrections)"
}

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Reference
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($env:GH_TOKEN)) {
    throw 'GitHub App installation token 未配置'
}
$payload = [ordered]@{
    event_type = 'component_published'
    client_payload = [ordered]@{
        channel = 'release'
        repository = $env:GITHUB_REPOSITORY
        commitSha = $env:GITHUB_SHA
        reference = $Reference
    }
} | ConvertTo-Json -Depth 5 -Compress
$payload | gh api --method POST repos/android-tool-suite/plugin-registry/dispatches --input -
if ($LASTEXITCODE -ne 0) { throw '无法通知 plugin-registry 更新索引' }

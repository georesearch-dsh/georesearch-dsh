$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$shimRoot = Join-Path $root '.tmp\corepack-shims'
$npmCache = Join-Path $root '.tmp\npm-cache'

function Invoke-ReleaseStep {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )

  Write-Host "==> $Name"
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

New-Item -ItemType Directory -Force -Path $shimRoot | Out-Null
New-Item -ItemType Directory -Force -Path $npmCache | Out-Null

Push-Location $root
try {
  Invoke-ReleaseStep 'Prepare pinned Corepack shim' {
    corepack enable --install-directory $shimRoot pnpm
  }

  $env:PATH = "$shimRoot;$env:PATH"
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  $env:CI = '1'
  $env:npm_config_cache = $npmCache

  Invoke-ReleaseStep 'Require clean Git worktree' {
    $gitStatus = @(git status --porcelain)
    if ($LASTEXITCODE -ne 0) {
      throw "Git status failed with exit code $LASTEXITCODE"
    }
    if ($gitStatus.Count -ne 0) {
      throw 'Release verification requires a clean Git worktree'
    }
  }
  Invoke-ReleaseStep 'Install frozen dependencies' {
    pnpm install --frozen-lockfile
  }
  Invoke-ReleaseStep 'Audit production dependencies' {
    pnpm run audit:prod
  }
  Invoke-ReleaseStep 'Run deterministic Phase 7 gate' {
    pnpm run phase7:gate
  }
  Invoke-ReleaseStep 'Verify DSH Standard conformance' {
    pnpm run dsh-std:check
  }
  Invoke-ReleaseStep 'Run public Phase 7 activation probe' {
    pnpm run probe:phase7-live
  }
  Invoke-ReleaseStep 'Verify release artifacts' {
    pnpm run release:check
  }
} finally {
  Pop-Location
}

Write-Host 'Release candidate is verified locally. No package was published.'

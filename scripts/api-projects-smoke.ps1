# Requires Node.js. Copies current process env — set SHORTS_TEST_EMAIL / SHORTS_TEST_PASSWORD first.
param(
    [string]$ApiUrl,
    [string]$TestEmail,
    [string]$TestPassword
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if ($ApiUrl) { $env:SHORTS_API_URL = $ApiUrl }
if ($TestEmail) { $env:SHORTS_TEST_EMAIL = $TestEmail }
if ($TestPassword) { $env:SHORTS_TEST_PASSWORD = $TestPassword }

if (-not $env:SHORTS_TEST_EMAIL -or -not $env:SHORTS_TEST_PASSWORD) {
    Write-Error "Set SHORTS_TEST_EMAIL and SHORTS_TEST_PASSWORD (or pass -TestEmail -TestPassword)."
}

node scripts/api-projects-smoke.mjs

# Puts the portable MSVC toolchain + Windows SDK + cargo on PATH for this shell.
# Use this when Visual Studio Build Tools are not installed system-wide:
#   . .\scripts\msvc-env.ps1
#   cargo build --manifest-path src-tauri/Cargo.toml
#
# Override the location with $env:Moneyero_MSVC_ROOT if you unpacked MSVC elsewhere.

$root = if ($env:Moneyero_MSVC_ROOT) { $env:Moneyero_MSVC_ROOT } else { Join-Path $env:USERPROFILE "msvc-portable\msvc" }
if (-not (Test-Path $root)) {
  Write-Error "Portable MSVC not found at $root. Install VS Build Tools (C++ workload) or see README > Building."
  return
}
$msvcv = (Get-ChildItem (Join-Path $root "VC\Tools\MSVC") | Select-Object -First 1).Name
$sdkv  = (Get-ChildItem (Join-Path $root "Windows Kits\10\bin") | Where-Object { $_.Name -like "10.*" } | Select-Object -First 1).Name

$env:VCToolsInstallDir = "$root\VC\Tools\MSVC\$msvcv\"
$env:WindowsSdkBinPath = "$root\Windows Kits\10\bin\"
$env:VSCMD_ARG_HOST_ARCH = "x64"
$env:VSCMD_ARG_TGT_ARCH = "x64"
$env:PATH = "$root\VC\Tools\MSVC\$msvcv\bin\Hostx64\x64;$root\Windows Kits\10\bin\$sdkv\x64;$root\Windows Kits\10\bin\$sdkv\x64\ucrt;$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:INCLUDE = "$root\VC\Tools\MSVC\$msvcv\include;$root\Windows Kits\10\Include\$sdkv\ucrt;$root\Windows Kits\10\Include\$sdkv\shared;$root\Windows Kits\10\Include\$sdkv\um;$root\Windows Kits\10\Include\$sdkv\winrt;$root\Windows Kits\10\Include\$sdkv\cppwinrt"
$env:LIB = "$root\VC\Tools\MSVC\$msvcv\lib\x64;$root\Windows Kits\10\Lib\$sdkv\ucrt\x64;$root\Windows Kits\10\Lib\$sdkv\um\x64"
Write-Host "MSVC $msvcv / SDK $sdkv / cargo ready" -ForegroundColor DarkYellow

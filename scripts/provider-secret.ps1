param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('protect', 'unprotect')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputValue = [Console]::In.ReadToEnd()

if ($Action -eq 'protect') {
  $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($inputValue)
  $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
    $plainBytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::Out.Write([Convert]::ToBase64String($protectedBytes))
  exit 0
}

$encryptedBytes = [Convert]::FromBase64String($inputValue.Trim())
$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $encryptedBytes,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plainBytes))

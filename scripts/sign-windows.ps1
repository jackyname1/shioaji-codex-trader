param([Parameter(Mandatory=$true)][string]$FilePath,[ValidateSet('none','pfx','store')][string]$Mode='none')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$certificate=$null;$imported=$false;$temporary=$null
$stage='certificate';$status='not_checked'
try {
  if ($Mode -eq 'pfx') {
    if (!$env:WINDOWS_SIGNING_PFX_BASE64 -or !$env:WINDOWS_SIGNING_PFX_PASSWORD) { throw 'Code-signing certificate or password is missing.' }
    $temporary=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString()+'.pfx')
    [IO.File]::WriteAllBytes($temporary,[Convert]::FromBase64String($env:WINDOWS_SIGNING_PFX_BASE64))
    $password=ConvertTo-SecureString $env:WINDOWS_SIGNING_PFX_PASSWORD -AsPlainText -Force
    $certificate=Import-PfxCertificate -FilePath $temporary -Password $password -CertStoreLocation Cert:\CurrentUser\My
    $certificate=@($certificate | Where-Object {$_.HasPrivateKey})[0]
    $imported=$true
  } elseif ($Mode -eq 'store') {
    $thumbprint=$env:WINDOWS_SIGNING_CERTIFICATE_SHA1
    if ($thumbprint -notmatch '^[a-fA-F0-9]{40}$') { throw 'Code-signing certificate thumbprint is invalid.' }
    $certificate=Get-Item ('Cert:\CurrentUser\My\'+$thumbprint)
  }
  if ($Mode -ne 'none') {
    if (!$certificate -or !$certificate.HasPrivateKey) { throw 'Code-signing private key is unavailable.' }
    $codeSigning=@($certificate.EnhancedKeyUsageList | Where-Object {$_.ObjectId -eq '1.3.6.1.5.5.7.3.3'}).Count -gt 0
    if (!$codeSigning) { throw 'This is not a code-signing certificate; a Shioaji CA cannot sign the Windows application.' }
    if ($certificate.Subject -eq $certificate.Issuer -or !$certificate.Verify()) { throw 'A publicly trusted code-signing certificate is required.' }
    if ($certificate.NotAfter -le (Get-Date) -or $certificate.NotBefore -gt (Get-Date)) { throw 'Code-signing certificate is not currently valid.' }
    $tools=Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" | Sort-Object FullName -Descending
    if (!$tools) { throw 'Install Windows SDK SignTool before signing.' }
    # Password never appears in argv. The temporary non-exportable certificate is accessed by its public thumbprint.
    $null=& $tools[0].FullName sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /sha1 $certificate.Thumbprint $FilePath 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Windows code signing failed.' }
  }
  $stage='read_signature'
  $signature=Get-AuthenticodeSignature -FilePath $FilePath
  $status=$signature.Status.ToString()
  $stage='verify_signature'
  $trusted=$signature.Status -eq 'Valid'
  $timestamped=$null -ne $signature.TimeStamperCertificate
  $eku=$trusted -and @($signature.SignerCertificate.EnhancedKeyUsageList | Where-Object {$_.ObjectId -eq '1.3.6.1.5.5.7.3.3'}).Count -gt 0
  if ($Mode -ne 'none' -and (!$trusted -or !$timestamped -or !$eku)) { throw 'The publisher signature or trusted timestamp could not be verified.' }
  if ($Mode -eq 'none' -and $signature.Status -ne 'NotSigned') { throw 'An unexpected signature exists on the unsigned build.' }
  $stage='report_hash'
  [PSCustomObject]@{
    name=[IO.Path]::GetFileName($FilePath);sha256=(Get-FileHash $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
    status=$signature.Status.ToString();timestamped=$timestamped;code_signing=[bool]$eku
    publisher=$(if($trusted){$signature.SignerCertificate.Subject}else{$null})
    thumbprint=$(if($trusted){$signature.SignerCertificate.Thumbprint}else{$null})
  } | ConvertTo-Json -Compress
} catch {
  # No native signer exception or credential material is printed.
  [Console]::Error.WriteLine(('Windows signature verification failed at {0}; Authenticode status: {1}. Check the code-signing certificate, trusted chain, timestamp and SDK configuration.' -f $stage,$status))
  exit 1
} finally {
  if ($temporary -and (Test-Path $temporary)) { Remove-Item -Force $temporary }
  if ($imported -and $certificate) { Remove-Item ('Cert:\CurrentUser\My\'+$certificate.Thumbprint) -Force -ErrorAction SilentlyContinue }
}

<#
.SYNOPSIS
    Crea el acceso directo en el Escritorio que abre el dashboard.

.DESCRIPTION
    Doble clic: si la app no corre la arranca; si corre pero el .exe es mas nuevo,
    la reinicia para tomar la version nueva; si ya corre la version actual, solo
    abre otra pestana.
#>

param(
    [string]$PublishPath = (Join-Path (Split-Path $PSScriptRoot -Parent) "publish"),
    [string]$DashboardUrl = "http://localhost:5020"
)

$ErrorActionPreference = "Stop"

$exePath = Join-Path $PublishPath "PeticionCambioDomicilio.exe"
if (-not (Test-Path $exePath)) {
    throw "No se encontro $exePath. Ejecuta primero: .\deploy\publish.ps1"
}

$launcherPath = Join-Path $PublishPath "abrir-dashboard.ps1"
$launcher = @"
`$exe = Join-Path `$PSScriptRoot 'PeticionCambioDomicilio.exe'
`$corriendo = Get-Process -Name 'PeticionCambioDomicilio' -ErrorAction SilentlyContinue
if (`$corriendo -and (Get-Item `$exe).LastWriteTime -gt `$corriendo.StartTime) {
    `$corriendo | Stop-Process -Force
    Start-Sleep -Milliseconds 800
    `$corriendo = `$null
}
if (-not `$corriendo) {
    Start-Process -FilePath `$exe -ArgumentList '--open-browser' -WorkingDirectory `$PSScriptRoot -WindowStyle Hidden
} else {
    Start-Process '$DashboardUrl'
}
"@
Set-Content -Path $launcherPath -Value $launcher -Encoding UTF8

$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "Peticion Cambio Domicilio - Dashboard.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`""
$shortcut.WorkingDirectory = $PublishPath
$shortcut.Description = "Abrir el dashboard de Peticion de Cambio de Domicilio"
$shortcut.IconLocation = "$exePath,0"
$shortcut.Save()

Write-Host "Acceso directo creado en: $shortcutPath" -ForegroundColor Green

<#
.SYNOPSIS
    Crea el acceso directo en el Escritorio que abre el dashboard.

.DESCRIPTION
    Doble clic: si la app no esta corriendo la arranca (sin ventana de consola) y abre
    la pestana; si ya corre, solo abre otra pestana. Arrancarla dos veces dejaria dos
    procesos peleando por el mismo puerto.
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
$launcherContent = @"
`$running = Get-Process -Name "PeticionCambioDomicilio" -ErrorAction SilentlyContinue
if (-not `$running) {
    Start-Process -FilePath "$exePath" -ArgumentList "--open-browser" -WorkingDirectory "$PublishPath" -WindowStyle Hidden
} else {
    Start-Process "$DashboardUrl"
}
"@
Set-Content -Path $launcherPath -Value $launcherContent -Encoding UTF8

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
Write-Host "Doble clic: arranca la app si no corre y abre $DashboardUrl"

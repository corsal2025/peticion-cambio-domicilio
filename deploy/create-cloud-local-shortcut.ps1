<#
.SYNOPSIS
    Crea el acceso directo en el Escritorio que abre la version Cloudflare en local.

.DESCRIPTION
    Apunta a ABRIR-CLOUD-LOCAL.bat (wrangler pages dev + base D1 local).
    No publica nada en Cloudflare. Se puede volver a correr: sobrescribe el acceso.
#>

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$launcher = Join-Path $root "ABRIR-CLOUD-LOCAL.bat"
if (-not (Test-Path $launcher)) {
    throw "No se encontro $launcher"
}

$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "Peticion Cambio Domicilio - Cloud local.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $root
$shortcut.Description = "Dashboard version Cloudflare corriendo en local"
$shortcut.IconLocation = (Join-Path $root "src\PeticionCambioDomicilio\logo-municipal.ico") + ",0"
$shortcut.Save()

Write-Host "Acceso directo creado en: $shortcutPath" -ForegroundColor Green

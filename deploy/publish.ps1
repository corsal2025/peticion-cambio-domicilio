<#
.SYNOPSIS
    Publica PeticionCambioDomicilio como un unico .exe autocontenido y crea el acceso directo.

.DESCRIPTION
    El equipo donde corre no necesita el SDK de .NET: el .exe lleva el runtime dentro.
    Copia appsettings.Local.json (con la clave del buzon) junto al .exe si existe.

.PARAMETER Shortcut
    Ademas de publicar, crea el acceso directo en el Escritorio.
#>

$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$project = Join-Path $root "src\PeticionCambioDomicilio\PeticionCambioDomicilio.csproj"
$publishPath = Join-Path $root "publish"

# Detener proceso previo si esta en ejecucion para no bloquear la sobreescritura del .exe
$corriendo = Get-Process -Name "PeticionCambioDomicilio" -ErrorAction SilentlyContinue
if ($corriendo) {
    Write-Host "Deteniendo instancia anterior de PeticionCambioDomicilio..." -ForegroundColor Yellow
    $corriendo | Stop-Process -Force
    Start-Sleep -Milliseconds 800
}

Write-Host "Publicando .exe autocontenido..." -ForegroundColor Cyan

dotnet publish $project `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $publishPath

if ($LASTEXITCODE -ne 0) { throw "dotnet publish fallo con codigo $LASTEXITCODE" }

# La configuracion local (clave del buzon, ruta del Excel) no la copia dotnet publish.
$localConfig = Join-Path $root "src\PeticionCambioDomicilio\appsettings.Local.json"
if (Test-Path $localConfig) {
    Copy-Item $localConfig (Join-Path $publishPath "appsettings.Local.json") -Force
    Write-Host "appsettings.Local.json copiado al publish." -ForegroundColor Green
} else {
    Write-Warning "No hay appsettings.Local.json: la app arrancara sin correo EWS configurado."
}

# Copia instalador para pendrive
Copy-Item (Join-Path $PSScriptRoot "INSTALAR.bat") (Join-Path $publishPath "INSTALAR.bat") -Force
Copy-Item (Join-Path $PSScriptRoot "instalar.ps1") (Join-Path $publishPath "instalar.ps1") -Force
Write-Host "Instalador de pendrive (INSTALAR.bat) copiado al publish." -ForegroundColor Green

Write-Host ""
Write-Host "Publicado en: $publishPath" -ForegroundColor Green
Write-Host "Ejecutable:   $(Join-Path $publishPath 'PeticionCambioDomicilio.exe')"

# Siempre regenera el lanzador (vive dentro de publish/ y se borra al republicar).
& (Join-Path $PSScriptRoot "create-desktop-shortcut.ps1") -PublishPath $publishPath


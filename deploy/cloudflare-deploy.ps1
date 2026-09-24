<#
.SYNOPSIS
    Publica la app en Cloudflare (pasos 1-5 de DEPLOY-CLOUDFLARE.md) en una sola corrida.

.DESCRIPTION
    - Aplica el esquema en la base D1 remota (ya creada: peticion-cambio-domicilio-db).
    - Regenera y sube los datos reales (peticiones + comunas) desde publish/data.
    - Crea el proyecto Pages, publica y configura los secrets.
    - Genera claves nuevas al azar y las deja en CLAVES-CLOUDFLARE.txt (NO se sube a git).
    Se puede volver a correr: si el proyecto o los datos ya existen, avisa y sigue.
#>

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$proyecto = "peticion-cambio-domicilio"
$db = "peticion-cambio-domicilio-db"
$clavesPath = Join-Path $root "CLAVES-CLOUDFLARE.txt"

function Nueva-Clave([int]$bytes = 32) {
    $b = New-Object byte[] $bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    return ([Convert]::ToBase64String($b)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Paso($texto) { Write-Host ""; Write-Host "==> $texto" -ForegroundColor Cyan }

# Claves: se reutilizan si ya se generaron antes (para no romper Apps Script / relay ya configurados).
if (Test-Path $clavesPath) {
    $claves = @{}
    Get-Content $clavesPath | Where-Object { $_ -match '^([A-Z_]+)=(.+)$' } | ForEach-Object { $claves[$Matches[1]] = $Matches[2] }
    Write-Host "Usando claves existentes de CLAVES-CLOUDFLARE.txt" -ForegroundColor Yellow
} else {
    $claves = @{
        SESSION_SECRET = Nueva-Clave 48
        MASTER_PIN     = Nueva-Clave 12
        IMPORT_SECRET  = Nueva-Clave 32
        RELAY_SECRET   = Nueva-Clave 32
    }
    $claves.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" } | Set-Content -Encoding utf8 $clavesPath
    Write-Host "Claves nuevas guardadas en CLAVES-CLOUDFLARE.txt" -ForegroundColor Green
}

Paso "1/5 Esquema en D1 remota"
npx wrangler d1 migrations apply $db --remote
if ($LASTEXITCODE -ne 0) { throw "Fallo al aplicar migraciones" }

Paso "2/5 Datos reales (regenera la semilla desde publish/data)"
node scripts/export-d1-seed.js
if ($LASTEXITCODE -ne 0) { throw "Fallo al generar la semilla" }
$yaHay = npx wrangler d1 execute $db --remote --json --command "SELECT COUNT(*) AS n FROM peticiones" | ConvertFrom-Json
if ($yaHay[0].results[0].n -gt 0) {
    Write-Warning "La base remota ya tiene $($yaHay[0].results[0].n) peticiones: NO se vuelve a cargar la semilla."
} else {
    npx wrangler d1 execute $db --remote --file=migrations/seed/0002_datos.sql
    if ($LASTEXITCODE -ne 0) { throw "Fallo al cargar los datos" }
}

Paso "3/5 Proyecto Pages"
npx wrangler pages project create $proyecto --production-branch main
if ($LASTEXITCODE -ne 0) { Write-Warning "El proyecto ya existia (o no se pudo crear): se sigue con el deploy." }

Paso "4/5 Secrets"
foreach ($nombre in "SESSION_SECRET", "MASTER_PIN", "IMPORT_SECRET", "RELAY_SECRET") {
    $claves[$nombre] | npx wrangler pages secret put $nombre --project-name=$proyecto
    if ($LASTEXITCODE -ne 0) { throw "Fallo al guardar el secret $nombre" }
}

Paso "5/5 Publicar"
npx wrangler pages deploy public --project-name=$proyecto --branch main --commit-dirty=true
if ($LASTEXITCODE -ne 0) { throw "Fallo el deploy" }

Write-Host ""
Write-Host "LISTO." -ForegroundColor Green
Write-Host "URL:        https://$proyecto.pages.dev"
Write-Host "Usuario:    admin"
Write-Host "Clave:      MASTER_PIN de CLAVES-CLOUDFLARE.txt"
Write-Host "Apps Script -> IMPORT_SECRET ; relay (.exe --relay) -> RELAY_SECRET (ver CLAVES-CLOUDFLARE.txt)"

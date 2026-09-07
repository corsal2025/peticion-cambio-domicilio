<#
.SYNOPSIS
    Instalador y configurador de red para Petición de Cambio de Domicilio.
#>

$ErrorActionPreference = "Continue"

function Is-Admin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($current)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Elevate-If-Needed {
    if (-not (Is-Admin)) {
        Write-Host "Elevando privilegios para configuración de red y firewall..." -ForegroundColor Yellow
        $scriptPath = $MyInvocation.MyCommand.Definition
        Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
        exit
    }
}

function Get-LocalIP {
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
        $_.InterfaceAlias -notmatch 'Loopback' -and
        $_.IPAddress -notmatch '^169\.254\.' -and
        $_.IPAddress -notmatch '^127\.'
    }
    if ($ips) {
        return ($ips | Select-Object -First 1).IPAddress
    }
    return "127.0.0.1"
}

function Install-Server {
    Elevate-If-Needed

    Clear-Host
    Write-Host "======================================================================" -ForegroundColor Cyan
    Write-Host "       INSTALANDO COMO SERVIDOR PRINCIPAL (PC CENTRAL)                " -ForegroundColor Cyan
    Write-Host "======================================================================" -ForegroundColor Cyan
    Write-Host ""

    $sourceDir = $PSScriptRoot
    $targetDir = "C:\PeticionCambioDomicilio"

    Write-Host "[1/5] Preparando carpeta de instalación en $targetDir..." -ForegroundColor Yellow
    if (-not (Test-Path $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }

    # Detener si ya corría
    Get-Process -Name 'PeticionCambioDomicilio' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800

    Write-Host "[2/5] Copiando archivos de la aplicación..." -ForegroundColor Yellow
    
    # Copiar binarios y assets (no sobreescribir peticiones.db si ya existe)
    Get-ChildItem -Path $sourceDir -Exclude "peticiones.db", "appsettings.Local.json", "*.log" | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $targetDir -Recurse -Force
    }

    # Preservar o inicializar appsettings.Local.json
    $targetLocalConfig = Join-Path $targetDir "appsettings.Local.json"
    $sourceLocalConfig = Join-Path $sourceDir "appsettings.Local.json"
    if (-not (Test-Path $targetLocalConfig) -and (Test-Path $sourceLocalConfig)) {
        Copy-Item -Path $sourceLocalConfig -Destination $targetLocalConfig -Force
        Write-Host "      Configuración local inicializada." -ForegroundColor Green
    } else {
        Write-Host "      Configuración local existente preservada." -ForegroundColor Green
    }

    # Preservar o inicializar base de datos
    $targetDb = Join-Path $targetDir "data\peticiones.db"
    $sourceDb = Join-Path $sourceDir "data\peticiones.db"
    if (-not (Test-Path $targetDb) -and (Test-Path $sourceDb)) {
        New-Item -ItemType Directory -Path (Split-Path $targetDb -Parent) -Force -ErrorAction SilentlyContinue | Out-Null
        Copy-Item -Path $sourceDb -Destination $targetDb -Force
        Write-Host "      Base de datos inicializada desde el instalador." -ForegroundColor Green
    } else {
        Write-Host "      Base de datos existente PRESERVADA (no se sobreescribió)." -ForegroundColor Green
    }

    Write-Host "[3/5] Configurando Firewall de Windows para permitir acceso en red..." -ForegroundColor Yellow
    try {
        netsh advfirewall firewall delete rule name="Peticion Cambio Domicilio (Puerto 5020)" | Out-Null
        netsh advfirewall firewall add rule name="Peticion Cambio Domicilio (Puerto 5020)" dir=in action=allow protocol=TCP localport=5020 | Out-Null
        Write-Host "      Regla de Firewall creada exitosamente (TCP 5020)." -ForegroundColor Green
    } catch {
        Write-Warning "No se pudo crear la regla de firewall automáticamente: $($_.Exception.Message)"
    }

    Write-Host "[4/5] Detectando dirección IP de este equipo..." -ForegroundColor Yellow
    $localIp = Get-LocalIP
    Write-Host "      IP detectada: $localIp" -ForegroundColor Green

    # Guardar en el pendrive para que PC 2 y 3 no tengan que tipear nada
    try {
        $ipFile = Join-Path $sourceDir "IP_SERVIDOR.txt"
        Set-Content -Path $ipFile -Value $localIp -Encoding UTF8 -Force
        Write-Host "      Archivo IP_SERVIDOR.txt guardado en el pendrive para auto-configurar a tus compañeros." -ForegroundColor Green
    } catch {
        # El pendrive podría ser de solo lectura
    }

    Write-Host "[5/5] Creando acceso directo en el Escritorio..." -ForegroundColor Yellow
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktopPath "Peticion Cambio Domicilio - Dashboard.lnk"
    $launcherPath = Join-Path $targetDir "abrir-dashboard.ps1"
    $exePath = Join-Path $targetDir "PeticionCambioDomicilio.exe"

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "powershell.exe"
    $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`""
    $shortcut.WorkingDirectory = $targetDir
    $shortcut.Description = "Abrir el dashboard de Peticion de Cambio de Domicilio"
    $shortcut.IconLocation = "$exePath,0"
    $shortcut.Save()

    # Arrancar la app
    Start-Process -FilePath $exePath -ArgumentList '--open-browser' -WorkingDirectory $targetDir -WindowStyle Hidden

    Write-Host ""
    Write-Host "======================================================================" -ForegroundColor Green
    Write-Host "       ¡INSTALACIÓN DE SERVIDOR PRINCIPAL COMPLETADA!                 " -ForegroundColor Green
    Write-Host "======================================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Este computador es el SERVIDOR CENTRAL y aloja la base de datos única."
    Write-Host "  Dirección de acceso local:     http://localhost:5020"
    Write-Host "  Dirección para tus compañeros: http://$($localIp):5020" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  INSTRUCCIONES PARA TUS COMPAÑEROS:" -ForegroundColor Yellow
    Write-Host "  1. Lleva este mismo pendrive a sus computadores."
    Write-Host "  2. Haz doble clic en INSTALAR.bat."
    Write-Host "  3. Elige la Opción [2] (Puesto de Trabajo)."
    Write-Host "     (El pendrive ya lleva memorizada la IP $localIp automáticamente)."
    Write-Host ""
    Write-Host "Presiona cualquier tecla para finalizar..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

function Install-Client {
    Clear-Host
    Write-Host "======================================================================" -ForegroundColor Cyan
    Write-Host "       CONECTAR COMO PUESTO DE TRABAJO (COMPAÑERO)                   " -ForegroundColor Cyan
    Write-Host "======================================================================" -ForegroundColor Cyan
    Write-Host ""

    $sourceDir = $PSScriptRoot
    $ipFile = Join-Path $sourceDir "IP_SERVIDOR.txt"
    $defaultIp = ""
    if (Test-Path $ipFile) {
        $defaultIp = (Get-Content $ipFile -Raw).Trim()
    }

    if ($defaultIp) {
        Write-Host "Se detectó la IP del PC Principal desde el pendrive: $defaultIp" -ForegroundColor Green
        $prompt = "Presiona ENTER para usar [$defaultIp] o escribe la IP del PC Principal: "
        $userIp = Read-Host $prompt
        if (-not $userIp) {
            $userIp = $defaultIp
        }
    } else {
        $userIp = Read-Host "Ingresa la dirección IP del PC Principal (ejemplo: 192.168.1.50)"
    }

    if (-not $userIp) {
        Write-Host "No se ingresó IP. Operación cancelada." -ForegroundColor Red
        Start-Sleep -Seconds 3
        return
    }

    $serverUrl = "http://$($userIp.Trim()):5020"
    Write-Host ""
    Write-Host "Probando conexión con el Servidor Principal en $serverUrl..." -ForegroundColor Yellow
    $reachable = $false
    try {
        $req = [System.Net.WebRequest]::Create($serverUrl)
        $req.Timeout = 3000
        $res = $req.GetResponse()
        $res.Close()
        $reachable = $true
        Write-Host "¡Conexión exitosa con el PC Principal!" -ForegroundColor Green
    } catch {
        Write-Warning "No se pudo verificar la conexión inmediatamente. Verifica que el PC Principal esté encendido y con el sistema abierto."
    }

    Write-Host ""
    Write-Host "Creando acceso directo en el Escritorio..." -ForegroundColor Yellow
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktopPath "Peticion Cambio Domicilio - Dashboard.lnk"
    
    $clientDir = "$env:LOCALAPPDATA\PeticionCambioDomicilioCliente"
    if (-not (Test-Path $clientDir)) {
        New-Item -ItemType Directory -Path $clientDir -Force | Out-Null
    }

    $iconSource = Join-Path $sourceDir "PeticionCambioDomicilio.exe"
    if (Test-Path $iconSource) {
        Copy-Item $iconSource (Join-Path $clientDir "PeticionCambioDomicilio.exe") -Force -ErrorAction SilentlyContinue
    }

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "powershell.exe"
    $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -Command `"Start-Process '$serverUrl'`""
    $shortcut.Description = "Petición de Cambio de Domicilio - Conectado a $serverUrl"
    if (Test-Path (Join-Path $clientDir "PeticionCambioDomicilio.exe")) {
        $shortcut.IconLocation = (Join-Path $clientDir "PeticionCambioDomicilio.exe") + ",0"
    }
    $shortcut.Save()

    # Abrir inmediatamente en el navegador
    Start-Process $serverUrl

    Write-Host ""
    Write-Host "======================================================================" -ForegroundColor Green
    Write-Host "       ¡PUESTO DE TRABAJO CONFIGURADO CON ÉXITO!                     " -ForegroundColor Green
    Write-Host "======================================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Este computador quedó conectado en línea al Servidor Principal:"
    Write-Host "  $serverUrl" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Se creó el acceso directo en el Escritorio."
    Write-Host "  Todos los cambios, marcas y envíos se reflejan en tiempo real para todos."
    Write-Host ""
    Write-Host "Presiona cualquier tecla para finalizar..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

# --- MENÚ PRINCIPAL ---
Clear-Host
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "        SISTEMA PETICIÓN DE CAMBIO DE DOMICILIO                       " -ForegroundColor White
Write-Host "             Instalador Automático para Pendrive                      " -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Selecciona cómo deseas configurar este computador:"
Write-Host ""
Write-Host "  [1] PC PRINCIPAL (Servidor Central)" -ForegroundColor Yellow
Write-Host "      Instala el sistema completo en este equipo, aloja la base de datos"
Write-Host "      única, abre el firewall y guarda la IP en el pendrive."
Write-Host ""
Write-Host "  [2] PUESTO DE TRABAJO (Compañero)" -ForegroundColor Green
Write-Host "      Conecta este computador al PC Principal para trabajar en línea"
Write-Host "      en conjunto sobre la misma base de datos en tiempo real."
Write-Host ""
Write-Host "  [3] Salir"
Write-Host ""
$opcion = Read-Host "Ingresa tu opción (1, 2 o 3)"

switch ($opcion) {
    "1" { Install-Server }
    "2" { Install-Client }
    default { Write-Host "Saliendo sin realizar cambios." }
}

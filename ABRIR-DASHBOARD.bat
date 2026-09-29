@echo off
REM Abre el dashboard de Peticion de Cambio de Domicilio.
cd /d "%~dp0publish"

if exist "abrir-dashboard.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish\abrir-dashboard.ps1"
) else (
    cd /d "%~dp0src\PeticionCambioDomicilio"
    start "" http://localhost:5020
    dotnet run -c Release
)

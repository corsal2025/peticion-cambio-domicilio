@echo off
REM Abre el dashboard Peticion de Cambio de Domicilio.
REM Doble clic en este archivo.

cd /d "%~dp0src\PeticionCambioDomicilio"

echo Compilando y levantando el dashboard...
echo.

start "" http://localhost:5020

dotnet run -c Release

echo.
echo El dashboard se cerro. Podes cerrar esta ventana.
pause

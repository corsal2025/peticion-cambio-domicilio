@echo off
REM Abre la version Cloudflare del dashboard EN LOCAL (no publica nada).
REM Usa la base D1 local de .wrangler/ y las variables de .dev.vars.
cd /d "%~dp0"
title Peticion Cambio Domicilio - Cloud local
echo Levantando dashboard local en http://localhost:8788 ...
echo No cierres esta ventana mientras uses el dashboard.
echo.
start "" cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:8788/login"
call npx wrangler pages dev public --port 8788
pause

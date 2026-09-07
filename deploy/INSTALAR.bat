@echo off
REM ====================================================================
REM  INSTALADOR DE PETICION DE CAMBIO DE DOMICILIO PARA PENDRIVE
REM ====================================================================
title Instalador - Peticion de Cambio de Domicilio
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1"

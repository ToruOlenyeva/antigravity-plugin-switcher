@echo off
chcp 65001 >nul
title Antigravity Plugin Switcher Console

set PORT=8088
set SIDECAR_DIR=%~dp0sidecars\panel

:: Check if port 8088 is listening
powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 8088 -State Listen -ErrorAction SilentlyContinue)" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [PluginSwitcher] Starting Sidecar service in background (Port 8088)...
    powershell -NoProfile -Command "Start-Process node -ArgumentList 'main.mjs' -WorkingDirectory '%SIDECAR_DIR%' -WindowStyle Hidden"
    timeout /t 1 /nobreak >nul
)

:: Open web console in standalone Edge app window
start "" msedge --app=http://127.0.0.1:8088 --window-size=420,760

exit

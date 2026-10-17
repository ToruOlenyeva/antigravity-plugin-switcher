@echo off
chcp 65001 >nul
title 项目插件开关控制台

set PORT=8088
set SIDECAR_DIR=%~dp0sidecars\panel

:: 检查 8088 端口是否已在监听
powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 8088 -State Listen -ErrorAction SilentlyContinue)" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [PluginSwitcher] 正在后台启动插件开关 Sidecar 服务 (Port 8088)...
    powershell -NoProfile -Command "Start-Process node -ArgumentList 'main.mjs' -WorkingDirectory '%SIDECAR_DIR%' -WindowStyle Hidden"
    timeout /t 1 /nobreak >nul
)

:: 使用 Edge 应用小窗模式打开面板
start "" msedge --app=http://127.0.0.1:8088 --window-size=420,760

exit

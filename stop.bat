@echo off
setlocal enabledelayedexpansion
title Stop LeadSquared CRM and WhatsApp Gateway
cd /d "%~dp0"
color 0E

echo ================================================================
echo   Stopping LeadSquared CRM on Port 3000 and OpenWA on Port 2785
echo ================================================================
echo.

:: Stop CRM Server on port 3000
set FOUND_CRM=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    set FOUND_CRM=1
    echo [INFO] Stopping CRM server with PID %%a on port 3000...
    taskkill /f /t /pid %%a >nul 2>&1
)
if "!FOUND_CRM!"=="0" (
    echo [INFO] No CRM server was running on port 3000.
) else (
    echo [OK] CRM server on port 3000 stopped.
)

:: Stop OpenWA Gateway on port 2785
set FOUND_OWA=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":2785" ^| findstr "LISTENING"') do (
    set FOUND_OWA=1
    echo [INFO] Stopping OpenWA Gateway with PID %%a on port 2785...
    taskkill /f /t /pid %%a >nul 2>&1
)
if "!FOUND_OWA!"=="0" (
    echo [INFO] No OpenWA Gateway was running on port 2785.
) else (
    echo [OK] OpenWA Gateway on port 2785 stopped.
)

echo.
echo [OK] All LeadSquared CRM services stopped cleanly.
echo.
ping 127.0.0.1 -n 2 >nul 2>&1

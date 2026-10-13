@echo off
setlocal
title Restart LeadSquared CRM & WhatsApp Gateway
cd /d "%~dp0"
color 0E

echo ================================================================
echo   Restarting LeadSquared CRM + WhatsApp Automation Services...
echo ================================================================
echo.

call "%~dp0stop.bat"
echo.
echo [INFO] Starting LeadSquared CRM and OpenWA Gateway...
ping 127.0.0.1 -n 2 >nul 2>&1
call "%~dp0start.bat" %*

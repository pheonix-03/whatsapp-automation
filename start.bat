@echo off
setlocal enabledelayedexpansion
title LeadSquared CRM + WhatsApp Automation Engine
cd /d "%~dp0"
color 0B

:: Handle subcommands: stop, restart, status, help
if /i "%~1"=="stop" goto CMD_STOP
if /i "%~1"=="restart" goto CMD_RESTART
if /i "%~1"=="status" goto CMD_STATUS
if /i "%~1"=="help" goto CMD_HELP
if /i "%~1"=="--help" goto CMD_HELP
if /i "%~1"=="-h" goto CMD_HELP

echo ================================================================
echo   * LeadSquared CRM Clone + WhatsApp Automation Engine *
echo ================================================================
echo.

:: 1. Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% equ 0 goto NODE_FOUND
color 0C
echo [ERROR] Node.js is not installed or not in your system PATH!
echo Please download and install Node.js from https://nodejs.org/
echo.
pause
exit /b 1

:NODE_FOUND
for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VERSION=%%v
echo [SYSTEM] Node.js runtime: %NODE_VERSION%
echo.

:: 2. Check CRM dependencies
if exist "node_modules\" goto CRM_DEPS_OK
echo [INFO] Installing LeadSquared CRM packages via npm install...
call npm.cmd install
if %ERRORLEVEL% equ 0 goto CRM_NPM_OK
color 0C
echo [ERROR] npm install failed. Please check your network connection.
pause
exit /b 1

:CRM_NPM_OK
echo [OK] CRM packages installed successfully.
echo.

:CRM_DEPS_OK
:: 3. Check OpenWA dependencies and build
if not exist "OpenWA\" goto OPENWA_SETUP_DONE
if exist "OpenWA\node_modules\" goto OWA_DEPS_OK
echo [INFO] Installing OpenWA Gateway packages...
cd /d "%~dp0OpenWA"
call npm.cmd install
cd /d "%~dp0"
echo [OK] OpenWA dependencies installed.
echo.

:OWA_DEPS_OK
if exist "OpenWA\dist\main.js" goto OPENWA_SETUP_DONE
echo [INFO] Building OpenWA Gateway from source...
cd /d "%~dp0OpenWA"
call npm.cmd run build
cd /d "%~dp0"
echo [OK] OpenWA Gateway built successfully.
echo.

:OPENWA_SETUP_DONE
:: 4. Check & Launch OpenWA WhatsApp API Gateway (Port 2785)
echo [1/3] Checking OpenWA WhatsApp API Gateway - Port 2785...
set OPENWA_PID=
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":2785" ^| findstr "LISTENING"') do set OPENWA_PID=%%a

if defined OPENWA_PID goto OWA_ALREADY_UP

if not exist "%~dp0OpenWA\dist\main.js" goto OWA_NO_BUILD

echo   [INFO] Launching OpenWA WhatsApp Gateway in background...
start "OpenWA WhatsApp Gateway (Port 2785)" /D "%~dp0OpenWA" /MIN cmd /c "title OpenWA WhatsApp Gateway & node dist/main.js"
echo   [INFO] Initializing OpenWA API Gateway...

set /a RETRIES=0
:WAIT_OWA_LOOP
set /a RETRIES+=1
set OPENWA_PID=
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":2785" ^| findstr "LISTENING"') do set OPENWA_PID=%%a
if defined OPENWA_PID goto OWA_IS_READY
if %RETRIES% geq 25 goto OWA_TIMEOUT
ping 127.0.0.1 -n 2 >nul 2>&1
goto WAIT_OWA_LOOP

:OWA_TIMEOUT
echo   [WARN] OpenWA Gateway took longer than expected to start. Continuing in background...
goto OWA_LAUNCH_DONE

:OWA_IS_READY
echo   [OK] OpenWA Gateway is ready - PID: %OPENWA_PID% at http://localhost:2785/api
goto OWA_LAUNCH_DONE

:OWA_NO_BUILD
echo   [WARN] OpenWA build not found at OpenWA\dist\main.js. Run setup_openwa.bat if needed.
goto OWA_LAUNCH_DONE

:OWA_ALREADY_UP
echo   [OK] OpenWA Gateway is active - PID: %OPENWA_PID% at http://localhost:2785/api

:OWA_LAUNCH_DONE
echo.

:: 5. Check and prepare LeadSquared CRM Server (Port 3000)
echo [2/3] Checking LeadSquared CRM Server - Port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo   [INFO] Freeing existing server on port 3000 - PID %%a...
    taskkill /f /t /pid %%a >nul 2>&1
    ping 127.0.0.1 -n 2 >nul 2>&1
)
echo   [OK] Port 3000 is ready.
echo.

:: 6. Launch browser dashboard
echo [3/3] Opening Web Dashboard...
if "%~1"=="--no-browser" goto SKIP_BROWSER
echo   [INFO] Launching http://localhost:3000 in your browser...
start "" cmd /c "ping 127.0.0.1 -n 3 >nul 2>&1 & start http://localhost:3000"
goto BROWSER_DONE

:SKIP_BROWSER
echo   [INFO] Browser auto-open skipped.

:BROWSER_DONE
echo.
echo ================================================================
echo   CRM Web App:    http://localhost:3000
echo   WhatsApp API:   http://localhost:2785/api
echo   Swagger Docs:   http://localhost:2785/api/docs
echo.
echo   * Press Ctrl+C at any time in this window to stop the CRM.
echo   * To stop all background services: run stop.bat
echo   * To restart everything: run restart.bat
echo ================================================================
echo.

:: 7. Start CRM Server in foreground
node server.js

if %ERRORLEVEL% equ 0 exit /b 0
echo.
color 0C
echo ================================================================
echo [ERROR] Server exited with code %ERRORLEVEL%.
echo ================================================================
pause
exit /b %ERRORLEVEL%

:: Subcommand handlers
:CMD_STOP
call "%~dp0stop.bat"
exit /b 0

:CMD_RESTART
call "%~dp0stop.bat"
echo.
echo [INFO] Restarting services...
ping 127.0.0.1 -n 2 >nul 2>&1
call "%~dp0start.bat"
exit /b 0

:CMD_STATUS
echo ================================================================
echo   LeadSquared CRM and WhatsApp System Status
echo ================================================================
echo.
set STATUS_CRM=OFFLINE
set STATUS_OWA=OFFLINE

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do set STATUS_CRM=ONLINE - PID: %%a
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":2785" ^| findstr "LISTENING"') do set STATUS_OWA=ONLINE - PID: %%a

echo   LeadSquared CRM on Port 3000:  %STATUS_CRM%
echo   OpenWA Gateway on Port 2785:   %STATUS_OWA%
echo.
if not exist "leadsquared.db" goto STATUS_NO_DB
node -e "try { const openwa = require('./openwa_api'); openwa.loadConfig().then(() => openwa.getSessionDetails()).then(d => console.log('   WhatsApp Session:              [' + d.status.toUpperCase() + '] Phone: ' + (d.phone || 'not linked'))).catch(() => console.log('   WhatsApp Session:              [DISCONNECTED]')); } catch (e) { console.log('   WhatsApp Session:              [UNKNOWN]'); }" 2>nul
:STATUS_NO_DB
echo.
echo ================================================================
pause
exit /b 0

:CMD_HELP
echo Usage: start.bat [command]
echo.
echo Commands:
echo   (no args)       Start all services and open web browser (default)
echo   --no-browser    Start all services without opening browser
echo   stop            Stop all services (CRM + OpenWA Gateway)
echo   restart         Restart all services cleanly
echo   status          Show live status of CRM, OpenWA and WhatsApp session
echo   help            Show this help information
echo.
exit /b 0

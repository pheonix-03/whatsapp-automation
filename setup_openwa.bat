@echo off
title OpenWA WhatsApp Gateway Setup & Launcher
echo ========================================================
echo        OpenWA Self-Hosted API Gateway Setup
echo        Repository: https://github.com/rmyndharis/OpenWA
echo ========================================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js 20+ from https://nodejs.org
    pause
    exit /b 1
)

:: Check Git
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Git is not installed or not in PATH!
    echo Please install Git from https://git-scm.com/downloads
    pause
    exit /b 1
)

:: Target directory for OpenWA
set OPENWA_DIR=%~dp0OpenWA

if not exist "%OPENWA_DIR%" (
    echo [1/3] Cloning OpenWA repository from https://github.com/rmyndharis/OpenWA.git...
    git clone https://github.com/rmyndharis/OpenWA.git "%OPENWA_DIR%"
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to clone OpenWA repository.
        pause
        exit /b 1
    )
) else (
    echo [1/3] OpenWA repository found at %OPENWA_DIR%
)

cd /d "%OPENWA_DIR%"

:: Ensure environment file exists
if not exist ".env" (
    if exist ".env.minimal" (
        echo Setting up default minimal configuration (.env)...
        copy /y ".env.minimal" ".env" >nul
    )
)

:: Check if Nest CLI binary is present
if not exist "node_modules\.bin\nest.cmd" (
    echo.
    echo [2/3] Installing OpenWA packages and NestJS CLI (this may take 1-2 minutes)...
    call npm.cmd install --ignore-scripts
    if %errorlevel% neq 0 (
        echo Retrying install with standard npm...
        call npm.cmd install
    )
) else (
    echo [2/3] OpenWA dependencies and NestJS CLI already installed.
)

echo.
echo [3/3] Launching OpenWA REST API Gateway on port 2785...
echo ========================================================
echo OpenWA REST API Gateway:
echo   - Base URL:  http://localhost:2785/api
echo   - Health:    http://localhost:2785/api/health
echo   - Swagger:   http://localhost:2785/api/docs
echo.
if exist "data\.api-key" (
    echo Your OpenWA API Key is:
    type "data\.api-key"
    echo.
)
echo Keep this window open while using OpenWA Gateway in CRM.
echo ========================================================
echo.

:: Start OpenWA server
if exist "dist\main.js" (
    call node dist\main.js
) else (
    call npx nest start
)

pause

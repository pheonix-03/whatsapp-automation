@echo off
title LeadSquared CRM Desktop App
cd /d "%~dp0"
echo ========================================================
echo   LeadSquared CRM + WhatsApp Automation Desktop Window
echo ========================================================
echo Starting desktop application...
call npx.cmd electron electron-main.js

@echo off
setlocal
cd /d "%~dp0"
echo ================================================================
echo   Creating LeadSquared CRM Desktop Shortcut...
echo ================================================================
echo.

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $target = Join-Path '%~dp0' 'start.bat'; $linkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'LeadSquared CRM.lnk'; $shortcut = $ws.CreateShortcut($linkPath); $shortcut.TargetPath = $target; $shortcut.WorkingDirectory = '%~dp0'; $shortcut.Description = 'LeadSquared CRM + WhatsApp Automation'; $shortcut.Save(); Write-Host '[OK] Shortcut created successfully on your Desktop: LeadSquared CRM.lnk'"

echo.
ping 127.0.0.1 -n 3 >nul 2>&1

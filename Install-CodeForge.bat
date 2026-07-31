@echo off
set "TARGET_PATH=%~dp0dist"
if not exist "%TARGET_PATH%\codeforge.exe" (
    set "TARGET_PATH=%~dp0"
)

powershell -Command "$curr = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($curr -notlike '*%TARGET_PATH%*') { [Environment]::SetEnvironmentVariable('Path', $curr.TrimEnd(';') + ';%TARGET_PATH%', 'User') }"

echo.
echo ==========================================================
echo   SUKSES! CodeForge CLI berhasil terpasang!
echo   PENTING: Buka Terminal / CMD / VS Code BARU, lalu ketik:
echo   codeforge
echo ==========================================================
echo.
pause

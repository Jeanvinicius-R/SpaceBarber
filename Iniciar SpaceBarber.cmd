@echo off
cd /d "%~dp0"
echo Abrindo SpaceBarber em http://localhost:3000
echo Mantenha esta janela aberta enquanto usa o sistema.
node --watch server.mjs
pause

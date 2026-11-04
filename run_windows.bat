@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM Na primeira execucao, o Python solicita usuario e senha e salva no banco.
REM Nas proximas execucoes, utiliza os usuarios ja cadastrados.
py -3 server.py
pause

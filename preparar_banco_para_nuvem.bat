@echo off
cd /d "%~dp0"
echo Feche o servidor local antes de gerar o banco para transferencia.
py -3 preparar_banco_para_nuvem.py
if errorlevel 1 echo ERRO: nao foi possivel preparar o banco.
pause

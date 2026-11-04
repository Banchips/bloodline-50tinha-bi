@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ===============================================
echo  BLOODLINE - RECUPERAR DADOS DO BANCO ANTIGO
echo ===============================================
echo IMPORTANTE: feche o servidor Bloodline antes de continuar.
echo O banco atual e seus administradores serao preservados.
echo Sera gerado um backup antes de importar.
echo.
py -3 recuperar_banco.py %*
echo.
pause

@echo off
setlocal

REM ============================================================
REM  WhatsApp Manager MVP - Regras de Firewall (porta 3000)
REM  - Permite TCP 3000 (entrada e saída)
REM  - Permite node.exe (entrada e saída)  [se encontrado]
REM  - Permite cloudflared.exe (entrada e saída) [na pasta atual]
REM ============================================================

echo.
echo === A criar regras no Windows Firewall (porta 3000) ===
echo.

REM --- 1) Regras por PORTA (mais importante) ---
netsh advfirewall firewall add rule name="MPR WA - Node TCP 3000 IN"  dir=in  action=allow protocol=TCP localport=3000 profile=any
netsh advfirewall firewall add rule name="MPR WA - Node TCP 3000 OUT" dir=out action=allow protocol=TCP localport=3000 profile=any

REM --- 2) Regras por PROGRAMA (opcional, ajuda em ambientes mais restritos) ---

REM Tenta encontrar node.exe pelo PATH
for /f "delims=" %%i in ('where node 2^>nul') do set "NODE_EXE=%%i"

if defined NODE_EXE (
  echo Node encontrado em: %NODE_EXE%
  netsh advfirewall firewall add rule name="MPR WA - node.exe IN"  dir=in  action=allow program="%NODE_EXE%" enable=yes profile=any
  netsh advfirewall firewall add rule name="MPR WA - node.exe OUT" dir=out action=allow program="%NODE_EXE%" enable=yes profile=any
) else (
  echo [AVISO] Nao consegui localizar node.exe pelo PATH. (Sem problema: a regra da porta 3000 ja resolve na maioria dos casos.)
)

REM cloudflared.exe na mesma pasta do .bat (recomendado colocar o .bat ao lado do cloudflared.exe)
set "CLOUDFLARED_EXE=%~dp0cloudflared.exe"
if exist "%CLOUDFLARED_EXE%" (
  echo cloudflared encontrado em: %CLOUDFLARED_EXE%
  netsh advfirewall firewall add rule name="MPR WA - cloudflared.exe IN"  dir=in  action=allow program="%CLOUDFLARED_EXE%" enable=yes profile=any
  netsh advfirewall firewall add rule name="MPR WA - cloudflared.exe OUT" dir=out action=allow program="%CLOUDFLARED_EXE%" enable=yes profile=any
) else (
  echo [AVISO] Nao encontrei cloudflared.exe na pasta: %~dp0
  echo         Se quiseres, copia este .bat para a mesma pasta do cloudflared.exe.
)

echo.
echo === Concluido. Regras aplicadas. ===
echo.
pause
@echo off
setlocal

REM ============================================================
REM  WhatsApp Manager MVP - Regras de Firewall (porta 3000)
REM  - Permite TCP 3000 (entrada e saída)
REM  - Permite node.exe (entrada e saída)  [se encontrado]
REM  - Permite cloudflared.exe (entrada e saída) [na pasta atual]
REM ============================================================

echo.
echo === A criar regras no Windows Firewall (porta 3000) ===
echo.

REM --- 1) Regras por PORTA (mais importante) ---
netsh advfirewall firewall add rule name="MPR WA - Node TCP 3000 IN"  dir=in  action=allow protocol=TCP localport=3000 profile=any
netsh advfirewall firewall add rule name="MPR WA - Node TCP 3000 OUT" dir=out action=allow protocol=TCP localport=3000 profile=any

REM --- 2) Regras por PROGRAMA (opcional, ajuda em ambientes mais restritos) ---

REM Tenta encontrar node.exe pelo PATH
for /f "delims=" %%i in ('where node 2^>nul') do set "NODE_EXE=%%i"

if defined NODE_EXE (
  echo Node encontrado em: %NODE_EXE%
  netsh advfirewall firewall add rule name="MPR WA - node.exe IN"  dir=in  action=allow program="%NODE_EXE%" enable=yes profile=any
  netsh advfirewall firewall add rule name="MPR WA - node.exe OUT" dir=out action=allow program="%NODE_EXE%" enable=yes profile=any
) else (
  echo [AVISO] Nao consegui localizar node.exe pelo PATH. (Sem problema: a regra da porta 3000 ja resolve na maioria dos casos.)
)

REM cloudflared.exe na mesma pasta do .bat (recomendado colocar o .bat ao lado do cloudflared.exe)
set "CLOUDFLARED_EXE=%~dp0cloudflared.exe"
if exist "%CLOUDFLARED_EXE%" (
  echo cloudflared encontrado em: %CLOUDFLARED_EXE%
  netsh advfirewall firewall add rule name="MPR WA - cloudflared.exe IN"  dir=in  action=allow program="%CLOUDFLARED_EXE%" enable=yes profile=any
  netsh advfirewall firewall add rule name="MPR WA - cloudflared.exe OUT" dir=out action=allow program="%CLOUDFLARED_EXE%" enable=yes profile=any
) else (
  echo [AVISO] Nao encontrei cloudflared.exe na pasta: %~dp0
  echo         Se quiseres, copia este .bat para a mesma pasta do cloudflared.exe.
)

echo.
echo === Concluido. Regras aplicadas. ===
echo.
pause
endlocal

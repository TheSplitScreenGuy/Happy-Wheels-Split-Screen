@echo off
rem Runs install.py (the same installer the Steam Deck uses). Arguments are passed on, e.g.
rem   "Install (Windows).bat" --uninstall
cd /d "%~dp0"
where py >nul 2>nul && goto use_py
where python >nul 2>nul && goto use_python
echo Python 3 is needed: install it from https://www.python.org/downloads/ and run this again.
goto done
:use_py
py -3 install.py %*
goto done
:use_python
python install.py %*
:done
echo.
pause

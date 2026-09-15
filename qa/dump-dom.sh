#!/bin/bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
"$CHROME" --headless=new --disable-gpu --dump-dom --virtual-time-budget=8000 "$1" 2>/dev/null

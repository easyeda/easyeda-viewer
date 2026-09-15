#!/bin/bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
W=${3:-2476}; H=${4:-1235}
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --run-all-compositor-stages-before-draw \
  --window-size=$W,$H --screenshot="$(cygpath -w "$PWD/$2")" --virtual-time-budget=9000 "$1"

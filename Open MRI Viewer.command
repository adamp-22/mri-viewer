#!/bin/zsh
# Double-click this file in Finder to launch the viewer.
cd "$(dirname "$0")"
if [ ! -x venv/bin/python ]; then
  echo "The local Python environment is missing. Create it with:"
  echo "  python3 -m venv venv && ./venv/bin/python -m pip install -r requirements.txt"
  echo; read -r "?Press return to close."
  exit 1
fi
./venv/bin/python server.py "$@"
echo
read -r "?Viewer stopped. Press return to close this window."

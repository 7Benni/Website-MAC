#!/bin/zsh
# Double-click to publish: prepares new photos (resize + remove GPS), uploads
# them to GitHub, and the website rebuilds automatically (about 1–2 minutes).
cd "$(dirname "$0")"
echo "Publishing photos…"
git pull --rebase --autostash -q || { echo "Could not sync with GitHub."; read -k1 "?Press any key to close"; exit 1; }
[ -d node_modules ] || npm install --silent
node scripts/prepare.mjs || { echo "Could not prepare photos."; read -k1 "?Press any key to close"; exit 1; }
git add -A photos site.json
if git diff --cached --quiet; then
  echo "Nothing new to publish."
else
  git commit -q -m "Update photos" && git push -q && echo "Done! Your site will be live in about 1–2 minutes."
fi
read -k1 "?Press any key to close"

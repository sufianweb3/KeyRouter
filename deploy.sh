#!/usr/bin/env bash
# One-command deploy of KeyRouter (router + dashboard) to your own Cloudflare account.
# Usage: ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "Node.js 20+ is required: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

npx wrangler deploy

# Create an admin key only if the Worker has none yet, so a redeploy never changes it.
if npx wrangler secret list 2>/dev/null | grep -q '"ADMIN_KEY"'; then
  echo
  echo "Admin key already set. Keep using the one in your password manager."
else
  if command -v openssl >/dev/null; then
    ADMIN_KEY="kr-admin-$(openssl rand -hex 24)"
  else
    ADMIN_KEY="kr-admin-$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")"
  fi
  printf '%s' "$ADMIN_KEY" | npx wrangler secret put ADMIN_KEY
  ( umask 077 && printf '%s\n' "$ADMIN_KEY" > .admin-key )
  echo
  echo "================================================================"
  echo " Admin key (dashboard password): $ADMIN_KEY"
  echo " Also saved to .admin-key (git ignores it)."
  echo " Put it in your password manager, then delete .admin-key."
  echo " Never put this key on the machine your agents run on."
  echo "================================================================"
fi
echo
echo "Open the dashboard at the workers.dev URL printed above."

#!/usr/bin/env bash
set -euo pipefail

issuer=${KEYCARD_ISSUER:-${KEYCARD_URL:?Missing CI zone issuer}}
port=${PORT:-8787}
base="http://127.0.0.1:$port"
work=$(mktemp -d)
pid=
vars_created=
cleanup() {
  if [ -n "$pid" ]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 -- "-$pid" 2>/dev/null || break
      sleep .1
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [ -n "$vars_created" ]; then rm -f .dev.vars; fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

if ! (umask 077; set -o noclobber; > .dev.vars); then
  echo "Refusing to overwrite .dev.vars" >&2
  exit 1
fi
vars_created=yes
{
  printf 'KEYCARD_PRIVATE_KEY="\n'
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>"$work/openssl.log"
  printf '"\nKEYCARD_ISSUER="%s"\nKEYCARD_CLIENT_ID=ci-throwaway\n' "$issuer"
  printf 'KEYCARD_WORKER_RESOURCE="%s/call"\nKEYCARD_RESOURCE_URL="%s/downstream"\n' "$base" "$base"
} >> .dev.vars
modulus=$(node --input-type=module -e '
  import { createPublicKey } from "node:crypto";
  import { readFileSync } from "node:fs";
  const pem = readFileSync(".dev.vars", "utf8").match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/)[0];
  console.log(createPublicKey(pem).export({ format: "jwk" }).n);
')

unset KEYCARD_CLIENT_SECRET CI_KEYCARD_CLIENT_SECRET
WRANGLER_SEND_METRICS=false setsid ./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port "$port" \
  >"$work/wrangler.log" 2>&1 &
pid=$!

ready=
for _ in {1..30}; do
  if [ "$(curl -fsS --max-time 1 "$base/healthz" 2>/dev/null)" = ok ]; then
    ready=yes
    break
  fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
[ -n "$ready" ] || { echo "Worker did not become ready" >&2; exit 1; }
echo "OK /healthz"

curl -fsS --max-time 5 "$base/.well-known/oauth-protected-resource/call" |
  jq -e --arg resource "$base/call" --arg issuer "$issuer" \
    '.resource == $resource and .authorization_servers == [$issuer]' >/dev/null
echo "OK protected-resource metadata"

curl -fsS --max-time 5 "$base/.well-known/jwks.json" |
  jq -e --arg n "$modulus" \
    '(.keys | length) == 1 and (.keys[0] | .kty == "RSA" and .alg == "RS256" and .n == $n and (has("d") | not))' >/dev/null
echo "OK JWKS matches generated RSA key"

status=$(curl -sS --max-time 5 -D "$work/headers" -o /dev/null -w '%{http_code}' "$base/call")
test "$status" = 401
awk -v url="$base/.well-known/oauth-protected-resource/call" '
  tolower($0) ~ /^www-authenticate: bearer/ && index($0, "resource_metadata=\"" url "\"") { found=1 }
  END { exit !found }
' "$work/headers"
echo "OK GET /call rejects unauthenticated requests with a Bearer challenge"

#!/bin/sh
set -eu
case "${APP_HOST:-}" in ''|*[!A-Za-z0-9.:-]*) exit 64 ;; esac
if [ -e /tls/tls.crt ] || [ -e /tls/tls.key ]; then
  [ -f /tls/tls.crt ] && [ -f /tls/tls.key ] || exit 64
else
  umask 077
  openssl req -x509 -newkey rsa:3072 -nodes -days 365 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -keyout /tls/tls.key -out /tls/tls.crt >/dev/null 2>&1
fi

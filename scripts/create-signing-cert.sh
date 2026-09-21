#!/bin/bash
# Creates the reusable self-signed certificate that signs Ling's macOS releases.
#
# Usage:
#   ./scripts/create-signing-cert.sh [common-name] [password] [output-dir]
#
# Store the printed base64 value and password as the SIGNING_CERTIFICATE and
# SIGNING_CERTIFICATE_PASSWORD repository secrets, and keep the generated directory
# private and backed up.
#
# Reuse this same certificate for every release. macOS keys TCC privacy grants and
# application replacement on the signing identity. A new certificate silently resets
# existing privacy grants.
#
# It does not make either platform trust the app: macOS still needs `xattr -cr` until the
# app is notarized with an Apple Developer ID.

set -euo pipefail

NAME="${1:-Ling}"
PASSWORD="${2:-$(openssl rand -base64 24)}"
OUT_DIR="${3:-.signing}"

mkdir -p "$OUT_DIR"

KEY_PATH="$OUT_DIR/signing.key"
CERT_PATH="$OUT_DIR/signing.crt"
P12_PATH="$OUT_DIR/signing.p12"
B64_PATH="$OUT_DIR/signing.p12.base64"

# CA:FALSE marks this an end-entity certificate, matching what Windows' own
# New-SelfSignedCertificate -Type CodeSigningCert produces.
openssl req \
  -x509 \
  -newkey rsa:2048 \
  -sha256 \
  -days 3650 \
  -nodes \
  -keyout "$KEY_PATH" \
  -out "$CERT_PATH" \
  -subj "/CN=$NAME/" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning"

# TripleDES_SHA1 is what Windows itself writes when exporting a PFX, and signtool reads it
# on every Windows version. It is also the only family macOS accepts: SecPKCS12Import rejects
# a SHA-256 MAC outright and cannot read PBES2/AES content, so the modern OpenSSL 3 default
# imports nowhere. 40-bit RC2 would import too, but it is far weaker and needs OpenSSL's
# legacy provider on both the writing and reading side.
openssl pkcs12 \
  -export \
  -name "$NAME" \
  -macalg sha1 \
  -keypbe PBE-SHA1-3DES \
  -certpbe PBE-SHA1-3DES \
  -inkey "$KEY_PATH" \
  -in "$CERT_PATH" \
  -out "$P12_PATH" \
  -passout "pass:$PASSWORD"

if base64 -i "$P12_PATH" -o "$B64_PATH" 2>/dev/null; then
  :
else
  base64 "$P12_PATH" > "$B64_PATH"
fi

chmod 600 "$KEY_PATH" "$P12_PATH"

cat <<EOF
Created: $P12_PATH
Base64:  $B64_PATH

Repository secrets:
  SIGNING_CERTIFICATE          = contents of $B64_PATH
  SIGNING_CERTIFICATE_PASSWORD = $PASSWORD

  gh secret set SIGNING_CERTIFICATE < "$B64_PATH"
  gh secret set SIGNING_CERTIFICATE_PASSWORD --body '$PASSWORD'

Keep $OUT_DIR private and backed up. GitHub secrets cannot be read back, so losing this
directory means losing the release identity permanently.
EOF

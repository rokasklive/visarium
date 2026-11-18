#!/bin/sh
# Cargo's runner on macOS (.cargo/config.toml).
#
# A dev build is ad-hoc signed with a new hash every time it is rebuilt, so
# the keychain takes each rebuild for a different app and asks for the login
# password before handing over the device token an earlier build saved.
# Signed with a stable identity — $VISARIUM_DEV_SIGN, or the first "Apple
# Development" certificate — every rebuild is the same app, and one "Always
# Allow" lasts. A release build is signed by `tauri build` instead.
#
# Anything else Cargo runs, or no identity on this Mac: run as it is.
case "$1" in
  */visarium-desktop)
    id="${VISARIUM_DEV_SIGN:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1)}"
    if [ -n "$id" ]; then
      codesign --force --sign "$id" --identifier dev.visarium.desktop "$1" >/dev/null 2>&1 ||
        echo "dev-sign: could not sign with \"$id\"; the keychain may ask again" >&2
    fi
    ;;
esac
exec "$@"

# Signing the Android release

Every Android app is signed, and Google Play ties the listing to the key that
signed the first upload. Lose that key and you cannot update the app — not with
a support ticket, not with proof of ownership. You publish a new listing and
start again from zero installs.

So this is the one step nobody should run on your behalf. Generate it yourself,
choose the passwords, and put the file somewhere that survives this laptop.

## Make the key

`keytool` ships with the JDK. There is one inside Android Studio if you have no
other:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"

"$JAVA_HOME/bin/keytool" -genkeypair -v \
  -keystore salpicon-release.jks \
  -alias salpicon \
  -keyalg RSA -keysize 4096 \
  -validity 10000 \
  -storetype JKS
```

It asks for a store password, your name and organisation, then a key password.
Answers other than the passwords are cosmetic — they end up in the certificate,
not on the listing.

`-validity 10000` is about 27 years. Play requires a key valid well past any
plausible update, and a short expiry is a slow-motion version of losing it.

## Keep it

Three copies, two of them not on this machine: a password manager with file
attachments, an encrypted backup, or a printed base64 copy in a drawer. Store
the two passwords with it — a keystore whose password is gone is a lost
keystore.

Do not commit it. `.gitignore` already covers `*.jks`, but the repository is
public, so check before you push rather than after.

## Give it to CI

The workflow reads four secrets. Under **Settings → Secrets and variables →
Actions**:

| Secret | Value |
|---|---|
| `KEYSTORE_B64` | `base64 -i salpicon-release.jks \| pbcopy` |
| `KEYSTORE_PASSWORD` | the store password |
| `KEY_ALIAS` | `salpicon` |
| `KEY_PASSWORD` | the key password |

With those set, pushing a tag builds a signed `.apk` and `.aab`:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Without them the workflow falls back to a debug build, so a fork still goes
green. Play needs the `.aab`; the `.apk` is what you sideload to test.

## The signing config is already wired

`android/app/build.gradle` reads all four values from the environment, which is
what keeps the passwords out of the repository: the workflow sets them, and on
your machine they are simply unset, so a local release build comes out unsigned
and a local debug build is unaffected.

It fails loudly rather than quietly in the one case that matters. If
`SALPICON_KEYSTORE` is set but points at nothing, the build stops; and CI
verifies the finished `.aab` and `.apk` really carry a signature before
uploading them, because an unsigned release assembles perfectly happily and
only gets rejected later, at the Play console, a long way from the commit that
caused it.

## Version numbers come from the tag

Nothing in the repository records a version. `versionName` and `versionCode`
are both derived from the tag you push:

| Tag | `versionName` | `versionCode` |
|---|---|---|
| `v0.1.0` | `0.1.0` | `100` |
| `v0.2.0` | `0.2.0` | `200` |
| `v1.2.3` | `1.2.3` | `10203` |

`versionCode` is `major × 10000 + minor × 100 + patch`, so it rises with the
version on its own. This matters more than it looks: Play refuses an upload
whose `versionCode` it has seen before, for ever, and a number edited by hand
is a number that eventually gets used twice.

A tag that is not `vMAJOR.MINOR.PATCH` fails the build rather than guessing. A
run started by hand has no tag at all, so it calls itself `0.0.0` and takes the
run number as its code — installable, never uploadable.

## Before the first upload

Play will not accept a production release from a personal developer account
until a closed test has run with at least 12 testers opted in continuously for
14 days. That clock cannot be compressed, so start it as soon as there is
something installable — it runs in parallel with everything else.

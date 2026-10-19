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

## Wire the signing config

Gradle needs telling where the key is. In `android/app/build.gradle`, inside
`android { }`:

```groovy
signingConfigs {
    release {
        def ks = System.getenv("SALPICON_KEYSTORE")
        if (ks) {
            storeFile file(ks)
            storePassword System.getenv("SALPICON_KEYSTORE_PASSWORD")
            keyAlias System.getenv("SALPICON_KEY_ALIAS")
            keyPassword System.getenv("SALPICON_KEY_PASSWORD")
        }
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
        minifyEnabled false
    }
}
```

Reading from the environment rather than a properties file is what keeps the
passwords out of the repository: the workflow sets those four variables, and
locally they are simply unset, so a local release build is unsigned and a local
debug build is unaffected.

## Before the first upload

Play will not accept a production release from a personal developer account
until a closed test has run with at least 12 testers opted in continuously for
14 days. That clock cannot be compressed, so start it as soon as there is
something installable — it runs in parallel with everything else.

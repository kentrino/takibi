# Set the release bot credentials

Set these repository values so that GitHub Actions can create a GitHub App
token for the release bot:

- Variable: `RELEASE_BOT_APP_ID`
- Secret: `RELEASE_BOT_PRIVATE_KEY`

## 1. Check the GitHub App

1. Open the [GitHub App installation settings](https://github.com/settings/installations/152797047).
2. Make sure that the app has access to `kentrino/takibi`.
3. Open the app from the [GitHub Apps settings](https://github.com/settings/apps).
4. Get the **App ID** from the **General** page.
5. In **Private keys**, select **Generate a private key** only if you do not
   already have the key used by `kentrino/tatenuki`.
6. Download the PEM file if you generated a new key.

Do not use the client ID, client secret, or installation ID.

You cannot download an existing private key again. If you do not have the
private key, generate a new key.

Reuse the same GitHub App that `kentrino/tatenuki` uses. Grant that
installation access to this repository instead of creating a second app.

## 2. Set the repository values

Before you continue, use GitHub CLI to sign in to GitHub. Run these commands
from the root directory of the repository:

```sh
export RELEASE_BOT_APP_ID=4553309
export RELEASE_BOT_PRIVATE_KEY_PATH=./.kentrino/private-key.pem

gh variable set RELEASE_BOT_APP_ID --body "$RELEASE_BOT_APP_ID"
gh secret set RELEASE_BOT_PRIVATE_KEY < "$RELEASE_BOT_PRIVATE_KEY_PATH"
```

Do not put the contents of the PEM file in a command-line argument or a shell
variable.

After you set the repository values, move the PEM file to a secure location.
If you do not need the file, delete it. Then, remove the environment variables:

```sh
unset RELEASE_BOT_APP_ID RELEASE_BOT_PRIVATE_KEY_PATH
```

## 3. Make sure that the repository values are set

Run these commands:

```sh
gh variable list
gh secret list
```

Make sure that the output contains `RELEASE_BOT_APP_ID` and
`RELEASE_BOT_PRIVATE_KEY`. GitHub does not show the value of the secret.

The following workflows use these credentials:

- `.github/workflows/release.yml`
- `.github/workflows/pinact.yml`

Set both values before merging this work to `main`. A push to `main` starts
the Release workflow, and that job fails until the app token can be created.

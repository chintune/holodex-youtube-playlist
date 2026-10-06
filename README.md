# Holodex → YouTube Playlist

Automatically maintains a YouTube playlist from the Holodex search:

- Organization: `Hololive`
- Topic: `Original_Song`
- Sort: newest
- Initial import: latest 50 usable matches
- Later runs: append new matches only
- Existing playlist videos are never removed
- Schedule: every 30 minutes via GitHub Actions

## How it works

The workflow calls Holodex's API, gets the newest matching videos, then compares their YouTube video IDs with the target playlist. Only missing IDs are inserted.

The first run can add up to 50 videos. Every later run can add only videos that are new since the previous sync.

The playlist is kept newest-first by inserting newly discovered videos at position 0. Existing videos are not reordered or deleted.

## Files

- `sync.mjs` — the complete synchronizer
- `scripts/youtube-auth.mjs` — one-time helper for generating a YouTube OAuth refresh token
- `.github/workflows/sync.yml` — runs every 30 minutes and can also be started manually

## One-time setup

### 1. Get a Holodex API key

Log into Holodex and open:

Account → Account Settings → API Key

The API key is sent to Holodex in the `X-APIKEY` header.

Create this GitHub Actions secret:

`HOLODEX_API_KEY`

### 2. Create a Google Cloud project

Create or select a Google Cloud project and enable **YouTube Data API v3**.

Then configure the OAuth consent screen. For a personal single-user setup, add your own Google account as a test user while developing.

Create an OAuth client of type **Desktop app** and download the JSON file.

Google currently supports the loopback callback flow for Desktop app clients.

### 3. Generate the YouTube refresh token

On your own computer, with Node.js 20+ installed:

```text
node scripts/youtube-auth.mjs path/to/client_secret.json
```

Open the URL printed by the script in your browser and approve YouTube access.

The script will print:

```text
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
YOUTUBE_REFRESH_TOKEN=...
```

Do not commit `client_secret.json` or the refresh token.

### 4. Add GitHub Secrets

Repository → Settings → Secrets and variables → Actions → New repository secret

Create:

```text
HOLODEX_API_KEY
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
YOUTUBE_REFRESH_TOKEN
```

Optional:

```text
YOUTUBE_PLAYLIST_ID
```

You can leave `YOUTUBE_PLAYLIST_ID` unset. In that case the script finds an existing playlist with the exact title **Hololive Original Songs**, or creates one automatically.

The optional playlist privacy setting is controlled in the script through `YOUTUBE_PLAYLIST_PRIVACY`. The default is `unlisted`.

## Important Google OAuth note

A Google OAuth project left in **Testing** mode can issue refresh tokens that expire after 7 days for non-profile scopes. For uninterrupted long-term automation, the OAuth app needs an appropriate production configuration. See Google's current OAuth documentation before relying on a Testing-mode token for permanent automation.

## Run it

After adding the secrets, open:

Actions → Sync Holodex to YouTube → Run workflow

The first run imports the newest 50 matching Holodex videos.

After that, the scheduled workflow checks every 30 minutes and adds only newly discovered videos.

## Safety / behavior

The repository contains no credentials.

The workflow has only `contents: read` permission because it does not need to modify repository files.

The synchronizer:

- does not scrape the Holodex webpage
- does not download YouTube media
- does not remove videos from your playlist
- does not modify existing playlist positions
- skips individual unavailable/invalid video inserts and continues
- stops on authentication/quota failures so they are visible in Actions

## Sources

Holodex API: https://docs.holodex.net/

YouTube Data API playlists: https://developers.google.com/youtube/v3/guides/implementation/playlists

YouTube Data API playlistItems.insert: https://developers.google.com/youtube/v3/docs/playlistItems/insert

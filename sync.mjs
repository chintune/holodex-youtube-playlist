#!/usr/bin/env node

import fs from "node:fs";

const HOLODEX_API = "https://holodex.net/api/v2/search/videoSearch";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

const HOLODEX_TOPIC = "Original_Song";
const HOLODEX_ORG = "Hololive";

const INITIAL_LIMIT = 50;
const PLAYLIST_TITLE =
  process.env.YOUTUBE_PLAYLIST_TITLE || "Hololive Original Songs";
const PLAYLIST_PRIVACY =
  process.env.YOUTUBE_PLAYLIST_PRIVACY || "unlisted";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function jsonErrorMessage(data) {
  if (!data) return "Unknown API error";
  if (data.error?.message) return data.error.message;
  if (data.error?.errors?.[0]?.message) {
    return data.error.errors[0].message;
  }
  if (typeof data.error === "string") return data.error;
  return JSON.stringify(data);
}

function apiReason(data) {
  return data?.error?.errors?.[0]?.reason || data?.error?.status || data?.error;
}

async function fetchJson(url, options = {}, label = "API request") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });

    const text = await response.text();

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      const bodyPreview = text.slice(0, 500);
      throw new Error(
        `${label} returned non-JSON HTTP ${response.status}: ${bodyPreview}`,
      );
    }

    if (!response.ok) {
      const error = new Error(
        `${label} failed (HTTP ${response.status}): ${jsonErrorMessage(data)}`,
      );
      error.status = response.status;
      error.reason = apiReason(data);
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${label} timed out after 30 seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getYouTubeAccessToken() {
  const clientId = requiredEnv("YOUTUBE_CLIENT_ID");
  const clientSecret = requiredEnv("YOUTUBE_CLIENT_SECRET");
  const refreshToken = requiredEnv("YOUTUBE_REFRESH_TOKEN");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const data = await fetchJson(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
    "Google OAuth token refresh",
  );

  if (!data.access_token) {
    throw new Error(
      "Google OAuth token refresh succeeded without an access_token",
    );
  }

  return data.access_token;
}

async function holodexLatest50() {
  const apiKey = requiredEnv("HOLODEX_API_KEY");
  const seen = new Set();
  const items = [];

  for (
    let page = 0;
    page < 5 && items.length < INITIAL_LIMIT;
    page += 1
  ) {
    const offset = page * INITIAL_LIMIT;

    const payload = {
      sort: "newest",
      target: ["stream"],
      conditions: [],
      topic: [HOLODEX_TOPIC],
      org: [HOLODEX_ORG],
      paginated: true,
      offset,
      limit: INITIAL_LIMIT,
    };

    const data = await fetchJson(
      HOLODEX_API,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-APIKEY": apiKey,
        },
        body: JSON.stringify(payload),
      },
      `Holodex videoSearch page ${page + 1}`,
    );

    if (!Array.isArray(data?.items)) {
      throw new Error(
        `Holodex returned an unexpected response on page ${page + 1}: missing items[]`,
      );
    }

    for (const item of data.items) {
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      if (!id || seen.has(id)) continue;

      seen.add(id);

      if (
        item.status === "live" ||
        item.status === "upcoming" ||
        item.status === "missing"
      ) {
        continue;
      }

      items.push({
        id,
        title: typeof item.title === "string" ? item.title : id,
        publishedAt: item.published_at || item.available_at || null,
        channelName:
          item.channel?.english_name || item.channel?.name || "",
        url: `https://www.youtube.com/watch?v=${id}`,
      });

      if (items.length >= INITIAL_LIMIT) break;
    }

    if (items.length >= INITIAL_LIMIT) break;

    const total = Number(data.total);
    if (
      Number.isFinite(total) &&
      offset + data.items.length >= total
    ) {
      break;
    }

    if (data.items.length < INITIAL_LIMIT) break;
  }

  return {
    total: items.length,
    items,
  };
}

async function youtubeRequest(
  accessToken,
  path,
  options = {},
  label = "YouTube API request",
) {
  return fetchJson(
    `${YOUTUBE_API}${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.headers || {}),
      },
    },
    label,
  );
}

async function listAllPlaylists(accessToken) {
  const playlists = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({
      part: "id,snippet",
      mine: "true",
      maxResults: "50",
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const data = await youtubeRequest(
      accessToken,
      `/playlists?${params}`,
      {},
      "YouTube playlist list",
    );

    playlists.push(...(data.items || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  return playlists;
}

async function createPlaylist(accessToken) {
  const data = await youtubeRequest(
    accessToken,
    "/playlists?part=snippet,status",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        snippet: {
          title: PLAYLIST_TITLE,
          description:
            "Automatically maintained from Holodex: Hololive + Original_Song. " +
            "Initial run imports the latest 50 matching videos; later runs append new matching videos only.",
        },
        status: {
          privacyStatus: PLAYLIST_PRIVACY,
        },
      }),
    },
    "YouTube playlist creation",
  );

  if (!data.id) {
    throw new Error(
      "YouTube created a playlist without returning an id",
    );
  }

  console.log(
    `Created playlist: ${PLAYLIST_TITLE} (${data.id}) [${PLAYLIST_PRIVACY}]`,
  );

  return data.id;
}

async function resolvePlaylistId(accessToken) {
  const explicitId = process.env.YOUTUBE_PLAYLIST_ID?.trim();

  if (explicitId) {
    console.log(`Using YOUTUBE_PLAYLIST_ID: ${explicitId}`);
    return explicitId;
  }

  const playlists = await listAllPlaylists(accessToken);

  const matches = playlists.filter(
    (playlist) => playlist.snippet?.title === PLAYLIST_TITLE,
  );

  if (matches.length > 0) {
    matches.sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    );

    const playlist = matches[0];

    console.log(
      `Using existing playlist: ${PLAYLIST_TITLE} (${playlist.id})`,
    );

    if (matches.length > 1) {
      console.log(
        `Warning: found ${matches.length} playlists with the exact title. Using ${playlist.id}. Set YOUTUBE_PLAYLIST_ID to pin a specific one.`,
      );
    }

    return playlist.id;
  }

  const playlistId = await createPlaylist(accessToken);
  return { playlistId, created: true };
}

/*
 * YouTube occasionally returns transient HTTP 5xx errors from
 * playlistItems.list. This is not a client-side validation error, so retry
 * that read a few times with exponential backoff before failing.
 *
 * The request itself is intentionally simple and matches YouTube's documented
 * playlistItems.list contract: part=contentDetails + playlistId + maxResults.
 */
async function listPlaylistVideoIds(accessToken, playlistId) {
  const ids = new Set();
  let pageToken = "";

  do {
    const params = new URLSearchParams({
      part: "contentDetails",
      playlistId,
      maxResults: "50",
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    let data;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        data = await youtubeRequest(
          accessToken,
          `/playlistItems?${params}`,
          {},
          `YouTube playlist items list (attempt ${attempt}/4)`,
        );
        break;
      } catch (error) {
        const retryable =
          Number(error.status) >= 500 &&
          Number(error.status) <= 599;

        if (!retryable || attempt === 4) {
          throw error;
        }

        const delayMs = 1000 * 2 ** (attempt - 1);
        console.log(
          `YouTube playlistItems.list returned HTTP ${error.status}; retrying in ${delayMs} ms...`,
        );

        await new Promise((resolve) =>
          setTimeout(resolve, delayMs),
        );
      }
    }

    for (const item of data.items || []) {
      const id = item.contentDetails?.videoId;
      if (id) ids.add(id);
    }

    pageToken = data.nextPageToken || "";
  } while (pageToken);

  return ids;
}

function isQuotaError(error) {
  const value = String(error.reason || "").toLowerCase();

  return [
    "quotaexceeded",
    "dailylimitexceeded",
    "ratelimitexceeded",
    "userratelimitexceeded",
  ].includes(value);
}

async function addVideo(accessToken, playlistId, video) {
  try {
    await youtubeRequest(
      accessToken,
      "/playlistItems?part=snippet",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          snippet: {
            playlistId,
            resourceId: {
              kind: "youtube#video",
              videoId: video.id,
            },
          },
        }),
      },
      `YouTube add video ${video.id}`,
    );

    return "added";
  } catch (error) {
    if (
      isQuotaError(error) ||
      error.status === 401 ||
      error.status === 403
    ) {
      throw error;
    }

    console.log(`Skipped ${video.id}: ${error.message}`);
    return "skipped";
  }
}

function writeSummary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;

  fs.appendFileSync(
    file,
    lines.join("\n") + "\n",
    "utf8",
  );
}

async function main() {
  console.log("=== Holodex → YouTube Playlist Sync ===");
  console.log(
    `Source: ${HOLODEX_ORG} + ${HOLODEX_TOPIC}`,
  );
  console.log(`Playlist: ${PLAYLIST_TITLE}`);
  console.log(
    `Initial/import window: latest ${INITIAL_LIMIT}`,
  );
  console.log(
    "Mode: append-only (existing playlist videos are never removed)\n",
  );

  const holodex = await holodexLatest50();

  console.log(
    `Holodex returned ${holodex.items.length} usable videos from ${holodex.total} matching results.`,
  );

  if (holodex.items.length === 0) {
    console.log("Nothing to add.");
    return;
  }

  const accessToken = await getYouTubeAccessToken();

  const resolved = await resolvePlaylistId(accessToken);
  const playlistId =
    typeof resolved === "string" ? resolved : resolved.playlistId;

  const createdNow =
    typeof resolved === "object" && resolved.created === true;

  const existing = createdNow
    ? new Set()
    : await listPlaylistVideoIds(accessToken, playlistId);

  const newItems = holodex.items.filter(
    (item) => !existing.has(item.id),
  );

  console.log(
    `Videos already in playlist: ${existing.size}`,
  );
  console.log(`New videos to add: ${newItems.length}`);

  if (newItems.length === 0) {
    console.log("Playlist is already up to date.");

    writeSummary([
      "## Holodex → YouTube sync",
      "",
      `- Matching Holodex videos checked: **${holodex.items.length}**`,
      `- Already present: **${existing.size} total playlist items / 0 new matches**`,
      "- Added this run: **0**",
      "",
      `Playlist: [${PLAYLIST_TITLE}](https://www.youtube.com/playlist?list=${playlistId})`,
    ]);

    return;
  }

  /*
   * Append videos without setting snippet.position. YouTube rejects explicit
   * positional insertion when the playlist is not using manual sorting.
   */
  let added = 0;
  let skipped = 0;

  for (const video of newItems) {
    const result = await addVideo(
      accessToken,
      playlistId,
      video,
    );

    if (result === "added") {
      added += 1;
      console.log(
        `Added: ${video.title} — ${video.channelName}`,
      );
    } else {
      skipped += 1;
    }
  }

  console.log(
    `\nSync complete. Added: ${added}; skipped: ${skipped}.`,
  );

  writeSummary([
    "## Holodex → YouTube sync",
    "",
    `- Matching Holodex videos checked: **${holodex.items.length}**`,
    `- New matches found: **${newItems.length}**`,
    `- Added this run: **${added}**`,
    `- Skipped/unavailable: **${skipped}**`,
    "",
    `Playlist: [${PLAYLIST_TITLE}](https://www.youtube.com/playlist?list=${playlistId})`,
  ]);
}

main().catch((error) => {
  console.error("\nSYNC FAILED");
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});

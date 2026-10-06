#!/usr/bin/env node

import fs from "node:fs";
const HOLODEX_API = "https://holodex.net/api/v2/search/videoSearch";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const HOLODEX_TOPIC = "Original_Song";
const HOLODEX_ORG = "Hololive";
const INITIAL_LIMIT = 50;
const PLAYLIST_TITLE = process.env.YOUTUBE_PLAYLIST_TITLE || "Hololive Original Songs";
const PLAYLIST_PRIVACY = process.env.YOUTUBE_PLAYLIST_PRIVACY || "unlisted";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function jsonErrorMessage(data) {
  if (!data) return "Unknown API error";
  if (data.error?.message) return data.error.message;
  if (data.error?.errors?.[0]?.message) return data.error.errors[0].message;
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
      throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    if (!response.ok) {
      const error = new Error(`${label} failed (HTTP ${response.status}): ${jsonErrorMessage(data)}`);
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
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    "Google OAuth token refresh",
  );

  if (!data.access_token) {
    throw new Error("Google OAuth token refresh succeeded without an access_token");
  }

  return data.access_token;
}

async function holodexLatest50() {
  const apiKey = requiredEnv("HOLODEX_API_KEY");

  const payload = {
    sort: "newest",
    target: ["stream"],
    conditions: [],
    topic: [HOLODEX_TOPIC],
    org: [HOLODEX_ORG],
    paginated: true,
    offset: 0,
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
    "Holodex videoSearch",
  );

  if (!Array.isArray(data?.items)) {
    throw new Error("Holodex returned an unexpected response: missing items[]");
  }

  const seen = new Set();
  const items = [];

  for (const item of data.items) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    // The Holodex topic is attached to streams. Avoid future live/upcoming
    // entries that cannot be added reliably to a YouTube playlist yet.
    if (item.status === "live" || item.status === "upcoming" || item.status === "missing") {
      continue;
    }

    items.push({
      id,
      title: typeof item.title === "string" ? item.title : id,
      publishedAt: item.published_at || item.available_at || null,
      channelName: item.channel?.english_name || item.channel?.name || "",
      url: `https://www.youtube.com/watch?v=${id}`,
    });
  }

  return {
    total: Number.isFinite(Number(data.total)) ? Number(data.total) : data.items.length,
    items: items.slice(0, INITIAL_LIMIT),
  };
}

async function youtubeRequest(accessToken, path, options = {}, label = "YouTube API request") {
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
    if (pageToken) params.set("pageToken", pageToken);

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
      headers: { "Content-Type": "application/json" },
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

  if (!data.id) throw new Error("YouTube created a playlist without returning an id");

  console.log(`Created playlist: ${PLAYLIST_TITLE} (${data.id}) [${PLAYLIST_PRIVACY}]`);
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
    // Prefer an exact title match; if more than one exists, use a stable
    // playlist-ID order so repeated runs remain deterministic.
    matches.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const playlist = matches[0];
    console.log(`Using existing playlist: ${PLAYLIST_TITLE} (${playlist.id})`);
    if (matches.length > 1) {
      console.log(
        `Warning: found ${matches.length} playlists with the exact title. Using ${playlist.id}. Set YOUTUBE_PLAYLIST_ID to pin a specific one.`,
      );
    }
    return playlist.id;
  }

  return createPlaylist(accessToken);
}

async function listPlaylistVideoIds(accessToken, playlistId) {
  const ids = new Set();
  let pageToken = "";

  do {
    const params = new URLSearchParams({
      part: "contentDetails",
      playlistId,
      maxResults: "50",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const data = await youtubeRequest(
      accessToken,
      `/playlistItems?${params}`,
      {},
      "YouTube playlist items list",
    );

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

async function addVideo(accessToken, playlistId, video, position = 0) {
  try {
    await youtubeRequest(
      accessToken,
      "/playlistItems?part=snippet",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          snippet: {
            playlistId,
            position,
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
    // If an item became unavailable or otherwise cannot be inserted, keep the
    // rest of the sync moving. Quota/auth errors are fatal.
    if (isQuotaError(error) || error.status === 401 || error.status === 403) {
      throw error;
    }

    console.log(`Skipped ${video.id}: ${error.message}`);
    return "skipped";
  }
}

function writeSummary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;

  fs.appendFileSync(file, lines.join("\n") + "\n", "utf8");
}

async function main() {
  console.log("=== Holodex → YouTube Playlist Sync ===");
  console.log(`Source: ${HOLODEX_ORG} + ${HOLODEX_TOPIC}`);
  console.log(`Playlist: ${PLAYLIST_TITLE}`);
  console.log(`Initial/import window: latest ${INITIAL_LIMIT}`);
  console.log("Mode: append-only (existing playlist videos are never removed)\n");

  const holodex = await holodexLatest50();
  console.log(`Holodex returned ${holodex.items.length} usable videos from ${holodex.total} matching results.`);

  if (holodex.items.length === 0) {
    console.log("Nothing to add.");
    return;
  }

  const accessToken = await getYouTubeAccessToken();
  const playlistId = await resolvePlaylistId(accessToken);
  const existing = await listPlaylistVideoIds(accessToken, playlistId);

  const newItems = holodex.items.filter((item) => !existing.has(item.id));

  console.log(`Videos already in playlist: ${existing.size}`);
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

  // Holodex is newest-first. Insert oldest-first at position 0 so the final
  // playlist order remains newest-first without reordering existing items.
  let added = 0;
  let skipped = 0;

  for (const video of [...newItems].reverse()) {
    const result = await addVideo(accessToken, playlistId, video, 0);

    if (result === "added") {
      added += 1;
      console.log(`Added: ${video.title} — ${video.channelName}`);
    } else {
      skipped += 1;
    }
  }

  console.log(`\nSync complete. Added: ${added}; skipped: ${skipped}.`);

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

#!/usr/bin/env node

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";

const SCOPES = ["https://www.googleapis.com/auth/youtube"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

function die(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

function loadClient(filename) {
  if (!filename) {
    die("Usage: node scripts/youtube-auth.mjs path\\to\\client_secret.json");
  }

  let json;
  try {
    json = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    die(`Could not read client JSON: ${error.message}`);
  }

  const cfg = json.installed || json.desktop || json.web || json;
  const clientId = cfg.client_id;
  const clientSecret = cfg.client_secret || "";

  if (!clientId) die("client_secret.json does not contain client_id");

  const isWebClient = Boolean(json.web) && !json.installed;

  if (isWebClient) {
    die(
      "This helper is designed for a Google OAuth Desktop app. " +
      "Create an OAuth client of type Desktop app and download its JSON.",
    );
  }

  return { clientId, clientSecret };
}

function pkceVerifier() {
  return crypto.randomBytes(48).toString("base64url");
}

function sha256Base64Url(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri, verifier }) {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  if (clientSecret) body.set("client_secret", clientSecret);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Token exchange failed (HTTP ${response.status}): ${JSON.stringify(data)}`,
    );
  }

  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. Re-run the helper and make sure offline access is requested.",
    );
  }

  return data;
}

const clientFile = process.argv[2];
const { clientId, clientSecret } = loadClient(clientFile);

const server = http.createServer();
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) die("Could not determine local callback port");

  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const state = crypto.randomBytes(24).toString("hex");
  const verifier = pkceVerifier();
  const challenge = sha256Base64Url(verifier);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const url = `${AUTH_URL}?${params.toString()}`;

  console.log("\nOpen this URL in your browser:\n");
  console.log(url);
  console.log("\nAfter you approve access, Google will return to this computer automatically.\n");

  server.on("request", async (req, res) => {
    const requestUrl = new URL(req.url, redirectUri);

    if (requestUrl.pathname !== "/oauth2callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const returnedState = requestUrl.searchParams.get("state");
    const code = requestUrl.searchParams.get("code");
    const error = requestUrl.searchParams.get("error");

    if (returnedState !== state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>OAuth state mismatch</h1><p>Close this window and run the helper again.</p>");
      return;
    }

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      console.error(`Google OAuth failed: ${error}`);
      res.end("<h1>Google OAuth failed</h1><p>Authorization was not completed.</p>");
      server.close(() => {
        process.exitCode = 1;
      });
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Missing authorization code</h1>");
      return;
    }

    try {
      const tokens = await exchangeCode({
        clientId,
        clientSecret,
        code,
        redirectUri,
        verifier,
      });

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<h1>Authorization successful</h1>" +
        "<p>You can close this tab and return to the terminal.</p>",
      );

      console.log("\n=== GitHub Secrets ===\n");
      console.log(`YOUTUBE_CLIENT_ID=${clientId}`);
      console.log(`YOUTUBE_CLIENT_SECRET=${clientSecret}`);
      console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log("\nCopy these values into GitHub Actions Secrets. Do NOT commit them to the repository.\n");

      server.close(() => process.exit(0));
    } catch (error2) {
      console.error(error2);
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Authorization failed</h1><p>Check the terminal for details.</p>");
      server.close(() => {
        process.exitCode = 1;
      });
    }
  });
});

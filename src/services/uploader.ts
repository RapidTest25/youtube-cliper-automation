// ============================================================
// YouTube uploader  (YouTube Data API v3 via googleapis)
// ============================================================

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { google } from "googleapis";
import { logger } from "../utils/logger.js";
import type { UploadConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../config.js";

const DEFAULTS = DEFAULT_CONFIG.upload;

/**
 * Upload a video (+ optional thumbnail) to YouTube.
 * Returns the video ID on success, `null` on failure.
 */
export async function uploadVideo(
  videoPath: string,
  thumbnailPath: string | null,
  metadata: {
    title: string;
    description: string;
    tags: string[];
    url: string;
    index: number;
  },
  config: Partial<UploadConfig> = {},
): Promise<string | null> {
  const cfg = { ...DEFAULTS, ...config };

  logger.info(`Uploading video: ${metadata.title}`);

  const fullDescription = [
    metadata.description,
    "",
    `-- Full episode: ${metadata.url}`,
    "",
    "-- Subscribe, like, share! Leave your comment",
    "-- Thanks for watching!",
  ].join("\n");

  // Scheduled publish time
  const publishAt = new Date();
  publishAt.setHours(
    publishAt.getHours() + cfg.publishInterval * metadata.index,
  );

  try {
    const auth = await authenticate(cfg.clientSecretsPath, cfg.tokenPath);
    const youtube = google.youtube({ version: "v3", auth });

    const res = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: metadata.title,
          description: fullDescription,
          tags: metadata.tags,
          categoryId: cfg.categoryId,
          defaultLanguage: cfg.language,
          defaultAudioLanguage: cfg.language,
        },
        status: {
          privacyStatus: cfg.privacyStatus,
          publishAt:
            cfg.privacyStatus === "private"
              ? publishAt.toISOString()
              : undefined,
          madeForKids: cfg.madeForKids,
          embeddable: true,
          license: "creativeCommon",
          publicStatsViewable: true,
        },
      },
      media: { body: createReadStream(videoPath) },
    });

    const videoId = res.data.id;
    logger.success(`Video uploaded! ID: ${videoId}`);

    // Thumbnail
    if (thumbnailPath && videoId) {
      try {
        await youtube.thumbnails.set({
          videoId,
          media: { body: createReadStream(thumbnailPath) },
        });
        logger.success("Thumbnail uploaded!");
      } catch {
        logger.warn(
          "Failed to upload thumbnail (may require channel verification)",
        );
      }
    }

    return videoId ?? null;
  } catch (error) {
    logger.error("Upload failed:", error);
    return null;
  }
}

// ------------------------------------------------------------------
// OAuth2 authentication
// ------------------------------------------------------------------

async function authenticate(
  clientSecretsPath: string,
  tokenPath: string,
) {
  if (!existsSync(clientSecretsPath)) {
    throw new Error(
      `Client secrets not found: ${clientSecretsPath}\n` +
        "Please configure YouTube API v3 credentials.\n" +
        "See: https://developers.google.com/youtube/v3/getting-started",
    );
  }

  const raw = JSON.parse(await readFile(clientSecretsPath, "utf-8"));
  const creds = raw.installed || raw.web;
  const { client_id, client_secret, redirect_uris } = creds;

  const oauth2 = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || "http://localhost",
  );

  // Re-use saved token
  if (existsSync(tokenPath)) {
    const token = JSON.parse(await readFile(tokenPath, "utf-8"));
    oauth2.setCredentials(token);

    if (token.expiry_date && token.expiry_date < Date.now()) {
      logger.info("Refreshing OAuth token…");
      const { credentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(credentials);
      await writeFile(tokenPath, JSON.stringify(credentials, null, 2));
    }
    return oauth2;
  }

  // First-time authorisation
  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/youtube.upload"],
  });

  logger.info("No OAuth token found. Please authorise:");
  console.log(`\n  Open this URL:\n  ${authUrl}\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const code = (await rl.question("Enter the authorisation code: ")).trim();
  rl.close();

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  await writeFile(tokenPath, JSON.stringify(tokens, null, 2));

  logger.success("Authorisation successful – token saved.");
  return oauth2;
}

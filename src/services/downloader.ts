// ============================================================
// YouTube video downloader  (uses yt-dlp CLI)
// ============================================================

import { existsSync } from "node:fs";
import { runCommand, checkCommand } from "../utils/command.js";
import { logger } from "../utils/logger.js";
import type { DownloadResult } from "../types.js";

/**
 * Download a YouTube video with yt-dlp  (best quality ≤ 1080p).
 * Skips the download when the target file already exists.
 */
export async function downloadVideo(
  url: string,
  title: string,
  outputDir = ".",
): Promise<DownloadResult> {
  logger.info(`Downloading video: ${title}`);

  const sanitised = title.replace(/[^a-zA-Z0-9_\-]/g, "_");
  const outputPath = `${outputDir}/${sanitised}.mp4`;

  // Skip when the file is already on disk
  if (existsSync(outputPath)) {
    logger.info(`Video already exists, skipping download: ${outputPath}`);
    const info = await probeVideo(outputPath);
    return {
      filePath: outputPath,
      frameRate: info.frameRate,
      resolution: info.resolution,
    };
  }

  // yt-dlp must be installed
  if (!(await checkCommand("yt-dlp"))) {
    throw new Error(
      "yt-dlp is not installed.\n" +
        "  pip install yt-dlp   OR   brew install yt-dlp",
    );
  }

  const result = await runCommand("yt-dlp", [
    "-f",
    "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
    "--merge-output-format",
    "mp4",
    "-o",
    outputPath,
    "--no-playlist",
    url,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to download video: ${result.stderr}`);
  }

  // Probe the downloaded file for frame rate / resolution
  const info = await probeVideo(outputPath);

  logger.success(
    `Downloaded: ${outputPath} (${info.resolution} @ ${info.frameRate}fps)`,
  );

  return {
    filePath: outputPath,
    frameRate: info.frameRate,
    resolution: info.resolution,
  };
}

// ------------------------------------------------------------------
// Internal helper: probe a local video file with ffprobe
// ------------------------------------------------------------------
async function probeVideo(
  filePath: string,
): Promise<{ frameRate: number; resolution: string }> {
  let frameRate = 30;
  let resolution = "1920:1080";

  try {
    const fps = await runCommand(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate,width,height",
        "-of",
        "csv=p=0",
        filePath,
      ],
      { silent: true },
    );

    const parts = fps.stdout.trim().split(",");
    if (parts.length >= 3) {
      const width = parseInt(parts[0], 10) || 1920;
      const height = parseInt(parts[1], 10) || 1080;
      resolution = `${width}:${height}`;
      const frac = parts[2].split("/");
      frameRate =
        frac.length === 2
          ? Math.round(parseInt(frac[0], 10) / parseInt(frac[1], 10))
          : 30;
    }
  } catch {
    logger.warn("Could not probe video, using default 1920:1080 @ 30fps");
  }

  return { frameRate, resolution };
}

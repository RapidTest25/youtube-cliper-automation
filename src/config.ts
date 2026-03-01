// ============================================================
// Default configuration for YouTube Cliper Automation
// ============================================================

import "dotenv/config";

export const DEFAULT_CONFIG = {
  editor: {
    silentThreshold: -30,
    silentDuration: 0.5,
    frameRate: 30,
    frameQuality: 1,
    frameSize: "1920:1080",
    sampleRate: 44100,
  },

  thumbnail: {
    maxThumbs: 10,
    backgroundDir: "./backgrounds",
    outputDir: "./thumbs",
    fontFamily: "Arial Black, Arial, sans-serif",
    fontSize: 70,
    logoPath: "./assets/logo.png",
    thumbnailWidth: 1280,
    thumbnailHeight: 720,
  },

  upload: {
    clientSecretsPath: "./client_secrets.json",
    tokenPath: "./token.json",
    privacyStatus: "private" as const,
    categoryId: "28",
    language: "pt-BR",
    madeForKids: false,
    publishInterval: 3,
  },

  paths: {
    listFile: "./lists/list.csv",
    outputDir: "./output",
    tempDir: "./TEMP",
    assetsDir: "./assets",
    openingVideo: "./assets/opening.mp4",
    endingVideo: "./assets/ending.mp4",
  },

  ai: {
    apiKey: process.env.GROQ_API_KEY ?? "",
    model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
    maxClips: parseInt(process.env.AI_MAX_CLIPS ?? "5", 10),
    minClipDuration: parseInt(process.env.AI_MIN_CLIP_DURATION ?? "15", 10),
    maxClipDuration: parseInt(process.env.AI_MAX_CLIP_DURATION ?? "180", 10),
  },

  vertical: {
    width: 1080,
    height: 1920,
    cropStrategy: "face-detect" as const,
    videoBitrate: "6000k",
    frameRate: 30,
  },

  podcast: {
    width: 1080,
    height: 1920,
    cropStrategy: "face-detect" as const,
    videoBitrate: "6000k",
    frameRate: 30,
    layout: "top-bottom" as const,
    gap: 6,
    dividerColor: "white",
  },

  caption: {
    enabled: (process.env.CAPTION_ENABLED ?? "true") === "true",
    model: process.env.WHISPER_MODEL ?? "base",
    maxWordsPerLine: 3,
    fontSize: 60,
    fontName: "Arial",
    primaryColor: "&H00FFFFFF",
    outlineColor: "&H00000000",
    outlineWidth: 6,
    shadowDepth: 3,
    marginV: 200,
    bold: 1,
    highlightColor: "&H0000FFFF",
  },
};

export type Config = typeof DEFAULT_CONFIG;

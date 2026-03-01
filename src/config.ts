// ============================================================
// Default configuration for YouTube Cliper Automation
// ============================================================

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
};

export type Config = typeof DEFAULT_CONFIG;

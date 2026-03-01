// ============================================================
// CSV clip-list parser
// ============================================================

import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import type { ClipEntry } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Parse a CSV file containing clip definitions.
 * Supports both English and Portuguese column headers.
 */
export async function parseClipList(filePath: string): Promise<ClipEntry[]> {
  logger.info(`Reading clip list from ${filePath}`);

  const content = await readFile(filePath, "utf-8");

  const records: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter: ",",
  });

  const clips: ClipEntry[] = records.map((row) => {
    // Support multiple header formats (EN / PT-BR)
    const url =
      row["url"] || row["Link do vídeo no YouTube"] || "";
    const cutStart =
      row["time_from"] || row["Início do corte [00:00:00]"] || "";
    const cutEnd =
      row["time_to"] || row["Fim do corte [00:00:00]"] || "";
    const podcast = parseInt(
      row["podcast"] || row["Podcast"] || "0",
      10,
    );
    const rawTitle = row["title"] || row["Título"] || "";
    const title = rawTitle.split("|")[0].trim();
    const description =
      row["description"] || row["Descrição"] || "";
    const tagsRaw = row["tags"] || row["Tags"] || "";

    return {
      url,
      cutStart: cutStart || undefined,
      cutEnd: cutEnd || undefined,
      podcast,
      title,
      description,
      tags: tagsRaw.split(" ").filter(Boolean),
    };
  });

  logger.success(`Parsed ${clips.length} clip(s) from CSV`);
  return clips;
}

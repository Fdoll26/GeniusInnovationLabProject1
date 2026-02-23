import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export type ReportInput = {
  sessionId: string;
  topic: string;
  refinedPrompt: string | null;
  summaryMode?: 'one' | 'two';
  openaiSummary?: string | null;
  geminiSummary?: string | null;
  openaiStartedAt?: string | null;
  openaiCompletedAt?: string | null;
  geminiStartedAt?: string | null;
  geminiCompletedAt?: string | null;
  references?: {
    openai: Array<{ n: number; title?: string; url: string; accessedAt?: string }>;
    gemini: Array<{ n: number; title?: string; url: string; accessedAt?: string }>;
  } | null;
  openaiText?: string | null;
  geminiText?: string | null;
  openaiSources?: unknown | null;
  geminiSources?: unknown | null;
  createdAt: string;
};

type SourceItem = { title?: string; url: string };

function sanitizePdfText(value: string) {
  return value
    .replace(/[【]/g, '[')
    .replace(/[】]/g, ']')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[•]/g, '-')
    .replace(/[—–]/g, '-')
    .replace(/…/g, '...')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');
}

function tryParseDateMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function toSentenceBullets(text: string, maxBullets: number) {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/\u0000/g, '')
    .trim();
  if (!cleaned) {
    return [];
  }
  const parts = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const bullets: string[] = [];
  for (const part of parts) {
    if (bullets.length >= maxBullets) {
      break;
    }
    if (part.length < 25) {
      continue;
    }
    bullets.push(part);
  }
  return bullets.length > 0 ? bullets : parts.slice(0, maxBullets);
}

function isUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function extractSources(sources: unknown, maxItems = 2): SourceItem[] {
  const out: SourceItem[] = [];
  const seen = new Set<string>();

  const push = (url: string, title?: string) => {
    if (!url || seen.has(url)) {
      return;
    }
    seen.add(url);
    out.push({ url, title });
  };

  const visit = (node: unknown, depth: number) => {
    if (out.length >= maxItems || depth <= 0 || node == null) {
      return;
    }
    if (isUrl(node)) {
      push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        if (out.length >= maxItems) {
          return;
        }
        visit(item, depth - 1);
      }
      return;
    }
    if (typeof node === 'object') {
      const record = node as Record<string, unknown>;
      const directUrl =
        (typeof record.url === 'string' && record.url) ||
        (typeof record.link === 'string' && record.link) ||
        (typeof record.href === 'string' && record.href) ||
        null;
      const title =
        (typeof record.title === 'string' && record.title) ||
        (typeof record.name === 'string' && record.name) ||
        (typeof record.source === 'string' && record.source) ||
        undefined;
      if (directUrl && /^https?:\/\//i.test(directUrl)) {
        push(directUrl, title);
        if (out.length >= maxItems) {
          return;
        }
      }
      for (const value of Object.values(record)) {
        if (out.length >= maxItems) {
          return;
        }
        visit(value, depth - 1);
      }
    }
  };

  visit(sources, 5);
  return out.slice(0, maxItems);
}

export async function buildPdfReport(
  input: ReportInput,
  opts?: { stub?: boolean }
): Promise<Buffer> {
  if (opts?.stub) {
    return Buffer.from(`Stub PDF for ${input.topic}`);
  }
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const margin = 50;
  const bodyFontSize = 11;
  const headingFontSize = 14;
  const lineHeight = 16;
  const initialSize = page.getSize();
  const maxWidth = initialSize.width - margin * 2;
  const brand = rgb(79 / 255, 70 / 255, 229 / 255);
  const ink = rgb(17 / 255, 24 / 255, 39 / 255);
  const muted = rgb(107 / 255, 114 / 255, 128 / 255);
  const openaiAccent = rgb(16 / 255, 185 / 255, 129 / 255);
  const geminiAccent = rgb(59 / 255, 130 / 255, 246 / 255);

  const bannerHeight = 54;
  const headerHeight = 28;

  const drawBanner = () => {
    const { width, height } = page.getSize();
    page.drawRectangle({
      x: 0,
      y: height - bannerHeight,
      width,
      height: bannerHeight,
      color: brand
    });
    page.drawText(sanitizePdfText('Multi-API Research Report'), {
      x: margin,
      y: height - 36,
      size: 18,
      font: fontBold,
      color: rgb(1, 1, 1)
    });
  };

  const drawPageHeader = () => {
    const { width, height } = page.getSize();
    page.drawText(sanitizePdfText('Multi-API Research Report'), {
      x: margin,
      y: height - headerHeight + 8,
      size: 10,
      font: fontBold,
      color: muted
    });
    page.drawRectangle({
      x: margin,
      y: height - headerHeight + 2,
      width: width - margin * 2,
      height: 1,
      color: rgb(229 / 255, 231 / 255, 235 / 255)
    });
  };

  drawBanner();
  let y = initialSize.height - bannerHeight - 28;

  const ensureSpace = (neededHeight: number) => {
    if (y < margin + neededHeight) {
      page = pdfDoc.addPage();
      drawPageHeader();
      y = page.getSize().height - headerHeight - 20;
    }
  };

  const writeLine = (
    text: string,
    options?: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> }
  ) => {
    ensureSpace(lineHeight);
    const safeText = sanitizePdfText(text);
    page.drawText(safeText, {
      x: margin,
      y,
      size: options?.size ?? bodyFontSize,
      font: options?.bold ? fontBold : font,
      color: options?.color ?? ink
    });
    y -= Math.max(lineHeight, Math.round((options?.size ?? bodyFontSize) * 1.35));
  };

  const writeParagraph = (
    text: string,
    options?: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> }
  ) => {
    const fontSize = options?.size ?? bodyFontSize;
    const activeFont = options?.bold ? fontBold : font;
    const paragraphs = sanitizePdfText(String(text))
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((p) => p.trimEnd());
    for (const paragraph of paragraphs) {
      if (!paragraph.trim()) {
        ensureSpace(lineHeight);
        y -= Math.round(fontSize * 0.6);
        continue;
      }
      const words = paragraph.split(/\s+/);
      let line = '';

      const splitLongToken = (token: string) => {
        const parts: string[] = [];
        let remaining = token;
        while (remaining.length > 0) {
          let lo = 1;
          let hi = remaining.length;
          let best = 1;
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const chunk = remaining.slice(0, mid);
            const w = activeFont.widthOfTextAtSize(chunk, fontSize);
            if (w <= maxWidth) {
              best = mid;
              lo = mid + 1;
            } else {
              hi = mid - 1;
            }
          }
          parts.push(remaining.slice(0, best));
          remaining = remaining.slice(best);
        }
        return parts;
      };

      for (const word of words) {
        const wordWidth = activeFont.widthOfTextAtSize(word, fontSize);
        if (wordWidth > maxWidth) {
          if (line) {
            writeLine(line, { bold: options?.bold, size: fontSize, color: options?.color });
            line = '';
          }
          const chunks = splitLongToken(word);
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i] as string;
            if (i === chunks.length - 1) {
              line = chunk;
            } else {
              writeLine(chunk, { bold: options?.bold, size: fontSize, color: options?.color });
            }
          }
          continue;
        }

        const testLine = line ? `${line} ${word}` : word;
        const lineWidth = activeFont.widthOfTextAtSize(testLine, fontSize);
        if (lineWidth > maxWidth && line) {
          writeLine(line, { bold: options?.bold, size: fontSize, color: options?.color });
          line = word;
        } else {
          line = testLine;
        }
      }
      if (line) {
        writeLine(line, { bold: options?.bold, size: fontSize, color: options?.color });
      }
    }
  };

  const writeSectionHeading = (title: string, accent: ReturnType<typeof rgb>) => {
    ensureSpace(28);
    const { width } = page.getSize();
    const rectHeight = 22;
    page.drawRectangle({
      x: margin,
      y: y - 6,
      width: width - margin * 2,
      height: rectHeight,
      color: rgb(249 / 255, 250 / 255, 251 / 255)
    });
    page.drawRectangle({
      x: margin,
      y: y - 6,
      width: 4,
      height: rectHeight,
      color: accent
    });
    page.drawText(sanitizePdfText(title), {
      x: margin + 10,
      y: y + 2,
      size: headingFontSize,
      font: fontBold,
      color: ink
    });
    y -= 28;
  };

  const writeProviderSummary = (provider: string, accent: ReturnType<typeof rgb>, summaryText: string) => {
    writeLine(provider, { bold: true, size: 12, color: accent });
    writeParagraph(summaryText || 'No result available.', { size: bodyFontSize });
    y -= 6;
  };

  const writeTiming = (startedAt: string | null | undefined, completedAt: string | null | undefined) => {
    const startedMs = tryParseDateMs(startedAt ?? null);
    const completedMs = tryParseDateMs(completedAt ?? null);

    writeLine(`Started: ${startedMs ? new Date(startedMs).toLocaleString() : 'N/A'}`, { size: 10, color: muted });
    writeLine(`Finished: ${completedMs ? new Date(completedMs).toLocaleString() : 'N/A'}`, { size: 10, color: muted });
    if (startedMs != null && completedMs != null && completedMs >= startedMs) {
      writeLine(`Duration: ${formatDuration(completedMs - startedMs)}`, { size: 10, color: muted });
    } else {
      writeLine('Duration: N/A', { size: 10, color: muted });
    }
    y -= 4;
  };

  const openaiFallbackBullets = toSentenceBullets(input.openaiText ?? '', 2);
  const geminiFallbackBullets = toSentenceBullets(input.geminiText ?? '', 2);
  const openaiSummary =
    (input.openaiSummary ?? '').trim() ||
    (openaiFallbackBullets.length ? openaiFallbackBullets.join(' ') : 'No OpenAI result available.');
  const geminiSummary =
    (input.geminiSummary ?? '').trim() ||
    (geminiFallbackBullets.length ? geminiFallbackBullets.join(' ') : 'No Gemini result available.');

  writeLine(`Created: ${new Date(input.createdAt).toLocaleString()}`, { size: 10, color: muted });
  writeLine(`Session: ${input.sessionId}`, { size: 10, color: muted });
  y -= 6;

  writeSectionHeading('Topic', brand);
  writeParagraph(input.topic, { size: bodyFontSize });
  y -= 4;

  writeSectionHeading('Refined Prompt', brand);
  writeParagraph(input.refinedPrompt ?? 'N/A', { size: bodyFontSize });
  y -= 8;

  writeSectionHeading('Executive Summary', brand);
  if (input.summaryMode === 'one') {
    writeProviderSummary('Summary', brand, openaiSummary);
  } else {
    writeProviderSummary('OpenAI summary', openaiAccent, openaiSummary);
    writeProviderSummary('Gemini summary', geminiAccent, geminiSummary);
  }
  y -= 10;

  writeSectionHeading('Full Results', brand);

  writeLine('OpenAI deep research', { bold: true, size: 12, color: openaiAccent });
  writeTiming(input.openaiStartedAt, input.openaiCompletedAt);
  writeParagraph(input.openaiText ?? 'No result', { size: bodyFontSize });
  y -= 8;

  writeLine('Gemini research', { bold: true, size: 12, color: geminiAccent });
  writeTiming(input.geminiStartedAt, input.geminiCompletedAt);
  writeParagraph(input.geminiText ?? 'No result', { size: bodyFontSize });

  if (input.references?.openai?.length || input.references?.gemini?.length) {
    y -= 10;
    writeSectionHeading('References', brand);
    if (input.references?.openai?.length) {
      writeLine('OpenAI references', { bold: true, size: 12, color: openaiAccent });
      for (const ref of input.references.openai) {
        writeParagraph(
          `[${ref.n}] ${ref.title ? `${ref.title} — ` : ''}${ref.url}${ref.accessedAt ? ` (accessed ${ref.accessedAt})` : ''}`,
          { size: 10, color: muted }
        );
      }
      y -= 6;
    }
    if (input.references?.gemini?.length) {
      writeLine('Gemini references', { bold: true, size: 12, color: geminiAccent });
      for (const ref of input.references.gemini) {
        writeParagraph(
          `[${ref.n}] ${ref.title ? `${ref.title} — ` : ''}${ref.url}${ref.accessedAt ? ` (accessed ${ref.accessedAt})` : ''}`,
          { size: 10, color: muted }
        );
      }
    }
  }

  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const pageText = `Page ${i + 1} of ${pages.length}`;
    p.drawText(pageText, {
      x: margin,
      y: 20,
      size: 9,
      font
    });
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

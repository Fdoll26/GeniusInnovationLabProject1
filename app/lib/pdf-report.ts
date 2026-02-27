import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export type ReportInput = {
  sessionId: string;
  topic: string;
  refinedPrompt: string | null;
  summaryMode?: 'one' | 'two';
  openaiSummary?: string | null;
  geminiSummary?: string | null;
  comparisonSection?: string | null;
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

type ReportReference = { n: number; title?: string; url: string; accessedAt?: string };

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

function demoteHeadings(markdown: string): string {
  return markdown.replace(/^(#{1,5})\s/gm, (_, hashes: string) => `${hashes}# `);
}

function buildSourcesSection(refs: ReportReference[]): string {
  if (!refs.length) return '';
  const lines = refs.map((ref) => `[${ref.n}] ${ref.title ? `${ref.title} - ` : ''}${ref.url}`);
  return `\n\n## Sources\n\n${lines.join('\n')}`;
}

function replaceUrlsWithReferenceNumbers(text: string, refs: ReportReference[]): string {
  if (!text.trim() || refs.length === 0) return text;
  const refByUrl = new Map(refs.map((ref) => [ref.url, ref.n]));
  const markdownLinked = text.replace(/\[[^\]]+\]\((https?:\/\/[^\s<>"')]+)\)/g, (whole, url: string) => {
    const clean = url.replace(/[),.;:!?]+$/, '');
    const n = refByUrl.get(clean);
    return n ? `[${n}]` : whole;
  });
  const bracketed = markdownLinked.replace(/\[(https?:\/\/[^\s<>"'\]]+)\]/g, (whole, url: string) => {
    const clean = url.replace(/[),.;:!?]+$/, '');
    const n = refByUrl.get(clean);
    return n ? `[${n}]` : whole;
  });
  const regex = /https?:\/\/[^\s<>"']+/g;
  return bracketed.replace(regex, (raw) => {
    const clean = raw.replace(/[),.;:!?]+$/, '');
    const suffix = raw.slice(clean.length);
    const n = refByUrl.get(clean);
    return n ? `[${n}]${suffix}` : raw;
  });
}

function stripEmbeddedSourcesSection(markdown: string): string {
  if (!markdown.trim()) return markdown;
  return markdown
    .replace(/\n#{1,6}\s+sources\b[\s\S]*$/im, '')
    .replace(/\n##\s+references\b[\s\S]*$/im, '')
    .trim();
}

function isGroundingLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host === 'google.com' || host.endsWith('.google.com')) {
      if (path.startsWith('/search') || path.startsWith('/url') || path.startsWith('/imgres')) {
        return true;
      }
    }
    if (
      host.includes('googleusercontent.com') ||
      host.includes('generativelanguage.googleapis.com') ||
      host.includes('vertexaisearch.cloud.google.com') ||
      host.includes('ai.google.dev')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function sanitizeRefs(refs: ReportReference[]): ReportReference[] {
  const out: ReportReference[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref?.url || isGroundingLink(ref.url)) {
      continue;
    }
    if (seen.has(ref.url)) {
      continue;
    }
    seen.add(ref.url);
    out.push(ref);
  }
  return out;
}

function deriveRefsFromText(text: string): ReportReference[] {
  if (!text.trim()) return [];
  const regex = /https?:\/\/[^\s<>"')\]]+/g;
  const seen = new Set<string>();
  const out: ReportReference[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    if (!raw) continue;
    const clean = raw.replace(/[),.;:!?]+$/, '');
    if (!clean || seen.has(clean) || isGroundingLink(clean)) {
      continue;
    }
    seen.add(clean);
    out.push({ n: out.length + 1, url: clean });
  }
  return out;
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

  const timingMarkdown = (startedAt: string | null | undefined, completedAt: string | null | undefined): string => {
    const startedMs = tryParseDateMs(startedAt ?? null);
    const completedMs = tryParseDateMs(completedAt ?? null);
    const startedLine = `Started: ${startedMs ? new Date(startedMs).toLocaleString() : 'N/A'}`;
    const finishedLine = `Finished: ${completedMs ? new Date(completedMs).toLocaleString() : 'N/A'}`;
    const durationLine =
      startedMs != null && completedMs != null && completedMs >= startedMs
        ? `Duration: ${formatDuration(completedMs - startedMs)}`
        : 'Duration: N/A';
    return `${startedLine}\n${finishedLine}\n${durationLine}`;
  };

  const stripInlineMarkdown = (text: string): string => {
    return text
      .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/_(.+?)_/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`([^`]+)`/g, '[$1]')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();
  };

  const writeWrappedTextAt = (text: string, startX: number, textMaxWidth: number) => {
    const words = text.split(/\s+/);
    let line = '';
    for (const word of words) {
      const testLine = line ? `${line} ${word}` : word;
      const lineWidth = font.widthOfTextAtSize(testLine, bodyFontSize);
      if (lineWidth > textMaxWidth && line) {
        ensureSpace(lineHeight);
        page.drawText(sanitizePdfText(line), {
          x: startX,
          y,
          size: bodyFontSize,
          font,
          color: ink
        });
        y -= lineHeight;
        line = word;
      } else {
        line = testLine;
      }
    }
    if (line) {
      ensureSpace(lineHeight);
      page.drawText(sanitizePdfText(line), {
        x: startX,
        y,
        size: bodyFontSize,
        font,
        color: ink
      });
      y -= lineHeight;
    }
  };

  const writeMarkdown = (rawText: string) => {
    if (!rawText) return;
    const lines = sanitizePdfText(rawText)
      .replace(/\r\n/g, '\n')
      .split('\n');

    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';

      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) {
        writeLine(`  ${line}`, { size: 9, color: muted });
        continue;
      }

      if (!line.trim()) {
        ensureSpace(lineHeight);
        y -= Math.round(bodyFontSize * 0.5);
        continue;
      }

      if (line.startsWith('# ')) {
        const text = line.slice(2).replace(/\*\*/g, '').trim();
        ensureSpace(36);
        y -= 8;
        writeLine(text, { bold: true, size: 16, color: ink });
        y -= 4;
        continue;
      }

      if (line.startsWith('## ')) {
        const text = line.slice(3).replace(/\*\*/g, '').trim();
        writeSectionHeading(text, brand);
        continue;
      }

      if (line.startsWith('### ')) {
        const text = line.slice(4).replace(/\*\*/g, '').trim();
        ensureSpace(26);
        y -= 4;
        writeLine(text, { bold: true, size: 13, color: ink });
        y -= 2;
        continue;
      }

      if (/^#{4,6} /.test(line)) {
        const text = line.replace(/^#{4,6} /, '').replace(/\*\*/g, '').trim();
        writeLine(text, { bold: true, size: bodyFontSize, color: ink });
        continue;
      }

      if (/^[-*_]{3,}$/.test(line.trim())) {
        ensureSpace(lineHeight);
        const { width } = page.getSize();
        page.drawRectangle({
          x: margin,
          y: y + 4,
          width: width - margin * 2,
          height: 1,
          color: rgb(229 / 255, 231 / 255, 235 / 255)
        });
        y -= lineHeight;
        continue;
      }

      if (/^[\s]*[-*+] /.test(line)) {
        const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
        const nestLevel = Math.floor(indent / 2);
        const bulletX = margin + 10 + nestLevel * 14;
        const textContent = line.replace(/^[\s]*[-*+] /, '').trim();
        const rendered = stripInlineMarkdown(textContent);

        ensureSpace(lineHeight);
        page.drawText('•', {
          x: bulletX,
          y,
          size: bodyFontSize,
          font: fontBold,
          color: ink
        });
        const textX = bulletX + 12;
        const textMaxWidth = maxWidth - (textX - margin);
        writeWrappedTextAt(rendered, textX, textMaxWidth);
        continue;
      }

      if (/^[\s]*\d+\. /.test(line)) {
        const numMatch = line.match(/^([\s]*)(\d+)\. (.*)/);
        if (numMatch) {
          const indent = numMatch[1]?.length ?? 0;
          const num = numMatch[2];
          const textContent = (numMatch[3] ?? '').trim();
          const nestLevel = Math.floor(indent / 2);
          const numX = margin + 10 + nestLevel * 14;
          const rendered = stripInlineMarkdown(textContent);

          ensureSpace(lineHeight);
          page.drawText(`${num}.`, {
            x: numX,
            y,
            size: bodyFontSize,
            font,
            color: ink
          });
          const textX = numX + 20;
          const textMaxWidth = maxWidth - (textX - margin);
          writeWrappedTextAt(rendered, textX, textMaxWidth);
          continue;
        }
      }

      if (line.startsWith('> ')) {
        const text = stripInlineMarkdown(line.slice(2).trim());
        ensureSpace(lineHeight + 4);
        page.drawRectangle({
          x: margin,
          y: y - 2,
          width: 3,
          height: lineHeight,
          color: muted
        });
        writeParagraph(text, { size: bodyFontSize, color: muted });
        continue;
      }

      const boldOnlyMatch = line.match(/^\*\*([^*]+)\*\*\s*:?\s*$/);
      if (boldOnlyMatch) {
        writeLine((boldOnlyMatch[1] ?? '').trim(), { bold: true, size: bodyFontSize + 1, color: ink });
        continue;
      }

      const rendered = stripInlineMarkdown(line);
      writeParagraph(rendered, { size: bodyFontSize });
    }
  };

  writeLine(`Created: ${new Date(input.createdAt).toLocaleString()}`, { size: 10, color: muted });
  writeLine(`Session: ${input.sessionId}`, { size: 10, color: muted });
  y -= 6;

  writeSectionHeading('Topic', brand);
  writeParagraph(input.topic, { size: bodyFontSize });
  y -= 4;

  writeSectionHeading('Refined Prompt', brand);
  writeParagraph(input.refinedPrompt ?? 'N/A', { size: bodyFontSize });
  y -= 8;

  y -= 6;
  const openaiRefsInput = input.references?.openai ?? [];
  const geminiRefsInput = input.references?.gemini ?? [];
  const openaiRefs =
    openaiRefsInput.length > 0
      ? sanitizeRefs(openaiRefsInput)
      : deriveRefsFromText(stripEmbeddedSourcesSection(input.openaiText ?? ''));
  const geminiRefs =
    geminiRefsInput.length > 0
      ? sanitizeRefs(geminiRefsInput)
      : deriveRefsFromText(stripEmbeddedSourcesSection(input.geminiText ?? ''));

  const overviewText = (input.comparisonSection && input.comparisonSection.trim()) || 'Comparison not available.';
  const openaiBody = replaceUrlsWithReferenceNumbers(
    stripEmbeddedSourcesSection(input.openaiText ?? 'No result'),
    openaiRefs
  );
  const geminiBody = replaceUrlsWithReferenceNumbers(
    stripEmbeddedSourcesSection(input.geminiText ?? 'No result'),
    geminiRefs
  );

  const overviewSection = `# Overview\n\n${demoteHeadings(overviewText)}`;
  const openaiSection =
    `# OpenAI\n\n## Run Timing\n\n${timingMarkdown(input.openaiStartedAt, input.openaiCompletedAt)}\n\n` +
    `${demoteHeadings(openaiBody)}${buildSourcesSection(openaiRefs)}`;
  const geminiSection =
    `# Gemini\n\n## Run Timing\n\n${timingMarkdown(input.geminiStartedAt, input.geminiCompletedAt)}\n\n` +
    `${demoteHeadings(geminiBody)}${buildSourcesSection(geminiRefs)}`;

  writeMarkdown([overviewSection, openaiSection, geminiSection].join('\n\n---\n\n'));

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

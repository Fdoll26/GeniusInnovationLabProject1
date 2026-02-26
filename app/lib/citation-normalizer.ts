import type { ResearchProviderName } from './research-types';

export type NormalizedReference = {
  n: number;
  url: string;
  title?: string | null;
};

export type NormalizedCitationResult = {
  outputTextWithRefs: string;
  references: NormalizedReference[];
};

type UrlPlacement = {
  at: number;
  urls: Array<{ url: string; title?: string | null }>;
};

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/[.,;:!?]+$/, '');
}

function sourceMapFromUnknown(node: unknown): Map<string, { url: string; title?: string | null }> {
  const out = new Map<string, { url: string; title?: string | null }>();
  const visit = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object') return;
    const rec = value as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : null;
    const urlRaw =
      (typeof rec.url === 'string' && rec.url) ||
      (typeof rec.uri === 'string' && rec.uri) ||
      (typeof rec.href === 'string' && rec.href) ||
      null;
    if (id && urlRaw && isHttpUrl(urlRaw)) {
      out.set(id, { url: normalizeUrl(urlRaw), title: typeof rec.title === 'string' ? rec.title : null });
    }
    for (const nested of Object.values(rec)) {
      if (nested && typeof nested === 'object') visit(nested);
    }
  };
  visit(node);
  return out;
}

function uniqueByUrl(items: Array<{ url: string; title?: string | null }>) {
  const seen = new Set<string>();
  const out: Array<{ url: string; title?: string | null }> = [];
  for (const item of items) {
    const url = normalizeUrl(item.url);
    if (!isHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: item.title ?? null });
  }
  return out;
}

function normalizeFromPlacements(text: string, placements: UrlPlacement[]): NormalizedCitationResult {
  const ordered = [...placements]
    .map((p) => ({
      at: Math.max(0, Math.min(text.length, p.at)),
      urls: uniqueByUrl(p.urls)
    }))
    .filter((p) => p.urls.length > 0)
    .sort((a, b) => a.at - b.at);

  const refByUrl = new Map<string, NormalizedReference>();
  const refs: NormalizedReference[] = [];
  for (const placement of ordered) {
    for (const item of placement.urls) {
      if (refByUrl.has(item.url)) continue;
      const next: NormalizedReference = { n: refs.length + 1, url: item.url, title: item.title ?? null };
      refByUrl.set(item.url, next);
      refs.push(next);
    }
  }

  const atMap = new Map<number, string[]>();
  for (const placement of ordered) {
    const snippets: string[] = [];
    for (const item of placement.urls) {
      const ref = refByUrl.get(item.url);
      if (!ref) continue;
      snippets.push(`[${ref.n}](${ref.url})`);
    }
    if (snippets.length === 0) continue;
    const existing = atMap.get(placement.at) ?? [];
    atMap.set(placement.at, [...existing, ...snippets]);
  }

  const applied = [...atMap.entries()].sort((a, b) => b[0] - a[0]);
  let outputTextWithRefs = text;
  for (const [at, snippets] of applied) {
    const unique = Array.from(new Set(snippets));
    const needsSpace = at > 0 && !/\s/.test(outputTextWithRefs[at - 1] ?? '');
    const cite = unique.join(' ');
    outputTextWithRefs = `${outputTextWithRefs.slice(0, at)}${needsSpace ? ' ' : ''}${cite}${outputTextWithRefs.slice(at)}`;
  }

  return { outputTextWithRefs, references: refs };
}

export function normalizeOpenAiCitations(params: {
  text: string;
  annotations: unknown;
  sources?: unknown;
}): NormalizedCitationResult {
  const text = params.text ?? '';
  const sourceById = sourceMapFromUnknown(params.sources);
  const annotations = Array.isArray(params.annotations) ? (params.annotations as Array<Record<string, unknown>>) : [];
  const placements: UrlPlacement[] = [];
  for (const ann of annotations) {
    const type = typeof ann.type === 'string' ? ann.type : '';
    if (type && type !== 'url_citation') continue;
    const endRaw = ann.end_index ?? ann.endIndex;
    if (typeof endRaw !== 'number' || !Number.isFinite(endRaw)) continue;
    const urlRaw =
      (typeof ann.url === 'string' && ann.url) ||
      (typeof ann.uri === 'string' && ann.uri) ||
      null;
    const sourceId =
      (typeof ann.source_id === 'string' && ann.source_id) ||
      (typeof ann.sourceId === 'string' && ann.sourceId) ||
      null;

    const bySource = sourceId ? sourceById.get(sourceId) : null;
    const url = urlRaw && isHttpUrl(urlRaw) ? normalizeUrl(urlRaw) : bySource?.url ?? null;
    if (!url) continue;
    placements.push({
      at: endRaw,
      urls: [{ url, title: typeof ann.title === 'string' ? ann.title : bySource?.title ?? null }]
    });
  }
  return normalizeFromPlacements(text, placements);
}

export function normalizeGeminiCitations(params: {
  text: string;
  groundingMetadata: unknown;
}): NormalizedCitationResult {
  const text = params.text ?? '';
  const md = params.groundingMetadata as {
    groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    groundingSupports?: Array<{
      segment?: { startIndex?: number; endIndex?: number };
      groundingChunkIndices?: number[];
    }>;
  } | null;

  const chunks = Array.isArray(md?.groundingChunks) ? md.groundingChunks : [];
  const supports = Array.isArray(md?.groundingSupports) ? md.groundingSupports : [];
  const placements: UrlPlacement[] = [];

  for (const support of supports) {
    const segment = support?.segment;
    const endIndex =
      (typeof segment?.endIndex === 'number' && Number.isFinite(segment.endIndex) && segment.endIndex >= 0 && segment.endIndex) ||
      (typeof segment?.startIndex === 'number' && Number.isFinite(segment.startIndex) && segment.startIndex >= 0 && segment.startIndex) ||
      null;
    if (endIndex == null) continue;
    const urls: Array<{ url: string; title?: string | null }> = [];
    const indices = Array.isArray(support.groundingChunkIndices) ? support.groundingChunkIndices : [];
    for (const idx of indices) {
      if (typeof idx !== 'number' || idx < 0 || !Number.isFinite(idx)) continue;
      const chunk = chunks[idx];
      const url = chunk?.web?.uri;
      if (!isHttpUrl(url)) continue;
      urls.push({ url: normalizeUrl(url), title: typeof chunk?.web?.title === 'string' ? chunk.web.title : null });
    }
    if (urls.length === 0) continue;
    placements.push({ at: endIndex, urls });
  }

  if (placements.length === 0 && chunks.length > 0) {
    const fallbackUrls: Array<{ url: string; title?: string | null }> = [];
    for (const chunk of chunks) {
      if (!isHttpUrl(chunk?.web?.uri)) continue;
      fallbackUrls.push({
        url: normalizeUrl(chunk.web.uri),
        title: typeof chunk?.web?.title === 'string' ? chunk.web.title : null
      });
    }
    if (fallbackUrls.length > 0) {
      placements.push({ at: text.length, urls: fallbackUrls });
    }
  }

  return normalizeFromPlacements(text, placements);
}

export function normalizeProviderCitations(params: {
  provider: ResearchProviderName;
  text: string;
  citationMetadata: unknown;
  sources?: unknown;
}): NormalizedCitationResult {
  if (params.provider === 'openai') {
    return normalizeOpenAiCitations({
      text: params.text,
      annotations: params.citationMetadata,
      sources: params.sources
    });
  }
  return normalizeGeminiCitations({
    text: params.text,
    groundingMetadata: params.citationMetadata
  });
}

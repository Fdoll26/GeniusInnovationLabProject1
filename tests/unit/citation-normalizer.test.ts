// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeGeminiCitations, normalizeOpenAiCitations, normalizeProviderCitations } from '../../app/lib/citation-normalizer';

const openAiFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tests/fixtures/citations/openai-normalization.json'), 'utf8')
);
const geminiFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tests/fixtures/citations/gemini-normalization.json'), 'utf8')
);

describe('citation-normalizer', () => {
  it('normalizes openai url_citation spans into numbered hyperlinks', () => {
    const out = normalizeOpenAiCitations({
      text: openAiFixture.text,
      annotations: openAiFixture.annotations,
      sources: openAiFixture.sources
    });

    expect(out.references).toEqual([
      { n: 1, url: 'https://alpha.example/source', title: 'Alpha Source' },
      { n: 2, url: 'https://beta.example/report', title: 'Beta Report' }
    ]);
    expect(out.outputTextWithRefs).toContain('[1](https://alpha.example/source)');
    expect(out.outputTextWithRefs).toContain('[2](https://beta.example/report)');
  });

  it('normalizes gemini grounding supports/chunks into numbered hyperlinks', () => {
    const out = normalizeGeminiCitations({
      text: geminiFixture.text,
      groundingMetadata: geminiFixture.groundingMetadata
    });

    expect(out.references).toEqual([
      { n: 1, url: 'https://gamma.example/paper', title: 'Gamma Paper' },
      { n: 2, url: 'https://delta.example/data', title: 'Delta Data' }
    ]);
    expect(out.outputTextWithRefs).toContain('[1](https://gamma.example/paper)');
    expect(out.outputTextWithRefs).toContain('[2](https://delta.example/data)');
  });

  it('keeps stable numbering by first appearance for provider-agnostic entrypoint', () => {
    const out = normalizeProviderCitations({
      provider: 'openai',
      text: 'A B A',
      citationMetadata: [
        { type: 'url_citation', start_index: 0, end_index: 1, url: 'https://a.example' },
        { type: 'url_citation', start_index: 2, end_index: 3, url: 'https://b.example' },
        { type: 'url_citation', start_index: 4, end_index: 5, url: 'https://a.example' }
      ],
      sources: null
    });

    expect(out.references).toEqual([
      { n: 1, url: 'https://a.example', title: null },
      { n: 2, url: 'https://b.example', title: null }
    ]);
    expect((out.outputTextWithRefs.match(/\[1\]\(https:\/\/a\.example\)/g) ?? []).length).toBeGreaterThan(1);
  });
});

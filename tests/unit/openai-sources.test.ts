// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getResponseSources, getResponseWebSearchCallSources } from '../../app/lib/openai-client';

describe('openai web search source extraction', () => {
  it('extracts and deduplicates web_search_call.action.sources for audit', () => {
    const data = {
      output: [
        {
          type: 'web_search_call',
          action: {
            sources: [
              { url: 'https://a.example', title: 'A' },
              { uri: 'https://b.example', title: 'B' },
              { url: 'https://a.example', title: 'A duplicate' }
            ]
          }
        }
      ]
    };

    const sources = getResponseWebSearchCallSources(data);
    expect(sources).toEqual([
      { url: 'https://a.example', title: 'A' },
      { url: 'https://b.example', title: 'B' }
    ]);
  });

  it('returns combined response + consulted sources payload', () => {
    const payload = getResponseSources({
      sources: [{ url: 'https://top.example', title: 'Top' }],
      output: [
        {
          type: 'web_search_call',
          action: { sources: [{ url: 'https://consulted.example', title: 'Consulted' }] }
        }
      ]
    }) as { response_sources: unknown; web_search_call_sources: Array<{ url: string; title?: string | null }> };

    expect(Array.isArray(payload.response_sources)).toBe(true);
    expect(payload.web_search_call_sources).toEqual([{ url: 'https://consulted.example', title: 'Consulted' }]);
  });
});

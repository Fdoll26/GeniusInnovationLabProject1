// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/openai-client', () => ({
  runOpenAiReasoningStep: vi.fn(async () => ({
    text: JSON.stringify({
      objectives: ['discover'],
      outline: ['summary'],
      sections: [
        {
          section: 'summary',
          objectives: ['discover'],
          query_pack: ['q1'],
          acceptance_criteria: ['c1']
        }
      ],
      source_quality_requirements: {
        primary_sources_required: true,
        recency: 'recent',
        geography: 'global',
        secondary_sources_allowed: true
      },
      token_budgets: {},
      output_budgets: {}
    }),
    responseId: 'r1',
    usage: null
  })),
  startResearchJob: vi.fn(async () => ({
    responseId: null,
    status: 'completed',
    data: {
      output_text: 'native text https://example.com https://example.com',
      sources: [{ url: 'https://example.com', title: 'Example' }, { url: 'https://example.com', title: 'Example Duplicate' }]
    }
  })),
  pollDeepResearch: vi.fn(async () => ({ status: 'completed', data: { output_text: 'native text https://example.com' } })),
  getResponseOutputText: vi.fn(() => 'native text https://example.com'),
  getResponseSources: vi.fn(() => null)
}));

vi.mock('../../app/lib/gemini-client', () => ({
  runGeminiReasoningStep: vi.fn(async () => ({
    text: 'This is a long evidence-bearing line with details and context for extraction https://example.org',
    sources: null,
    usage: null
  })),
  runGemini: vi.fn(async () => ({
    outputText:
      'This collected finding line is intentionally long and detailed to exceed the evidence extraction threshold while citing https://example.org',
    sources: null
  }))
}));

import { executeCustomStep, generateResearchPlan } from '../../app/lib/research-provider';

describe('research-provider', () => {
  it('generates a structured plan', async () => {
    const out = await generateResearchPlan({
      provider: 'openai',
      question: 'What are 2026 EV battery trends?',
      depth: 'standard',
      maxSteps: 8,
      targetSourcesPerStep: 5,
      maxTokensPerStep: 1800,
      timeoutMs: 30_000
    });

    expect(out.needsClarification).toBe(false);
    expect(out.plan.sections.length).toBeGreaterThan(0);
    expect(out.plan.sections[0]?.query_pack[0]).toBe('q1');
  });

  it('extracts sources/evidence for a custom step', async () => {
    const out = await executeCustomStep({
      provider: 'gemini',
      stepType: 'DISCOVER',
      stepGoal: 'discover',
      queryPack: ['query'],
      question: 'question',
      priorSummary: 'prior',
      sourceTarget: 3,
      maxOutputTokens: 900,
      timeoutMs: 20_000
    });

    expect(out.sources.length).toBeGreaterThan(0);
    expect(out.evidence.length).toBeGreaterThan(0);
    expect(out.citations.length).toBeGreaterThan(0);
  });

  it('deduplicates citations by URL', async () => {
    const out = await executeCustomStep({
      provider: 'openai',
      stepType: 'DISCOVER',
      stepGoal: 'discover',
      queryPack: ['query'],
      question: 'question',
      priorSummary: 'prior',
      sourceTarget: 5,
      maxOutputTokens: 1200,
      timeoutMs: 20_000
    });

    const urls = out.citations.map((c) => c.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.filter((u) => u === 'https://example.com').length).toBe(1);
  });
});

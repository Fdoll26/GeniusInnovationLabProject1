// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const openAiPlanFixture = readFileSync(path.resolve(process.cwd(), 'tests/fixtures/llm/research-plan-openai.json'), 'utf8');
const geminiPlanFixture = readFileSync(path.resolve(process.cwd(), 'tests/fixtures/llm/research-plan-gemini.json'), 'utf8');

const runOpenAiReasoningStep = vi.fn(async () => ({
  text: openAiPlanFixture,
  responseId: 'r1',
  usage: null
}));

const runGeminiReasoningStep = vi.fn(async () => ({
  text: geminiPlanFixture,
  sources: null,
  usage: null
}));
const runGeminiReasoningStepFanOut = vi.fn(async () => ({
  text: geminiPlanFixture,
  sources: null,
  usage: null,
  subcallResults: [],
  coverageMetrics: {
    subcallsPlanned: 0,
    subcallsCompleted: 0,
    subcallsFailed: 0,
    uniqueSources: 0,
    uniqueDomains: 0,
    webSearchQueryCount: 0,
    groundedSegments: 0,
    avgConfidence: null
  },
  rankedSources: []
}));

vi.mock('../../app/lib/openai-client', () => ({
  runOpenAiReasoningStep: (...args: any[]) => runOpenAiReasoningStep(...args),
  startResearchJob: vi.fn(async () => ({
    responseId: null,
    status: 'completed',
    data: {
      output_text: 'native text https://example.com https://example.com',
      sources: [{ url: 'https://example.com', title: 'Example' }, { url: 'https://example.com', title: 'Example Duplicate' }]
    }
  })),
  pollDeepResearch: vi.fn(async () => ({ status: 'completed', data: { output_text: 'native text https://example.com' } })),
  getResponsePrimaryMessageContent: vi.fn(() => null),
  getResponseOutputText: vi.fn(() => 'native text https://example.com'),
  getResponseSources: vi.fn(() => null),
  generateModelComparisonOpenAI: vi.fn(async () => 'comparison')
}));

vi.mock('../../app/lib/gemini-client', () => ({
  runGeminiReasoningStep: (...args: any[]) => runGeminiReasoningStep(...args),
  runGeminiReasoningStepFanOut: (...args: any[]) => runGeminiReasoningStepFanOut(...args),
  runGemini: vi.fn(async () => ({
    outputText:
      'This collected finding line is intentionally long and detailed to exceed the evidence extraction threshold while citing https://example.org',
    sources: null
  })),
  looksTruncated: vi.fn(() => false),
  extractGeminiGroundingMetadata: vi.fn(() => null),
  generateModelComparisonGemini: vi.fn(async () => 'comparison')
}));

import { executeCustomStep, generateResearchPlan } from '../../app/lib/research-provider';

describe('research-provider', () => {
  it('generates a structured plan for openai from fixture output', async () => {
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
    expect(out.plan.steps.length).toBeGreaterThan(0);
    expect(out.plan.steps[0]?.step_type).toBe('DEVELOP_RESEARCH_PLAN');
    expect(out.plan.steps[1]?.search_query_pack[0]).toContain('IEA');
    expect(runOpenAiReasoningStep).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredOutput: expect.objectContaining({
          schemaName: 'research_plan'
        })
      })
    );
  });

  it('generates a structured plan for gemini from fixture output', async () => {
    const out = await generateResearchPlan({
      provider: 'gemini',
      question: 'What are 2026 EV battery trends?',
      depth: 'standard',
      maxSteps: 8,
      targetSourcesPerStep: 5,
      maxTokensPerStep: 1800,
      timeoutMs: 30_000
    });

    expect(out.plan.steps.length).toBe(8);
    expect(out.plan.steps[0]?.step_type).toBe('DEVELOP_RESEARCH_PLAN');
    expect(out.plan.steps[7]?.step_type).toBe('SECTION_SYNTHESIS');
    expect(runGeminiReasoningStep).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredOutput: expect.objectContaining({
          jsonSchema: expect.any(Object)
        })
      })
    );
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

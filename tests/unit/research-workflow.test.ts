// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { WORKFLOW_STEPS, canTransitionStep, nextWorkflowStep } from '../../app/lib/research-workflow';

describe('research workflow transitions', () => {
  it('uses the required 8-step sequence in order', () => {
    expect(WORKFLOW_STEPS).toEqual([
      'DEVELOP_RESEARCH_PLAN',
      'DISCOVER_SOURCES_WITH_PLAN',
      'SHORTLIST_RESULTS',
      'DEEP_READ',
      'EXTRACT_EVIDENCE',
      'COUNTERPOINTS',
      'GAP_CHECK',
      'SECTION_SYNTHESIS'
    ]);
  });

  it('allows forward transitions plus gap-loop back to discover', () => {
    expect(canTransitionStep('DEVELOP_RESEARCH_PLAN', 'DISCOVER_SOURCES_WITH_PLAN')).toBe(true);
    expect(canTransitionStep('DEEP_READ', 'EXTRACT_EVIDENCE')).toBe(true);
    expect(canTransitionStep('EXTRACT_EVIDENCE', 'SECTION_SYNTHESIS')).toBe(true);
    expect(canTransitionStep('GAP_CHECK', 'DISCOVER_SOURCES_WITH_PLAN')).toBe(true);

    expect(canTransitionStep('DEEP_READ', 'DISCOVER_SOURCES_WITH_PLAN')).toBe(false);
    expect(canTransitionStep('SHORTLIST_RESULTS', 'DEVELOP_RESEARCH_PLAN')).toBe(false);
    expect(canTransitionStep('SECTION_SYNTHESIS', 'GAP_CHECK')).toBe(false);
  });

  it('computes next step correctly', () => {
    expect(nextWorkflowStep('COUNTERPOINTS')).toBe('GAP_CHECK');
    expect(nextWorkflowStep('SECTION_SYNTHESIS')).toBeNull();
  });
});

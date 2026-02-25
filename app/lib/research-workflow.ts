import { STEP_SEQUENCE, type StepType } from './research-types';

export const WORKFLOW_STEPS = STEP_SEQUENCE;

export function nextWorkflowStep(step: Exclude<StepType, 'NATIVE_SECTION'>): Exclude<StepType, 'NATIVE_SECTION'> | null {
  const idx = WORKFLOW_STEPS.indexOf(step);
  if (idx < 0) return null;
  return WORKFLOW_STEPS[idx + 1] ?? null;
}

export function canTransitionStep(
  from: Exclude<StepType, 'NATIVE_SECTION'>,
  to: Exclude<StepType, 'NATIVE_SECTION'>
): boolean {
  const direct = nextWorkflowStep(from);
  if (direct === to) return true;
  // Gap remediation loop: GAP_CHECK can loop once back to DISCOVER_SOURCES_WITH_PLAN.
  if (from === 'GAP_CHECK' && to === 'DISCOVER_SOURCES_WITH_PLAN') return true;
  return false;
}

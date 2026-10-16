/**
 * Demo harness — result contracts.
 *
 * Every scenario returns this structure, so the UI never has to guess how a result should be read:
 * a scenario states *what kind of evidence it is* (`kind`), whether it really passed (`status`) and
 * what data it observed (`output`).
 */

/** How much of a scenario is the real application and how much is test scaffolding. */
export type ScenarioKind =
  /** The real service was called with a clearly-labelled DEMO input; no transport involved. */
  | 'REAL_CODE + DEMO_DATA'
  /** The real service was called; only the network transport was replaced by a capture double. */
  | 'REAL_CODE + SIMULATED_TRANSPORT'
  /** A report about the repository itself (files, test results, configuration). */
  | 'REPOSITORY EVIDENCE';

export interface ScenarioStep {
  /** Short Persian label of what happened. */
  labelFa: string;
  /** The observed value (already formatted, safe to render). */
  detail: string;
  ok: boolean;
}

export interface ScenarioResult {
  id: string;
  titleFa: string;
  kind: ScenarioKind;
  /** Which phases of the project this scenario exercises. */
  phases: number[];
  startedAt: string;
  durationMs: number;
  status: 'PASS' | 'FAIL';
  summaryFa: string;
  steps: ScenarioStep[];
  /** Scenario-specific structured payload (rendered as JSON by the UI when present). */
  output: unknown;
  error: string | null;
}

/** A single outbound call that the capture transport swallowed instead of sending it. */
export interface CapturedCall {
  at: string;
  platform: string;
  method: string;
  chatId: string;
  /** Message text or caption, exactly as the project rendered it. */
  text: string;
  /** Number of keyboard rows that travelled with the message (0 = no keyboard). */
  keyboardRows: number;
  success: boolean;
  simulatedFailure: boolean;
  error: string | null;
}

export interface DemoRunSummary {
  scenarioId: string;
  result: ScenarioResult;
  capture: CapturedCall[];
}

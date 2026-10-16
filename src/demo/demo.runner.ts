/**
 * Demo harness — runner.
 *
 * Owns one application context at a time and guarantees that every scenario starts from a clean,
 * reproducible state: the context is disposed, the scratch directory is wiped and the module is
 * rebuilt. That is what makes a scenario runnable in any order, repeatedly, with the same result —
 * which is the whole point of a demo.
 */

import { resetDemoData } from './demo-boot';
import { createDemoContext, type DemoContext } from './demo-context';
import { demoCapture } from './demo-transport';
import { SCENARIOS } from './demo.scenarios';
import type { DemoRunSummary, ScenarioResult } from './demo.types';

export interface ScenarioDescriptor {
  id: string;
  titleFa: string;
  descriptionFa: string;
}

export class DemoRunner {
  private context: DemoContext | null = null;

  list(): ScenarioDescriptor[] {
    return SCENARIOS.map(({ id, titleFa, descriptionFa }) => ({
      id,
      titleFa,
      descriptionFa,
    }));
  }

  /** The current context, rebuilt on demand. */
  async ensureContext(): Promise<DemoContext> {
    if (!this.context) {
      this.context = await createDemoContext();
    }

    return this.context;
  }

  /** Dispose the context, wipe every demo artefact and start over. */
  async reset(): Promise<void> {
    if (this.context) {
      const previous = this.context;
      this.context = null;
      await previous.dispose();
    }

    resetDemoData();
    demoCapture.clear();
    demoCapture.heal('bale');
    demoCapture.heal('telegram');
  }

  /** Ids of the scenarios the demo offers (the `run` handlers stay private). */
  async run(id: string): Promise<DemoRunSummary> {
    await this.reset();

    const entry = SCENARIOS.find((candidate) => candidate.id === id);

    if (!entry) {
      throw new Error(
        `DEMO: scenario "${id}" does not exist. Available: ${SCENARIOS.map((s) => s.id).join(', ')}`,
      );
    }

    const context = await this.ensureContext();
    const result: ScenarioResult = await entry.run(context);

    return {
      scenarioId: id,
      result,
      capture: demoCapture.list(),
    };
  }

  /** Run every scenario in order (used by the CLI's `--json` mode and by the audit). */
  async runAll(): Promise<DemoRunSummary[]> {
    const summaries: DemoRunSummary[] = [];

    for (const entry of SCENARIOS) {
      summaries.push(await this.run(entry.id));
    }

    return summaries;
  }

  async dispose(): Promise<void> {
    if (this.context) {
      const previous = this.context;
      this.context = null;
      await previous.dispose();
    }
  }
}

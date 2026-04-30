/**
 * Public entry point. Import surface for quaestor-core (and only quaestor-core
 * — this package is opinionated about being a plugin, not a library).
 */
export {
  evaluateRedemption,
  EvaluateInputSchema,
  HARD_REJECT_THRESHOLD,
  preload,
  resetForTesting,
} from './evaluate.js';
export type { EvaluateInput, EvaluateResult, Enforcement } from './evaluate.js';
export type { MandateSummary, RedemptionContext, PromptInput } from './prompt.js';
export {
  downloadModel,
  modelExists,
  modelPath,
  ModelMissingError,
  QWEN_2_5_3B_Q4KM,
} from './model.js';
export type { ModelSpec, DownloadOptions } from './model.js';

import { modelExists, modelPath, QWEN_2_5_3B_Q4KM } from './model.js';

export interface HealthReport {
  ok: boolean;
  model_id: string;
  model_path: string;
  installed: boolean;
}

export async function healthCheck(): Promise<HealthReport> {
  const installed = await modelExists();
  return {
    ok: installed,
    model_id: QWEN_2_5_3B_Q4KM.id,
    model_path: modelPath(),
    installed,
  };
}

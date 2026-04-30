import { describe, expect, it } from 'vitest';
import { ModelMissingError, QWEN_2_5_3B_Q4KM, modelPath } from '../src/model.js';

describe('model spec invariants', () => {
  it('pins a sha256 of expected length', () => {
    expect(QWEN_2_5_3B_Q4KM.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('targets Qwen 2.5 3B Q4_K_M only', () => {
    expect(QWEN_2_5_3B_Q4KM.id).toBe('qwen2.5-3b-instruct-q4_k_m');
    expect(QWEN_2_5_3B_Q4KM.url).toContain('Qwen2.5-3B-Instruct');
    expect(QWEN_2_5_3B_Q4KM.url).toContain('Q4_K_M');
  });

  it('places weights under the user home dir, not in repo', () => {
    expect(modelPath()).toContain('.quaestor');
    expect(modelPath()).not.toContain('node_modules');
  });

  it('ModelMissingError carries an install hint', () => {
    const err = new ModelMissingError();
    expect(err.code).toBe('MODEL_MISSING');
    expect(err.install_hint).toContain('install');
  });
});

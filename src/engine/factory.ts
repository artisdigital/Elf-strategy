import type { ElfConfig } from './config.js';
import { ElfEngine, type EngineOptions } from './engine.js';
import { ElfV11Engine } from './pineV11.js';

/** Either engine model — both expose the same API and snapshot shape. */
export type AnyElfEngine = ElfEngine | ElfV11Engine;

/** Builds the engine selected by `config.engineModel` ('v1.1' Pine parity by default). */
export function createEngine(config: ElfConfig, opts: EngineOptions): AnyElfEngine {
  return config.engineModel === 'extended' ? new ElfEngine(config, opts) : new ElfV11Engine(config, opts);
}

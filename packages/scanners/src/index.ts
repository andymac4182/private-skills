export * from './types.js';
export * from './util.js';
export * from './executor.js';
export * from './adapter-base.js';
export * from './policy.js';
export * from './adapters/cisco.js';
export * from './adapters/nvidia.js';
export * from './adapters/skillsguard.js';

import { createCiscoAdapter } from './adapters/cisco.js';
import { createNvidiaAdapter } from './adapters/nvidia.js';
import { createSkillsGuardAdapter } from './adapters/skillsguard.js';
import type { ScannerAdapter, ScannerId } from './types.js';

export function createDefaultScannerAdapters(): Map<ScannerId, ScannerAdapter> {
  const adapters = [createCiscoAdapter(), createNvidiaAdapter(), createSkillsGuardAdapter()];
  return new Map(adapters.map((adapter) => [adapter.id, adapter]));
}


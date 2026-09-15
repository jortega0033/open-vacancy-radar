export {
  MODEL_SELECT_CAPABILITY_ID,
  buildModelSelectConstraints,
  modelSelectValueSchema,
  resolveModelSelection,
} from './model-select.js';
export type { ModelSelectValue, ModelSelectionResult } from './model-select.js';
// Issue #284. Re-exported through the same barrel as the model-select resolver deliberately: the
// stage router is a policy layer over that resolver's own contracts, and a consumer that has one
// almost always needs the other (a routed pairing's model id is exactly what `resolveModelSelection`
// then validates against a live catalog).
export * from './stage-routing/index.js';

// Backward-compatible entrypoint for third-party plugins created before the
// runtime manager became the canonical owner of the Telegram client.
export {
  getGlobalClient,
  getCurrentRuntime,
  getCurrentGeneration,
  getCurrentGenerationContext,
  tryGetCurrentGenerationContext,
  isRuntimeTransitioning,
} from "./runtimeManager";
export type { GenerationContext } from "./generationContext";

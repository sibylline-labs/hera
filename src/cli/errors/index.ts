export {
  REDACTION_CLASSES,
  type RedactionClass,
  type ScrubFreeTextResult,
  scrubFreeText,
} from "./scrubber.js";
export {
  ErisError,
  ErisErrorClass,
  type ErisErrorFields,
  type ErisExitCode,
  ErisExitCodeSchema,
  toErrorSlug,
} from "./eris-error.js";
export {
  DEFAULT_ERIS_DOCS_BASE,
  DEFAULT_ERROR_DOCS_PATH,
  type FailureRenderOptions,
  failureLines,
  renderFailureBlock,
  resolveErisHome,
} from "./failure-block.js";

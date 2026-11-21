import { homedir } from "node:os";
import { join } from "node:path";
import type { ErisError } from "./eris-error.js";
import { scrubFreeText } from "./scrubber.js";

export const DEFAULT_ERIS_DOCS_BASE =
  "https://github.com/sibylline-labs/eris/blob/main";

/** The error catalog file a failure with no `docs` of its own links to, as eris publishes it. */
export const DEFAULT_ERROR_DOCS_PATH = "docs/ERRORS.md";

export interface FailureRenderOptions {
  readonly erisHome?: string | undefined;
  readonly docsBase?: string | undefined;
  /** Repo-relative catalog file for a failure with no `docs`; the slug is the anchor. */
  readonly docsPath?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * Resolves the active `ERIS_HOME` directory (`opts.erisHome` -> `env.ERIS_HOME` -> `~/.eris`).
 */
export function resolveErisHome(opts?: FailureRenderOptions): string {
  if (opts?.erisHome && opts.erisHome.length > 0) {
    return opts.erisHome;
  }
  const envHome = opts?.env?.ERIS_HOME ?? process.env.ERIS_HOME;
  if (envHome && envHome.length > 0) {
    return envHome;
  }
  const home = opts?.env?.HOME ?? process.env.HOME ?? homedir();
  return join(home, ".eris");
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function splitFixLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
}

/**
 * Formats an `ErisError` into the failure contract lines:
 *
 * ```
 * ERROR <what>
 * slug: <slug>
 * fix: <first line>
 * fix: <next line>
 * docs: <local>
 * docs: <github>
 * ```
 *
 * Every non-blank line of `fix` gets its own `fix: ` row; an absent or blank `fix` gets none.
 * All free-text fields (`what`, `fix`, `docs`) are scrubbed via `scrubFreeText`.
 */
export function failureLines(
  error: Pick<ErisError, "slug" | "what" | "fix" | "docs">,
  opts?: FailureRenderOptions,
): string[] {
  const safeWhat = scrubFreeText(error.what).text.replace(/\r?\n/g, " ").trim();
  const safeSlug = scrubFreeText(error.slug).text.trim();
  const rawFix = nonBlank(error.fix);
  const safeFixLines =
    rawFix === undefined ? [] : splitFixLines(scrubFreeText(rawFix).text);

  const docPath =
    error.docs !== undefined && error.docs.trim().length > 0
      ? scrubFreeText(error.docs).text.trim()
      : `${(nonBlank(opts?.docsPath) ?? DEFAULT_ERROR_DOCS_PATH).replace(/^\/+/, "")}#${safeSlug}`;

  const home = resolveErisHome(opts);
  const docsBase = (nonBlank(opts?.docsBase) ?? DEFAULT_ERIS_DOCS_BASE).replace(
    /\/+$/,
    "",
  );

  const lines: string[] = [
    `ERROR ${safeWhat}`,
    `slug: ${safeSlug}`,
    ...safeFixLines.map((line) => `fix: ${line}`),
  ];
  lines.push(`docs: ${home}/${docPath}`);
  lines.push(`docs: ${docsBase}/${docPath}`);
  return lines;
}

/**
 * Renders an `ErisError` into the canonical trailing-newline failure block
 * with all free-text fields scrubbed.
 */
export function renderFailureBlock(
  error: Pick<ErisError, "slug" | "what" | "fix" | "docs">,
  opts?: FailureRenderOptions,
): string {
  return `${failureLines(error, opts).join("\n")}\n`;
}

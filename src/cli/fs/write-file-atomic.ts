import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** A named step of `writeFileAtomic`; `WriteFileAtomicOptions.faults` can fail any of them. */
export type AtomicWriteStep = "mkdir" | "open" | "write" | "chmod" | "rename";

export interface WriteFileAtomicOptions {
  /**
   * The final file mode. `"preserve"` (the default) keeps the existing target's mode, or leaves a
   * new file at the umask default (`0666 & ~umask`). A number sets exactly that mode (e.g. `0o600`).
   */
  readonly mode?: number | "preserve" | undefined;
  /** Create the parent directory (`mkdir -p`) first, optionally with a mode for new directories. */
  readonly mkdir?: boolean | { readonly mode: number } | undefined;
  /** Encoding for string data. Default `utf8`. */
  readonly encoding?: BufferEncoding | undefined;
  /** Fault injection (tests only): a hook that throws fails that step. */
  readonly faults?: ((step: AtomicWriteStep) => void) | undefined;
}

const OPEN_ATTEMPTS = 8;

function existingMode(file: string): number | undefined {
  const st = statSync(file, { throwIfNoEntry: false });
  return st?.isFile() ? st.mode & 0o7777 : undefined;
}

/** Opens a fresh sibling temp with `wx`, retrying on a name collision. */
function openTemp(file: string, createMode: number): { readonly tmp: string; readonly fd: number } {
  const dir = dirname(file);
  for (let attempt = 1; ; attempt++) {
    const tmp = join(dir, `.${basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      return { tmp, fd: openSync(tmp, "wx", createMode) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= OPEN_ATTEMPTS) throw err;
    }
  }
}

/**
 * Replaces `file` with `data` atomically: a crypto-random sibling temp
 * (`.<name>.<12 hex>.tmp`) opened `wx`, written, fsynced, given its final mode, then renamed
 * over the target. Readers see the old bytes or the new bytes, never a partial file.
 *
 * On any thrown step the temp is removed and the target is untouched; the original error is
 * rethrown. The function is synchronous, so no signal handler runs between its steps; only
 * SIGKILL can leave a temp, which keeps its dot-prefixed sibling name.
 */
export function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  opts: WriteFileAtomicOptions = {},
): void {
  const fault = opts.faults ?? (() => {});
  if (opts.mkdir) {
    fault("mkdir");
    const mode = typeof opts.mkdir === "object" ? opts.mkdir.mode : undefined;
    mkdirSync(dirname(file), mode === undefined ? { recursive: true } : { recursive: true, mode });
  }
  const finalMode = opts.mode === undefined || opts.mode === "preserve" ? existingMode(file) : opts.mode;
  const bytes = typeof data === "string" ? Buffer.from(data, opts.encoding ?? "utf8") : data;

  fault("open");
  // A known final mode starts the temp private; otherwise `0666` lets the umask decide.
  const { tmp, fd } = openTemp(file, finalMode === undefined ? 0o666 : 0o600);
  let open = true;
  try {
    fault("write");
    let off = 0;
    while (off < bytes.byteLength) off += writeSync(fd, bytes, off);
    fsyncSync(fd);
    closeSync(fd);
    open = false;
    if (finalMode !== undefined) {
      fault("chmod");
      chmodSync(tmp, finalMode);
    }
    fault("rename");
    renameSync(tmp, file);
  } catch (err) {
    if (open) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    rmSync(tmp, { force: true });
    throw err;
  }
}

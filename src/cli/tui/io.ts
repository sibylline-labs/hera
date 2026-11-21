import type { TuiIo } from "./types.js";

/**
 * Turn a chunk stream (Bun/Node `process.stdin`, a test array) into a line reader. Chunks need not
 * be line-aligned; `\r\n` is accepted; a final line without a newline is still returned, then `null`.
 */
export function lineReader(chunks: AsyncIterable<Uint8Array | string>): () => Promise<string | null> {
  const iterator = chunks[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let buffered = "";
  let ended = false;

  return async () => {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return line.endsWith("\r") ? line.slice(0, -1) : line;
      }
      if (ended) {
        if (buffered === "") return null;
        const last = buffered;
        buffered = "";
        return last;
      }
      const next = await iterator.next();
      if (next.done) {
        ended = true;
        buffered += decoder.decode();
      } else {
        buffered += typeof next.value === "string" ? next.value : decoder.decode(next.value, { stream: true });
      }
    }
  };
}

/** Anything with a `write(text)`, such as Bun/Node `process.stdout`. */
export interface TuiOutput {
  readonly write: (text: string) => unknown;
}

/** Adapt a host's input stream and output sink to `TuiIo`, e.g. `terminalIo({ input: process.stdin, output: process.stdout })`. */
export function terminalIo(host: {
  readonly input: AsyncIterable<Uint8Array | string>;
  readonly output: TuiOutput;
}): TuiIo {
  return {
    write: (text) => {
      host.output.write(text);
    },
    readLine: lineReader(host.input),
  };
}

export interface ScriptedIo {
  readonly io: TuiIo;
  /** Everything written, with each consumed answer echoed after its question. */
  readonly transcript: () => string;
  /** Scripted lines not yet read. */
  readonly remaining: () => number;
}

/** Drive a flow headlessly: each `readLine` returns the next scripted line, then `null`. */
export function scriptedIo(lines: ReadonlyArray<string>): ScriptedIo {
  let out = "";
  let next = 0;
  return {
    io: {
      write: (text) => {
        out += text;
      },
      readLine: async () => {
        const line = lines[next];
        if (line === undefined) return null;
        next += 1;
        out += `${line}\n`;
        return line;
      },
    },
    transcript: () => out,
    remaining: () => lines.length - next,
  };
}

/**
 * Builds a deterministic hex-encoded key string of `byteLength` bytes (default 32).
 */
export function makeTestHexKey(byteLength = 32, fillByte = 0xab): string {
  const clamped = fillByte & 0xff;
  const hexByte = clamped.toString(16).padStart(2, "0");
  return hexByte.repeat(byteLength);
}

/**
 * Builds a deterministic versioned keyring string (`v1:<hex>,v2:<hex>`) for tests.
 */
export function makeTestKeyring(
  versions: ReadonlyArray<number> = [1, 2],
  byteLength = 32,
): string {
  return versions
    .map((version, idx) => {
      const fillByte = (0x10 + ((version + idx) & 0x7f)) & 0xff;
      return `v${version}:${makeTestHexKey(byteLength, fillByte)}`;
    })
    .join(",");
}

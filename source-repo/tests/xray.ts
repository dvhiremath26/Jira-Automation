/** Keep selection tags and Xray's import identity in sync at declaration time.
 * Static annotations survive skipped tests and failures before the test body runs.
 */
export function xray(key: string) {
  if (!/^[A-Z][A-Z0-9_]*-[1-9]\d*$/.test(key)) {
    throw new Error(`Invalid Xray Test key: ${key}`);
  }
  return {
    tag: [`@${key}`],
    annotation: [{ type: 'test_key', description: key }],
  };
}

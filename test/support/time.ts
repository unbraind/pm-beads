/** Scale harness deadlines only; validate before a caller can spawn a child. */
export function testTime(milliseconds: number): number {
  const scale = Number(process.env.PM_TEST_TIME_SCALE ?? "1");
  const result = Math.ceil(milliseconds * scale);
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isSafeInteger(result) || result <= 0) {
    throw new Error("PM_TEST_TIME_SCALE must produce a finite positive timeout");
  }
  return result;
}

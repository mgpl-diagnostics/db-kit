/**
 * Indian financial year (1 April – 31 March), e.g. 2026-27, in Asia/Kolkata time.
 */
export function financialYear(date: Date = new Date()): string {
  const ist = new Date(date.getTime() + 5.5 * 3600 * 1000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Counter keys. One sequence per organisation (+ branch / year where numbers restart). */
export const counterKeys = {
  uhid: (orgId: string) => `uhid:${orgId}`,
  invoice: (orgId: string, branchCode: string, fy: string) => `invoice:${orgId}:${branchCode}:${fy}`,
  booking: (orgId: string, branchCode: string, day: string) => `booking:${orgId}:${branchCode}:${day}`,
  sample: (orgId: string) => `sample:${orgId}`,
};

/** "MGPL-000123" */
export const formatUhid = (orgCode: string, seq: number) => `${orgCode}-${pad(seq, 6)}`;

/** "MGPL/RPR01/2026-27/000045" — restarts every financial year (GST invoice series). */
export const formatInvoiceNo = (orgCode: string, branchCode: string, fy: string, seq: number) =>
  `${orgCode}/${branchCode}/${fy}/${pad(seq, 6)}`;

/** "RPR01-261013-0007" — restarts daily per branch. */
export const formatBookingNo = (branchCode: string, day: string, seq: number) => `${branchCode}-${day}-${pad(seq, 4)}`;

/** "S26000123" — numeric barcode-friendly sample id. */
export const formatSampleBarcode = (year2: string, seq: number) => `S${year2}${pad(seq, 6)}`;

/** "261013" for 13 Oct 2026 (IST). */
export function dayKey(date: Date = new Date()): string {
  const ist = new Date(date.getTime() + 5.5 * 3600 * 1000);
  return `${String(ist.getUTCFullYear()).slice(2)}${pad(ist.getUTCMonth() + 1, 2)}${pad(ist.getUTCDate(), 2)}`;
}

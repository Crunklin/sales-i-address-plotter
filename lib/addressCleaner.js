/**
 * Cleans address strings by removing names, PO Box lines, Attn/department, and other non-street info.
 * Tailored to CSV exports with Address1–4, Town, Postcode (e.g. customer/account sheets).
 */

const PATTERNS = {
  // P.O. Box, PO Box, P O Box, Post Office Box (with number); strip only the PO Box part
  poBox: /\bP\.?\s*O\.?\s*Box\s*\d+[^\n,]*|\bPost\s+Office\s+Box\s*\d+[^\n,]*/gi,
  // "c/o", "care of", "C/O Name" - remove the whole phrase
  careOf: /\bc\/o\s+[^\n,]+/gi,
  // "Attn:", "ATTN.", "Att:", "Attention: Name/Dept" - remove name/dept only (letters/spaces), keep following numbers (street)
  attention: /\b(?:Attn\.?|ATTN\.?|Attention|Att)\s*:?\s*[A-Za-z\s\/\.\-]+/gi,
  // Trailing phone-like: 522-6004, (517) 555-1234, 517.555.1234
  phone: /\s*(?:\(\d{3}\)\s*)?\d{3}[-.\s]?\d{4}(?=\s|$|,)/g,
  // Leading "Attn/Accounts Payable" style at start (e.g. "ATTN. ACCOUNTS PAYABLE 18620  16 MILE RD" -> keep "18620  16 MILE RD")
  leadingAttn: /^(?:Attn\.?|ATTN\.?|Attention|Att)\s*:?\s*[A-Za-z\s\/\.]+/im,
  // V# 784355 style reference numbers in address
  refNumber: /\s*V#\s*\d+\s*(?:[A-Za-z\s]+)?/gi,
  // Leading name-only line (2–4 words, letters only) at very start
  leadingNameOnly: /^[\s]*[A-Za-z\.\'\-]+\s+[A-Za-z\.\'\-]+(?:\s+[A-Za-z\.\'\-]+)?(?:\s+[A-Za-z\.\'\-]+)?(?=\s*[\n,])/m,
};

/**
 * Clean a single address string.
 * @param {string} raw - Raw address (may contain names, PO Box, Attn, phone, etc.)
 * @returns {string} - Cleaned address suitable for geocoding
 */
export function cleanAddress(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw
    .replace(PATTERNS.poBox, '')
    .replace(PATTERNS.careOf, '')
    .replace(PATTERNS.attention, '')
    .replace(PATTERNS.phone, ' ')
    .replace(PATTERNS.refNumber, '')
    .replace(PATTERNS.leadingAttn, '')
    .replace(PATTERNS.leadingNameOnly, '')
    // Normalize whitespace and commas
    .replace(/\s+/g, ' ')
    .replace(/,(\s*),/g, ',')
    .replace(/^\s*,\s*|\s*,\s*$/g, '')
    .trim();
  return s;
}

/** Default address part keys (same order as your CSV exports). */
const DEFAULT_ADDRESS_KEYS = ['Address1', 'Address2', 'Address3', 'Address4', 'Town', 'County', 'Postcode'];

/**
 * Build a single address string from row using multiple columns (e.g. Address1, Address2, Town, Postcode).
 * @param {Object} row - One CSV row
 * @param {string[]} keys - Column names to join (order preserved). Default: Address1–4, Town, County, Postcode
 * @param {string} [state] - Optional state/country to append (e.g. "MI" or "USA")
 * @returns {string} - Combined address line
 */
export function buildAddressFromRow(row, keys = DEFAULT_ADDRESS_KEYS, state = '') {
  const parts = keys.map((k) => (row[k] ?? '').trim()).filter(Boolean);
  // Don't append state if it's already the last part (e.g. County is "MI" → avoid "..., 48726, MI, MI")
  if (state && parts[parts.length - 1] !== state) parts.push(state);
  return parts.join(', ');
}

/**
 * Clean address column in an array of row objects.
 * @param {Object[]} rows - Array of objects (CSV rows)
 * @param {string} addressColumn - Key of the address column
 * @returns {Object[]} - Rows with cleaned address in same column + optional _cleanedAddress
 */
export function cleanAddressColumn(rows, addressColumn) {
  return rows.map((row) => {
    const raw = row[addressColumn] ?? '';
    const cleaned = cleanAddress(raw);
    return { ...row, [addressColumn]: cleaned, _cleanedAddress: cleaned };
  });
}

/**
 * Build full address from row, then clean it. Use when address is split across Address1–4, Town, Postcode.
 * @param {Object} row - One CSV row
 * @param {string[]} [keys] - Column names; default Address1–4, Town, County, Postcode
 * @param {string} [state] - State/country (e.g. "MI")
 * @returns {string} - Cleaned combined address
 */
export function buildAndCleanAddress(row, keys = DEFAULT_ADDRESS_KEYS, state = 'MI') {
  const raw = buildAddressFromRow(row, keys, state);
  return cleanAddress(raw);
}

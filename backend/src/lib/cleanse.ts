// Data cleansing / standardization.
// Applied automatically before saving master data, and used by the
// DQM "Standardization" page to fix records that were saved before the rules existed.

/** "  juan   DELA cruz " → "Juan Dela Cruz" */
export function cleanName(value?: string | null) {
  if (value == null) return value;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.toLowerCase().replace(/(^|[\s\-.(])([a-zñ])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** "+63 917 123 4567", "639171234567", "9171234567", "0917-123-4567" → "09171234567" */
export function cleanPhone(value?: string | null) {
  if (value == null) return value;
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 12 && digits.startsWith('63')) return '0' + digits.slice(2);
  if (digits.length === 10 && digits.startsWith('9')) return '0' + digits;
  if (digits.length === 11) return digits;
  return value.trim(); // leave invalid values as-is so DQ-03 can flag them
}

/** "123456789000" or "123 456 789 000" → "123-456-789-000" */
export function cleanTin(value?: string | null) {
  if (value == null) return value;
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 12) return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{3})/, '$1-$2-$3-$4');
  if (digits.length === 9) return digits.replace(/(\d{3})(\d{3})(\d{3})/, '$1-$2-$3-000');
  return value.trim();
}

export function cleanEmail(value?: string | null) {
  if (value == null) return value;
  return value.trim().toLowerCase() || null;
}

export function cleanText(value?: string | null) {
  if (value == null) return value;
  return value.replace(/\s+/g, ' ').trim() || null;
}

const apply = (out: any, field: string, fn: (v: any) => any) => {
  if (field in out) out[field] = fn(out[field]);
};

export function cleanFisher<T extends Record<string, any>>(data: T): T {
  const out: any = { ...data };
  apply(out, 'name', cleanName);
  apply(out, 'phone', cleanPhone);
  apply(out, 'tin', cleanTin);
  apply(out, 'address', cleanText);
  apply(out, 'payoutAccount', cleanText);
  return out;
}

export function cleanBuyer<T extends Record<string, any>>(data: T): T {
  const out: any = { ...data };
  apply(out, 'businessName', cleanText);
  apply(out, 'contactPerson', cleanName);
  apply(out, 'phone', cleanPhone);
  apply(out, 'email', cleanEmail);
  apply(out, 'tin', cleanTin);
  apply(out, 'address', cleanText);
  return out;
}

export const PATTERNS = {
  phone: /^09\d{9}$/,
  tin: /^\d{3}-\d{3}-\d{3}-\d{3}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
};

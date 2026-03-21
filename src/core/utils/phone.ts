const NANP_LOCAL_DIGIT_COUNT = 10;
const NANP_COUNTRY_CODE_DIGIT_COUNT = 11;

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const digits = digitsOnly(trimmed);
  if (digits.length === 0) {
    return "";
  }

  if (digits.length === NANP_COUNTRY_CODE_DIGIT_COUNT && digits.startsWith("1")) {
    return digits.slice(1);
  }

  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

export function toE164(phone: string): string | null {
  const normalized = normalizePhone(phone);
  if (normalized.length === 0) {
    return null;
  }

  if (normalized.startsWith("+")) {
    return normalized;
  }

  if (normalized.length === NANP_LOCAL_DIGIT_COUNT) {
    return `+1${normalized}`;
  }

  if (/^\d+$/.test(normalized)) {
    return `+${normalized}`;
  }

  return null;
}

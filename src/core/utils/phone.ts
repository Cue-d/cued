export function normalizePhone(phone: string): string {
  const hasPlus = phone.startsWith("+");
  const digits = phone.replace(/\D/g, "");
  if (hasPlus) {
    return `+${digits}`;
  }
  return digits;
}

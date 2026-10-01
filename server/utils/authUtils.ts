export function normalizePhoneForSearch(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  
  if (digits.length === 10) {
    return '+1' + digits;
  }
  
  if (digits.length === 11 && digits.startsWith('1')) {
    return '+1' + digits.slice(1);
  }
  
  if (!raw.startsWith('+')) {
    return '+' + digits;
  }
  
  return '+' + digits;
}

export function getPhoneVariations(raw: string): string[] {
  const digits = raw.replace(/\D/g, '');
  const variations: string[] = [];
  
  const normalized = normalizePhoneForSearch(raw);
  variations.push(normalized);
  
  if (digits.length === 10) {
    variations.push(digits);
    variations.push('1' + digits);
    variations.push('+1' + digits);
  }
  
  if (digits.length === 11 && digits.startsWith('1')) {
    variations.push(digits);
    variations.push(digits.slice(1));
    variations.push('+' + digits);
    variations.push('+1' + digits.slice(1));
  }
  
  return Array.from(new Set(variations));
}

export function normalizeEmail(raw: string): string {
  return raw.toLowerCase().trim();
}

export function extractDigits(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function phonesMatch(searchedPhone: string, clientPhone: string): boolean {
  if (!searchedPhone || !clientPhone) return false;
  
  const searchDigits = extractDigits(searchedPhone);
  const clientDigits = extractDigits(clientPhone);
  
  if (searchDigits === clientDigits) return true;
  
  const searchLast10 = searchDigits.slice(-10);
  const clientLast10 = clientDigits.slice(-10);
  
  if (searchLast10.length >= 10 && clientLast10.length >= 10) {
    return searchLast10 === clientLast10;
  }
  
  return false;
}

export function findMatchingClient(clients: any[], searchedPhone: string): any | null {
  for (const client of clients) {
    const clientMobile = client.mobile || '';
    const clientLandline = client.landline || '';
    if (phonesMatch(searchedPhone, clientMobile) || phonesMatch(searchedPhone, clientLandline)) {
      return client;
    }
  }
  return null;
}

export interface ClientMatchResult {
  /** Single unambiguous match (exact-digits preferred), or null */
  client: any | null;
  /** True when multiple distinct clients share the searched number */
  ambiguous: boolean;
}

function isExactDigitsMatch(searchedPhone: string, client: any): boolean {
  const searchDigits = extractDigits(searchedPhone);
  const mobileDigits = extractDigits(client.mobile || '');
  const landlineDigits = extractDigits(client.landline || '');
  return searchDigits.length > 0 && (searchDigits === mobileDigits || searchDigits === landlineDigits);
}

/**
 * Safely match clients by phone: exact-digit matches are preferred over
 * last-10-digit matches. If multiple distinct clients match at the same
 * precedence level, the result is flagged ambiguous so login can be refused
 * instead of silently picking the wrong account.
 */
export function findMatchingClients(clients: any[], searchedPhone: string): ClientMatchResult {
  const matches: any[] = [];
  for (const client of clients) {
    const clientMobile = client.mobile || '';
    const clientLandline = client.landline || '';
    if (phonesMatch(searchedPhone, clientMobile) || phonesMatch(searchedPhone, clientLandline)) {
      matches.push(client);
    }
  }

  if (matches.length === 0) return { client: null, ambiguous: false };

  // De-duplicate by clientId (Phorest can return the same client for multiple search fields)
  const uniqueById = new Map<string, any>();
  for (const m of matches) {
    if (m.clientId && !uniqueById.has(m.clientId)) uniqueById.set(m.clientId, m);
  }
  const unique = uniqueById.size > 0 ? Array.from(uniqueById.values()) : matches;

  if (unique.length === 1) return { client: unique[0], ambiguous: false };

  // Multiple candidates: prefer exact full-digit matches
  const exact = unique.filter(c => isExactDigitsMatch(searchedPhone, c));
  if (exact.length === 1) return { client: exact[0], ambiguous: false };

  return { client: null, ambiguous: true };
}

/**
 * Safely match clients by email: only exact normalized-email matches count.
 * If multiple distinct clients share the same email, the result is flagged
 * ambiguous so login can be refused instead of silently picking the wrong account.
 */
export function findMatchingClientsByEmail(clients: any[], searchedEmail: string): ClientMatchResult {
  const target = normalizeEmail(searchedEmail);
  if (!target) return { client: null, ambiguous: false };

  const matches = clients.filter(c => normalizeEmail(c.email || '') === target);
  if (matches.length === 0) return { client: null, ambiguous: false };

  const uniqueById = new Map<string, any>();
  for (const m of matches) {
    if (m.clientId && !uniqueById.has(m.clientId)) uniqueById.set(m.clientId, m);
  }
  const unique = uniqueById.size > 0 ? Array.from(uniqueById.values()) : matches;

  if (unique.length === 1) return { client: unique[0], ambiguous: false };
  return { client: null, ambiguous: true };
}

export function buildIdentifierKey(phone?: string, email?: string): string {
  const normalizedPhone = phone ? normalizePhoneForSearch(phone) : '';
  const normalizedEmail = email ? normalizeEmail(email) : '';
  return `${normalizedPhone}|${normalizedEmail}`;
}

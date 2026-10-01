import * as phorestApi from '../phorestApi';

interface CachedService {
  key: string;
  name: string;
  category: string;
  description: string;
  duration: string;
  durationMinutes?: number;
  price: string;
  phorestServiceId: string;
  phorestBasePrice?: number;
  staffPrices: { staffId: string; price: number }[];
  imageUrl?: string;
  bookingUrl: string;
  categoryOrder: number;
}

interface ServiceCacheData {
  services: CachedService[];
  categories: string[];
  lastUpdated: number;
  isWarming: boolean;
}

const cache: ServiceCacheData = {
  services: [],
  categories: [],
  lastUpdated: 0,
  isWarming: false
};

const BACKGROUND_REFRESH_INTERVAL = 5 * 60 * 1000;

// Log the (expected) missing servicecategory endpoint only once to avoid startup noise
let loggedCategoryFetchFailure = false;

const CATEGORY_IMAGE_MAP: Record<string, string[]> = {
  'hair': [
    'https://images.unsplash.com/photo-1562322140-8baeececf3df?w=400&h=400&fit=crop',
    'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=400&h=400&fit=crop',
    'https://images.unsplash.com/photo-1519699047748-de8e457a634e?w=400&h=400&fit=crop',
    'https://images.unsplash.com/photo-1487412947147-5cebf100ffc2?w=400&h=400&fit=crop',
  ],
  'spa': [
    'https://images.unsplash.com/photo-1560066984-138dadb4c035?w=400&h=400&fit=crop',
    'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=400&h=400&fit=crop',
    'https://images.unsplash.com/photo-1487412912498-0447578fcca8?w=400&h=400&fit=crop',
  ],
  'medical': [
    'https://images.unsplash.com/photo-1526045612212-70caf35c14df?w=400&h=400&fit=crop',
    'https://images.unsplash.com/photo-1492106087820-71f1a00d2b11?w=400&h=400&fit=crop',
  ],
  'bridal': [
    'https://images.unsplash.com/photo-1595476108010-b4d1f102b1b1?w=400&h=400&fit=crop',
    'https://images.unsplash.com/photo-1522336406647-403bf2a6ce1e?w=400&h=400&fit=crop',
  ],
  'default': [
    'https://images.unsplash.com/photo-1562322140-8baeececf3df?w=400&h=400&fit=crop',
    'https://images.unsplash.com/photo-1560066984-138dadb4c035?w=400&h=400&fit=crop',
  ]
};

const PHOREST_CATEGORY_MAP: Record<string, { displayName: string; order: number }> = {
  'HAIR CUTS & STYLING': { displayName: 'Hair - Cuts & Styling', order: 1 },
  'COLOUR SERVICES': { displayName: 'Hair - Color', order: 2 },
  'EXTENSIONS': { displayName: 'Hair - Extensions', order: 3 },
  'TREATMENTS': { displayName: 'Hair - Treatments', order: 4 },
  'STRAIGHTENING': { displayName: 'Hair - Treatments', order: 4 },
  'FACIALS': { displayName: 'Spa - Facials', order: 6 },
  'BROWS + LASHES': { displayName: 'Spa - Lashes & Brows', order: 7 },
  'WAXING + THREADING': { displayName: 'Spa - Hair Removal', order: 8 },
  'SUGARING': { displayName: 'Spa - Hair Removal', order: 8 },
  'NAILS': { displayName: 'Spa - Nails', order: 9 },
  'RMT': { displayName: 'Spa - Massage', order: 10 },
  'SHIATSU MASSAGE': { displayName: 'Spa - Massage', order: 10 },
  'PERMANENT MAKEUP SERVICES': { displayName: 'Medical Esthetics', order: 11 },
  'LASER': { displayName: 'Venus Treatments', order: 12 },
  'IPL -VENUS VERSA': { displayName: 'Venus Treatments', order: 12 },
  'IPL Half Legs': { displayName: 'Venus Treatments', order: 12 },
  'SKIN TIGHTENING-VENUS VERSA': { displayName: 'Venus Treatments', order: 12 },
  'MAKE-UP': { displayName: 'Makeup', order: 13 },
  'COMPLIMENTARY CONSULTATION': { displayName: 'Other Services', order: 50 },
};

const CATEGORY_KEYWORDS: { keywords: string[]; displayName: string; order: number }[] = [
  { keywords: ['cut', 'blow dry', 'blowdry'], displayName: 'Hair - Cuts & Styling', order: 1 },
  { keywords: ['color', 'colour', 'balayage', 'highlight', 'blonde', 'gloss', 'toner', 'root touch'], displayName: 'Hair - Color', order: 2 },
  { keywords: ['extension'], displayName: 'Hair - Extensions', order: 3 },
  { keywords: ['keratin', 'treatment', 'conditioning', 'repair', 'reconstruct'], displayName: 'Hair - Treatments', order: 4 },
  { keywords: ['updo', 'blowout', 'waves'], displayName: 'Hair - Styling', order: 5 },
  { keywords: ['facial', 'peel', 'dermaplaning', 'skin care', 'microderm'], displayName: 'Spa - Facials', order: 6 },
  { keywords: ['lash', 'brow', 'lamination', 'refill'], displayName: 'Spa - Lashes & Brows', order: 7 },
  { keywords: ['wax', 'thread', 'hair removal', 'sugaring', 'bikini', 'brazilian'], displayName: 'Spa - Hair Removal', order: 8 },
  { keywords: ['nail', 'manicure', 'pedicure', 'shellac', 'dazzle'], displayName: 'Spa - Nails', order: 9 },
  { keywords: ['massage', 'reflexology'], displayName: 'Spa - Massage', order: 10 },
  { keywords: ['botox', 'filler', 'injection', 'microblading', 'permanent makeup', 'tattoo', 'lip blushing', 'eyeliner'], displayName: 'Medical Esthetics', order: 11 },
  { keywords: ['venus', 'laser', 'ipl', 'photofacial', 'resurfacing', 'tightening', 'slimming', 'cellulite', 'tribella', '-vv'], displayName: 'Venus Treatments', order: 12 },
  { keywords: ['makeup', 'make-up', 'make up'], displayName: 'Makeup', order: 13 },
  { keywords: ['bridal', 'wedding', 'bride'], displayName: 'Bridal Services', order: 99 },
];

function classifyService(serviceName: string, phorestCategoryName?: string): { displayName: string; order: number } {
  if (phorestCategoryName) {
    const upperCat = phorestCategoryName.toUpperCase().trim();
    for (const [key, value] of Object.entries(PHOREST_CATEGORY_MAP)) {
      if (upperCat === key.toUpperCase()) {
        return value;
      }
    }
  }

  const lowerName = serviceName.toLowerCase();
  const lowerCategory = (phorestCategoryName || '').toLowerCase();

  for (const entry of CATEGORY_KEYWORDS) {
    for (const kw of entry.keywords) {
      if (lowerName.includes(kw) || lowerCategory.includes(kw)) {
        return { displayName: entry.displayName, order: entry.order };
      }
    }
  }

  return { displayName: phorestCategoryName || 'Other Services', order: 50 };
}

function getImageForCategory(displayName: string, index: number): string {
  const lowerCat = displayName.toLowerCase();
  let images: string[];
  if (lowerCat.includes('hair')) {
    images = CATEGORY_IMAGE_MAP['hair'];
  } else if (lowerCat.includes('spa')) {
    images = CATEGORY_IMAGE_MAP['spa'];
  } else if (lowerCat.includes('medical') || lowerCat.includes('venus')) {
    images = CATEGORY_IMAGE_MAP['medical'];
  } else if (lowerCat.includes('bridal') || lowerCat.includes('makeup')) {
    images = CATEGORY_IMAGE_MAP['bridal'];
  } else {
    images = CATEGORY_IMAGE_MAP['default'];
  }
  return images[index % images.length];
}

function formatDuration(minutes?: number): string {
  if (!minutes) return '';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
  return `${hours} hour${hours > 1 ? 's' : ''} ${mins} min`;
}

function isPhorestConfigured(): boolean {
  return !!(process.env.PHOREST_USERNAME && process.env.PHOREST_PASSWORD && process.env.PHOREST_BUSINESS_ID && process.env.PHOREST_BRANCH_ID);
}

export async function warmCache(): Promise<void> {
  if (cache.isWarming) {
    console.log('[ServiceCache] Already warming, skipping...');
    return;
  }

  cache.isWarming = true;
  console.log('[ServiceCache] Starting cache warm-up...');

  try {
    if (!isPhorestConfigured()) {
      console.log('[ServiceCache] Phorest not configured, skipping');
      cache.isWarming = false;
      return;
    }

    const allPhorestServices: phorestApi.PhorestService[] = [];
    let page = 0;
    const pageSize = 200;

    while (true) {
      const response = await phorestApi.listBranchServices({ page, size: pageSize });
      if (!response || !response.content) {
        // Abort the whole refresh — a partial service list must never replace a good cache
        throw new Error(`[ServiceCache] Failed to fetch services page ${page}; keeping existing cache`);
      }
      allPhorestServices.push(...response.content);
      console.log(`[ServiceCache] Fetched page ${page + 1}/${response.totalPages || 1} (${response.content.length} services)`);

      if (page >= (response.totalPages || 1) - 1) break;
      page++;
    }

    console.log(`[ServiceCache] Total Phorest services: ${allPhorestServices.length}`);

    const onlineServices = allPhorestServices.filter(svc => {
      if (svc.internetEnabled === false) return false;
      const lowerName = svc.name.toLowerCase();
      if (lowerName === 'complimentary consultation') return false;
      return true;
    });
    const skippedCount = allPhorestServices.length - onlineServices.length;
    console.log(`[ServiceCache] Filtered to ${onlineServices.length} internet-enabled services (skipped ${skippedCount} offline/internal)`);

    let categoryMap = new Map<string, string>();
    try {
      const catResponse = await phorestApi.listServiceCategories({ page: 0, size: 100 });
      if (catResponse?.content) {
        for (const cat of catResponse.content) {
          categoryMap.set(cat.serviceCategoryId, cat.name);
        }
        console.log(`[ServiceCache] Loaded ${categoryMap.size} service categories from Phorest`);
      }
    } catch (catError) {
      // Optional endpoint — Phorest returns 404 for this business. Log once at debug level.
      if (!loggedCategoryFetchFailure) {
        loggedCategoryFetchFailure = true;
        console.log('[ServiceCache] Service category endpoint unavailable (expected); classifying by categoryName/keywords');
      }
    }

    const cachedServices: CachedService[] = [];
    const categoryCounters = new Map<string, number>();

    for (const svc of onlineServices) {
      const phorestCategoryName = (svc.categoryId ? categoryMap.get(svc.categoryId) : null) || svc.categoryName;
      const classified = classifyService(svc.name, phorestCategoryName);

      const catCount = categoryCounters.get(classified.displayName) || 0;
      categoryCounters.set(classified.displayName, catCount + 1);

      let staffPrices: { staffId: string; price: number }[] = [];
      if (svc.staffCategories?.prices) {
        staffPrices = svc.staffCategories.prices.map((sp: any) => ({
          staffId: sp.id,
          price: sp.price
        }));
      }

      const displayPrice = svc.price != null && svc.price > 0
        ? `from $${Math.round(svc.price)}`
        : 'Call for pricing';

      cachedServices.push({
        key: svc.serviceId,
        name: svc.name,
        category: classified.displayName,
        description: svc.internetDescription || svc.description || `Professional ${svc.name.toLowerCase()} service at Kozeta Salon & Spa.`,
        duration: formatDuration(svc.duration),
        durationMinutes: svc.duration && svc.duration > 0 ? svc.duration : undefined,
        price: displayPrice,
        phorestServiceId: svc.serviceId,
        phorestBasePrice: svc.price,
        staffPrices,
        imageUrl: getImageForCategory(classified.displayName, catCount),
        bookingUrl: 'https://phorest.com/book/salons/kozetasalonandspa',
        categoryOrder: classified.order,
      });
    }

    cachedServices.sort((a, b) => {
      if (a.categoryOrder !== b.categoryOrder) return a.categoryOrder - b.categoryOrder;
      return a.name.localeCompare(b.name);
    });

    const uniqueCategories = Array.from(new Set(cachedServices.map(s => s.category)));
    uniqueCategories.sort((a, b) => {
      const orderA = cachedServices.find(s => s.category === a)?.categoryOrder || 50;
      const orderB = cachedServices.find(s => s.category === b)?.categoryOrder || 50;
      return orderA - orderB;
    });

    cache.services = cachedServices;
    cache.categories = uniqueCategories;
    cache.lastUpdated = Date.now();

    console.log(`[ServiceCache] Cache warmed: ${cachedServices.length} services, ${uniqueCategories.length} categories`);
    console.log(`[ServiceCache] Categories: ${uniqueCategories.join(', ')}`);

  } catch (error) {
    console.error('[ServiceCache] Cache warm-up failed:', error);
    // Cold-start recovery: if we have no data at all (Phorest was down during
    // startup), retry quickly instead of waiting for the 5-minute interval.
    if (cache.services.length === 0) {
      scheduleColdStartRetry();
    }
  } finally {
    cache.isWarming = false;
  }
}

let coldStartRetryTimer: NodeJS.Timeout | null = null;
function scheduleColdStartRetry(): void {
  if (coldStartRetryTimer) return;
  console.log('[ServiceCache] Cache empty after failed warm-up — retrying in 30s');
  coldStartRetryTimer = setTimeout(async () => {
    coldStartRetryTimer = null;
    if (cache.services.length === 0 && !cache.isWarming) {
      await warmCache();
    }
  }, 30_000);
}

export function getServices(): CachedService[] {
  return cache.services;
}

export function getCategories(): string[] {
  return cache.categories;
}

export function getServiceById(serviceId: string): CachedService | undefined {
  return cache.services.find(s => s.phorestServiceId === serviceId);
}

// Total duration in minutes for a set of services, from cached Phorest data.
// Returns undefined when none of the services have a known duration —
// callers should fall back to a default (e.g. 60 min) only in that case.
export function getTotalDurationMinutes(serviceIds: string[]): number | undefined {
  let total = 0;
  let found = false;
  for (const id of serviceIds) {
    const svc = getServiceById(id);
    if (svc?.durationMinutes && svc.durationMinutes > 0) {
      total += svc.durationMinutes;
      found = true;
    }
  }
  return found ? total : undefined;
}

export function getServicesByCategory(category: string): CachedService[] {
  return cache.services.filter(s => s.category === category);
}

export function isCacheReady(): boolean {
  return cache.lastUpdated > 0 && cache.services.length > 0;
}

export function getCacheStatus(): { lastUpdated: number; serviceCount: number; categoryCount: number; isWarming: boolean } {
  return {
    lastUpdated: cache.lastUpdated,
    serviceCount: cache.services.length,
    categoryCount: cache.categories.length,
    isWarming: cache.isWarming
  };
}

let refreshTimer: NodeJS.Timeout | null = null;

export function startBackgroundRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);

  refreshTimer = setInterval(async () => {
    if (!cache.isWarming) {
      console.log('[ServiceCache] Background refresh triggered');
      await warmCache();
    }
  }, BACKGROUND_REFRESH_INTERVAL);

  console.log(`[ServiceCache] Background refresh scheduled every ${BACKGROUND_REFRESH_INTERVAL / 1000 / 60} minutes`);
}

export function stopBackgroundRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export async function forceRefresh(): Promise<void> {
  cache.lastUpdated = 0;
  await warmCache();
}

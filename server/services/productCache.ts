import * as phorestApi from '../phorestApi';
import * as productEnrichment from './productEnrichment';
import { db } from '../db';
import { productVisibility } from '@shared/schema';
import { eq } from 'drizzle-orm';

export interface CachedProduct {
  productId: string;
  name: string;
  description: string;
  price: number;
  brandName: string;
  categoryName: string;
  imageUrl: string;
  inStock: boolean;
  stockLevel?: number;
  sku?: string;
  type?: string;
}

interface ProductCacheData {
  allProducts: CachedProduct[];
  visibleProducts: CachedProduct[];
  brands: string[];
  lastUpdated: number;
  isWarming: boolean;
}

const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const BACKGROUND_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

const APPROVED_ONLINE_BRANDS = [
  'Dermalogica',
  'Framar',
  'K18.Biomimetic.Hairscience',
  'Kerasilk',
  'Kerastase',
  'KOZISILK',
  "L'Oréal Paris",
  'Lakme',
  'Oribe',
  'Pureology',
  'Revive7',
  'Tecni.Art',
];

function isApprovedBrand(brandName: string | undefined): boolean {
  if (!brandName) return false;
  const lower = brandName.toLowerCase().trim();
  return APPROVED_ONLINE_BRANDS.some(approved => 
    approved.toLowerCase() === lower ||
    lower.includes(approved.toLowerCase()) ||
    approved.toLowerCase().includes(lower)
  );
}

let cache: ProductCacheData = {
  allProducts: [],
  visibleProducts: [],
  brands: [],
  lastUpdated: 0,
  isWarming: false
};

let refreshTimer: NodeJS.Timeout | null = null;

function isPhorestConfigured(): boolean {
  return !!(process.env.PHOREST_USERNAME && process.env.PHOREST_PASSWORD);
}

async function getVisibleProductIds(): Promise<Set<string> | null> {
  try {
    const rows = await db.select().from(productVisibility).where(eq(productVisibility.visible, true));
    if (rows.length === 0) return null;
    return new Set(rows.map(r => r.productId));
  } catch (error) {
    console.error('[ProductCache] Error fetching visibility settings:', error);
    return null;
  }
}

export async function warmCache(): Promise<void> {
  if (cache.isWarming) {
    console.log('[ProductCache] Already warming, skipping...');
    return;
  }

  if (!isPhorestConfigured()) {
    console.log('[ProductCache] Phorest not configured, using mock data');
    cache.allProducts = getMockProducts();
    cache.visibleProducts = getMockProducts();
    cache.brands = ["Olaplex", "Pureology", "Kerastase", "Oribe"];
    cache.lastUpdated = Date.now();
    return;
  }

  cache.isWarming = true;
  console.log('[ProductCache] Starting cache warm-up...');
  const startTime = Date.now();

  try {
    let allPhorestProducts: any[] = [];
    let page = 0;
    let totalPages = 1;

    while (page < totalPages) {
      const productsResponse = await phorestApi.listProducts({ page, size: 500 }) as any;
      const pageProducts = productsResponse._embedded?.products ?? productsResponse.content ?? [];
      allPhorestProducts = allPhorestProducts.concat(pageProducts);

      const pageInfo = productsResponse.page || productsResponse;
      totalPages = pageInfo.totalPages || 1;
      page++;
    }

    let products = allPhorestProducts.filter((p: any) =>
      !p.name?.toLowerCase().includes('delete') &&
      !p.archived
    );

    const retailProducts = products.filter((p: any) =>
      p.type === 'RETAIL' &&
      p.price > 0
    );

    const approvedBrandProducts = retailProducts.filter((p: any) => isApprovedBrand(p.brandName));

    console.log(`[ProductCache] Fetched ${allPhorestProducts.length} total, ${retailProducts.length} RETAIL with price > $0, ${approvedBrandProducts.length} from approved brands`);

    const enrichableProducts = approvedBrandProducts;

    const brandsSet = new Set<string>();
    enrichableProducts.forEach((p: any) => {
      if (p.brandName) brandsSet.add(p.brandName);
    });
    const brands = Array.from(brandsSet).sort();

    const enrichedData = await productEnrichment.enrichProducts(enrichableProducts.map((p: any) => ({
      productId: p.productId,
      name: p.name,
      brandName: p.brandName,
      categoryName: p.categoryName,
      price: p.price,
      imageUrl: p.imageUrl,
      barcode: p.barcode,
    })));

    const cachedProducts: CachedProduct[] = enrichableProducts.map((p: any) => {
      const enriched = enrichedData.get(p.productId);
      return {
        productId: p.productId,
        name: p.name,
        description: enriched?.description || `Premium ${p.categoryName?.toLowerCase() || 'salon'} product by ${p.brandName || 'Kozeta'}`,
        price: p.price || 0,
        brandName: p.brandName,
        categoryName: p.categoryName,
        imageUrl: (enriched?.imageUrl && !enriched.imageUrl.includes('placehold.co')) ? enriched.imageUrl : '/kozeta-product-logo.svg',
        inStock: p.quantityInStock > 0,
        stockLevel: p.quantityInStock ?? p.stockLevel,
        sku: p.sku || p.barcode,
        type: p.type
      };
    });

    cache.allProducts = cachedProducts;

    cache.visibleProducts = cachedProducts.filter(p => p.inStock);

    const visibleBrandsSet = new Set<string>();
    cache.visibleProducts.forEach(p => {
      if (p.brandName) visibleBrandsSet.add(p.brandName);
    });
    cache.brands = Array.from(visibleBrandsSet).sort();

    cache.lastUpdated = Date.now();

    const duration = Date.now() - startTime;
    console.log(`[ProductCache] Cache warmed: ${cachedProducts.length} RETAIL products, ${cache.visibleProducts.length} visible, ${cache.brands.length} brands in ${duration}ms`);
  } catch (error) {
    console.error('[ProductCache] Error warming cache:', error);
    // Cold-start recovery: if we have no data at all, retry quickly instead of
    // waiting for the next background refresh interval.
    if (cache.allProducts.length === 0) {
      scheduleColdStartRetry();
    }
  } finally {
    cache.isWarming = false;
  }
}

let coldStartRetryTimer: NodeJS.Timeout | null = null;
function scheduleColdStartRetry(): void {
  if (coldStartRetryTimer) return;
  console.log('[ProductCache] Cache empty after failed warm-up — retrying in 30s');
  coldStartRetryTimer = setTimeout(async () => {
    coldStartRetryTimer = null;
    if (cache.allProducts.length === 0 && !cache.isWarming) {
      await warmCache();
    }
  }, 30_000);
}

function getMockProducts(): CachedProduct[] {
  return [
    { productId: "p1", name: "Olaplex No.3 Hair Perfector", brandName: "Olaplex", categoryName: "HAIR CARE", price: 30.00, inStock: true, description: "Revolutionary bond-building treatment that repairs and strengthens hair from the inside out.", imageUrl: "/kozeta-product-logo.svg" },
    { productId: "p2", name: "Pureology Hydrate Shampoo", brandName: "Pureology", categoryName: "SHAMPOO", price: 36.00, inStock: true, description: "Sulfate-free shampoo that gently cleanses while providing intense hydration.", imageUrl: "/kozeta-product-logo.svg" },
    { productId: "p3", name: "Kerastase Elixir Ultime", brandName: "Kerastase", categoryName: "TREATMENT", price: 58.00, inStock: true, description: "Luxurious oil blend that adds brilliant shine and silky softness to all hair types.", imageUrl: "/kozeta-product-logo.svg" },
    { productId: "p4", name: "Oribe Gold Lust Shampoo", brandName: "Oribe", categoryName: "SHAMPOO", price: 49.00, inStock: false, description: "Indulgent shampoo that restores, nourishes, and revives dull, damaged hair.", imageUrl: "/kozeta-product-logo.svg" },
  ];
}

export function getProducts(options: {
  page?: number;
  size?: number;
  brandId?: string;
  search?: string;
}): {
  products: CachedProduct[];
  brands: string[];
  page: number;
  totalPages: number;
  totalElements: number;
  fromCache: boolean;
  cacheAge: number;
} {
  const { page = 0, size = 50, brandId, search } = options;

  let filteredProducts = [...cache.visibleProducts];

  if (brandId) {
    filteredProducts = filteredProducts.filter(p =>
      p.brandName?.toLowerCase() === brandId.toLowerCase()
    );
  }

  if (search) {
    const searchLower = search.toLowerCase();
    filteredProducts = filteredProducts.filter(p =>
      p.name?.toLowerCase().includes(searchLower) ||
      p.brandName?.toLowerCase().includes(searchLower) ||
      p.categoryName?.toLowerCase().includes(searchLower)
    );
  }

  const totalElements = filteredProducts.length;
  const totalPages = Math.ceil(totalElements / size);
  const startIndex = page * size;
  const paginatedProducts = filteredProducts.slice(startIndex, startIndex + size);

  return {
    products: paginatedProducts,
    brands: cache.brands,
    page,
    totalPages,
    totalElements,
    fromCache: true,
    cacheAge: Date.now() - cache.lastUpdated
  };
}

export function getAllProducts(options?: {
  search?: string;
  brandId?: string;
}): CachedProduct[] {
  let products = [...cache.allProducts];

  if (options?.brandId) {
    products = products.filter(p =>
      p.brandName?.toLowerCase() === options.brandId!.toLowerCase()
    );
  }

  if (options?.search) {
    const searchLower = options.search.toLowerCase();
    products = products.filter(p =>
      p.name?.toLowerCase().includes(searchLower) ||
      p.brandName?.toLowerCase().includes(searchLower) ||
      p.categoryName?.toLowerCase().includes(searchLower)
    );
  }

  return products;
}

export function getAllBrands(): string[] {
  const brandsSet = new Set<string>();
  cache.allProducts.forEach(p => {
    if (p.brandName) brandsSet.add(p.brandName);
  });
  return Array.from(brandsSet).sort();
}

export function isCacheReady(): boolean {
  return cache.allProducts.length > 0 && cache.lastUpdated > 0;
}

export function isCacheStale(): boolean {
  return Date.now() - cache.lastUpdated > CACHE_TTL;
}

export function getCacheStats(): {
  productCount: number;
  visibleCount: number;
  brandCount: number;
  lastUpdated: number;
  isWarming: boolean;
  isReady: boolean;
  isStale: boolean;
} {
  return {
    productCount: cache.allProducts.length,
    visibleCount: cache.visibleProducts.length,
    brandCount: cache.brands.length,
    lastUpdated: cache.lastUpdated,
    isWarming: cache.isWarming,
    isReady: isCacheReady(),
    isStale: isCacheStale()
  };
}

export function startBackgroundRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  refreshTimer = setInterval(() => {
    if (!cache.isWarming) {
      console.log('[ProductCache] Background refresh triggered');
      warmCache();
    }
  }, BACKGROUND_REFRESH_INTERVAL);

  console.log(`[ProductCache] Background refresh scheduled every ${BACKGROUND_REFRESH_INTERVAL / 1000 / 60} minutes`);
}

export function stopBackgroundRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export async function refreshCacheIfStale(): Promise<void> {
  if (isCacheStale() && !cache.isWarming) {
    warmCache();
  }
}

export async function forceRefresh(): Promise<void> {
  cache.lastUpdated = 0;
  await warmCache();
}

export async function getCachedProducts(): Promise<{ products: CachedProduct[] }> {
  if (!isCacheReady()) {
    await warmCache();
  }
  return { products: cache.visibleProducts };
}

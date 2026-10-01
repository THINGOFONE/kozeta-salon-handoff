/**
 * Barcode-based product image lookup using Open Beauty Facts (free)
 * with fallback to Barcode Lookup API (paid - optional)
 * 
 * Open Beauty Facts: Free, open-source beauty product database
 * Barcode Lookup: Paid service with 12M+ products
 */

interface BarcodeResult {
  imageUrl: string | null;
  productName?: string;
  brand?: string;
  source: 'open_beauty_facts' | 'barcode_lookup' | 'fallback';
}

const barcodeCache = new Map<string, BarcodeResult>();

/**
 * Look up product image from Open Beauty Facts (FREE)
 * API: https://world.openbeautyfacts.org/api/v2/product/{barcode}.json
 */
async function lookupOpenBeautyFacts(barcode: string): Promise<BarcodeResult | null> {
  try {
    const cleanBarcode = barcode.replace(/\D/g, '');
    if (!cleanBarcode || cleanBarcode.length < 6) {
      return null;
    }
    
    const url = `https://world.openbeautyfacts.org/api/v2/product/${cleanBarcode}.json`;
    console.log(`[BarcodeImageLookup] Open Beauty Facts lookup: ${cleanBarcode}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'KozetaSalonPortal/1.0 (contact@example.com)'
      }
    });
    
    if (!response.ok) {
      console.log(`[BarcodeImageLookup] Open Beauty Facts returned ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    if (data.status !== 1 || !data.product) {
      console.log(`[BarcodeImageLookup] Product not found in Open Beauty Facts`);
      return null;
    }
    
    const product = data.product;
    
    // Get the best available image (front > main > any)
    const imageUrl = product.image_front_url || 
                     product.image_url || 
                     product.selected_images?.front?.display?.en ||
                     null;
    
    if (imageUrl) {
      console.log(`[BarcodeImageLookup] Found image from Open Beauty Facts: ${imageUrl.substring(0, 60)}...`);
      return {
        imageUrl,
        productName: product.product_name || product.product_name_en,
        brand: product.brands,
        source: 'open_beauty_facts'
      };
    }
    
    return null;
  } catch (error) {
    console.error('[BarcodeImageLookup] Open Beauty Facts error:', error);
    return null;
  }
}

/**
 * Look up product image from Barcode Lookup API (PAID - requires API key)
 * API: https://api.barcodelookup.com/v3/products?barcode={barcode}&key={api_key}
 */
async function lookupBarcodeLookupApi(barcode: string): Promise<BarcodeResult | null> {
  const apiKey = process.env.BARCODE_LOOKUP_API_KEY;
  if (!apiKey) {
    return null;
  }
  
  try {
    const cleanBarcode = barcode.replace(/\D/g, '');
    if (!cleanBarcode || cleanBarcode.length < 6) {
      return null;
    }
    
    const url = `https://api.barcodelookup.com/v3/products?barcode=${cleanBarcode}&key=${apiKey}`;
    console.log(`[BarcodeImageLookup] Barcode Lookup API lookup: ${cleanBarcode}`);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      console.log(`[BarcodeImageLookup] Barcode Lookup API returned ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    if (!data.products || data.products.length === 0) {
      console.log(`[BarcodeImageLookup] Product not found in Barcode Lookup API`);
      return null;
    }
    
    const product = data.products[0];
    const images = product.images || [];
    const imageUrl = images[0] || null;
    
    if (imageUrl) {
      console.log(`[BarcodeImageLookup] Found image from Barcode Lookup API: ${imageUrl.substring(0, 60)}...`);
      return {
        imageUrl,
        productName: product.title || product.product_name,
        brand: product.brand,
        source: 'barcode_lookup'
      };
    }
    
    return null;
  } catch (error) {
    console.error('[BarcodeImageLookup] Barcode Lookup API error:', error);
    return null;
  }
}

/**
 * Look up product image by barcode
 * Tries Open Beauty Facts first (free), then Barcode Lookup API (paid) if configured
 */
export async function lookupProductImage(barcode: string): Promise<BarcodeResult> {
  if (!barcode) {
    return { imageUrl: null, source: 'fallback' };
  }
  
  const cleanBarcode = barcode.replace(/\D/g, '');
  
  // Check cache first
  const cached = barcodeCache.get(cleanBarcode);
  if (cached) {
    console.log(`[BarcodeImageLookup] Cache hit for barcode: ${cleanBarcode}`);
    return cached;
  }
  
  // Try Open Beauty Facts first (free)
  let result = await lookupOpenBeautyFacts(cleanBarcode);
  
  // If not found, try Barcode Lookup API (paid, if configured)
  if (!result) {
    result = await lookupBarcodeLookupApi(cleanBarcode);
  }
  
  // Fallback
  if (!result) {
    result = { imageUrl: null, source: 'fallback' };
  }
  
  // Cache the result
  barcodeCache.set(cleanBarcode, result);
  
  return result;
}

/**
 * Batch lookup for multiple products
 */
export async function lookupProductImages(barcodes: string[]): Promise<Map<string, BarcodeResult>> {
  const results = new Map<string, BarcodeResult>();
  
  // Process in parallel with rate limiting (max 5 concurrent)
  const chunks: string[][] = [];
  for (let i = 0; i < barcodes.length; i += 5) {
    chunks.push(barcodes.slice(i, i + 5));
  }
  
  for (const chunk of chunks) {
    const promises = chunk.map(async (barcode) => {
      const result = await lookupProductImage(barcode);
      return { barcode: barcode.replace(/\D/g, ''), result };
    });
    
    const chunkResults = await Promise.all(promises);
    for (const { barcode, result } of chunkResults) {
      results.set(barcode, result);
    }
  }
  
  return results;
}

export function clearBarcodeCache(): void {
  barcodeCache.clear();
  console.log('[BarcodeImageLookup] Cache cleared');
}

export function getBarcodeCacheStats(): { 
  size: number; 
  hits: { openBeautyFacts: number; barcodeLookup: number; fallback: number };
} {
  let openBeautyFacts = 0;
  let barcodeLookup = 0;
  let fallback = 0;
  
  barcodeCache.forEach(result => {
    switch (result.source) {
      case 'open_beauty_facts': openBeautyFacts++; break;
      case 'barcode_lookup': barcodeLookup++; break;
      default: fallback++;
    }
  });
  
  return {
    size: barcodeCache.size,
    hits: { openBeautyFacts, barcodeLookup, fallback }
  };
}

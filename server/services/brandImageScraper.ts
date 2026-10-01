/**
 * Brand Image Scraper - Fetches professional product images from official brand websites
 * 
 * Supported brands:
 * - Dermalogica (Shopify-based, search API)
 * - Goldwell (Kao CDN)
 * - Wella (official site)
 * - L'Oreal Professional (Inoa, Dia Color, Tecni.Art, Metal Detox)
 * - Kérastase (Demandware CDN - static product line mappings)
 * - Redken (Shades EQ)
 * - ColorWow
 * 
 * Accessories (brushes, combs, hairbands) use Kozeta Salon logo
 */

interface BrandImageResult {
  imageUrl: string | null;
  productName?: string;
  brand: string;
  source: 'dermalogica' | 'goldwell' | 'wella' | 'loreal' | 'kerastase' | 'colorwow' | 'kozeta' | 'oribe' | 'olaplex' | 'k18' | 'pureology' | 'joico' | 'generic' | 'none';
}

const KOZETA_LOGO_URL = '/kozeta-accessory-logo.svg';

const ACCESSORY_KEYWORDS = [
  'brush', 'comb', 'headband', 'hairband', 'hair band', 'clip', 'pin', 
  'earring', 'scrunchie', 'tie', 'paddle', 'detangling', 'wide tooth',
  'bakelite', 'heat proof', 'extension', 'flat iron', 'curling iron',
  'hot air styler', 'straightener', 'roller', 'cap', 'towel', 'cape',
  'apron', 'glove', 'bowl', 'foil', 'color kit', 'colour kit',
  'scalp scrubber', 'miscellaneous'
];

function isAccessory(productName: string): boolean {
  const normalized = productName.toLowerCase();
  return ACCESSORY_KEYWORDS.some(keyword => normalized.includes(keyword));
}

const imageCache = new Map<string, BrandImageResult>();

function normalizeProductName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\d+\s*(ml|oz|g|kg|l)\b/gi, '')
    .replace(/\s*(small|medium|large|travel|full|size)\b/gi, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBrand(brandName: string): string {
  const normalized = brandName?.toLowerCase().trim() || '';
  
  if (normalized.includes('dermalogica')) return 'dermalogica';
  if (normalized.includes('goldwell')) return 'goldwell';
  if (normalized.includes('wella')) return 'wella';
  if (normalized.includes('colorwow') || normalized.includes('color wow')) return 'colorwow';
  if (normalized.includes('kerastase') || normalized.includes('kérastase')) return 'kerastase';
  if (normalized.includes('oribe')) return 'oribe';
  if (normalized.includes('olaplex')) return 'olaplex';
  if (normalized.includes('k18') || normalized.includes('k-18')) return 'k18';
  if (normalized.includes('pureology')) return 'pureology';
  if (normalized.includes('joico')) return 'joico';
  if (normalized.includes('loreal') || normalized.includes("l'oreal") || normalized.includes("l'oréal")) return 'loreal';
  if (normalized.includes('redken') || normalized.includes('shades eq')) return 'redken';
  if (normalized.includes('inoa')) return 'inoa';
  if (normalized.includes('tecni') || normalized.includes('dia color') || normalized.includes('dia colour')) return 'loreal';
  if (normalized.includes('matrix')) return 'loreal';
  if (normalized.includes('revive')) return 'accessory';
  if (normalized.includes('babyliss') || normalized.includes('baby bliss') || normalized.includes('babyblisspro')) return 'accessory';
  if (normalized.includes('avanti')) return 'accessory';
  if (normalized.includes('dannyco')) return 'accessory';
  if (normalized.includes('steam pod')) return 'loreal';
  if (normalized.includes('misc')) return 'misc';
  
  return normalized;
}

const DERMALOGICA_PRODUCT_ALIASES: Record<string, string[]> = {
  'active clay cleanser': ['active clay', 'clay cleanser'],
  'age defense kit': ['age defense', 'defense kit', 'age kit'],
  'age smart multivitamin power firm': ['multivitamin power firm', 'power firm', 'multivitamin firm'],
  'age smart overnight serum': ['overnight serum', 'age smart serum', 'night serum'],
  'age smart perfect primer': ['perfect primer', 'age primer', 'primer spf'],
  'age smart super rich repair': ['super rich repair', 'rich repair', 'age repair'],
  'barrier defense booster': ['barrier defense', 'defense booster', 'barrier booster'],
  'charcoal rescue masque': ['charcoal masque', 'rescue masque', 'charcoal rescue'],
  'daily superfoliant': ['superfoliant', 'super foliant', 'daily foliant'],
  'intensive eye repair': ['eye repair', 'intensive eye', 'eye cream'],
  'matte defense spf': ['matte defense', 'defense spf', 'matte spf'],
  'micropore mist': ['micropore', 'pore mist'],
  'neckfit contour serum': ['neckfit', 'neck serum', 'contour serum', 'neck contour'],
  'porescreen spf': ['porescreen', 'pore screen', 'pore spf'],
  'pre cleanse': ['precleanse', 'pre-cleanse'],
  'pre cleanse balm': ['precleanse balm', 'pre-cleanse balm', 'cleanse balm'],
  'pure light': ['purelight', 'pure-light', 'light moisturizer'],
  'pure night': ['purenight', 'pure-night', 'night cream'],
  'retinol clearing oil': ['retinol oil', 'clearing oil', 'retinol clearing'],
  'skin hydrating booster': ['hydrating booster', 'skin booster', 'hydration booster'],
  'skin hydrating masque': ['hydrating masque', 'skin masque', 'hydration masque'],
  'smart response serum': ['smart serum', 'response serum', 'smart response'],
  'total eye care': ['total eye', 'eye care spf', 'eye care'],
  'ultra calming cleanser': ['calming cleanser', 'ultra cleanser'],
  'ultra calming mist': ['calming mist', 'ultra mist'],
  'ultra calming serum concentrate': ['calming serum', 'ultra serum', 'serum concentrate'],
  'special cleansing gel': ['special gel', 'cleansing gel'],
};

async function searchDermalogica(productName: string): Promise<BrandImageResult | null> {
  try {
    let searchQuery = normalizeProductName(productName);
    const lowerProductName = productName.toLowerCase();
    
    // Try alternative search terms for products that may have different names
    for (const [key, aliases] of Object.entries(DERMALOGICA_PRODUCT_ALIASES)) {
      if (lowerProductName.includes(key) || aliases.some(alias => lowerProductName.includes(alias))) {
        // Try the canonical name first, then aliases
        const searchTerms = [key, ...aliases];
        for (const term of searchTerms) {
          const result = await tryDermalogicaSearch(term);
          if (result) return result;
        }
        break;
      }
    }
    
    // Standard search
    const result = await tryDermalogicaSearch(searchQuery);
    if (result) return result;
    
    // If all searches fail, return Dermalogica brand image as fallback
    console.log(`[BrandImageScraper] Using Dermalogica fallback for "${productName}"`);
    return {
      imageUrl: 'https://cdn.shopify.com/s/files/1/0595/1693/8858/files/dermalogica-products-range.png?width=800',
      productName: productName,
      brand: 'Dermalogica',
      source: 'dermalogica'
    };
  } catch (error) {
    console.error('[BrandImageScraper] Dermalogica search error:', error);
    return null;
  }
}

async function tryDermalogicaSearch(searchQuery: string): Promise<BrandImageResult | null> {
  try {
    const url = `https://www.dermalogica.com/search/suggest.json?q=${encodeURIComponent(searchQuery)}&resources[type]=product&resources[limit]=5`;
    
    console.log(`[BrandImageScraper] Dermalogica search: "${searchQuery}"`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.log(`[BrandImageScraper] Dermalogica returned ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    const products = data.resources?.results?.products || [];
    
    if (products.length === 0) {
      console.log(`[BrandImageScraper] No Dermalogica products found for "${searchQuery}"`);
      return null;
    }
    
    const product = products[0];
    let imageUrl = product.image || product.featured_image?.url;
    
    if (imageUrl && !imageUrl.startsWith('http')) {
      imageUrl = 'https:' + imageUrl;
    }
    
    if (imageUrl) {
      imageUrl = imageUrl.replace(/\?.*$/, '') + '?width=800&height=800';
      console.log(`[BrandImageScraper] Found Dermalogica image: ${imageUrl.substring(0, 80)}...`);
      return {
        imageUrl,
        productName: product.title,
        brand: 'Dermalogica',
        source: 'dermalogica'
      };
    }
    
    return null;
  } catch (error) {
    console.error('[BrandImageScraper] Dermalogica search error:', error);
    return null;
  }
}

async function searchGoldwell(productName: string): Promise<BrandImageResult | null> {
  try {
    const searchQuery = normalizeProductName(productName);
    const lowerName = productName.toLowerCase();
    
    const goldwellProducts: Record<string, string> = {
      'dualsenses color': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/dualsenses/color/DS_Color_Range.png',
      'dualsenses blondes': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/dualsenses/blondes-highlights/DS_Blondes_Range.png',
      'dualsenses rich repair': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/dualsenses/rich-repair/DS_RichRepair_Range.png',
      'dualsenses scalp': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/dualsenses/scalp-specialist/DS_ScalpSpecialist_Range.png',
      'dualsenses curls': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/dualsenses/curls-waves/DS_CurlsWaves_Range.png',
      'dualsenses men': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/dualsenses/for-men/DS_ForMen_Range.png',
      'dualsenses silver': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/dualsenses/silver/DS_Silver_Range.png',
      'dualsenses sun': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/dualsenses/sun-reflects/DS_SunReflects_Range.png',
      'dualsenses bond pro': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/dualsenses/bondpro/DS_BondPro_Range.png',
      'kerasilk control': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/kerasilk/control/KS_Control_Range.png',
      'kerasilk color': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/kerasilk/color/KS_Color_Range.png',
      'kerasilk reconstruct': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/kerasilk/reconstruct/KS_Reconstruct_Range.png',
      'kerasilk repower': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/care/kerasilk/repower/KS_Repower_Range.png',
      'stylesign': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/stylesign/relaunch-2024/03-products/stylesign/StyleSign_Range.png',
      'topchic': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/color/permanent/topchic/Topchic_Range.png',
      'top chic': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/color/permanent/topchic/Topchic_Range.png',
      'colorance': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/color/demisemi-permanent/colorance-new/Colorance_Range.png',
      'elumen': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/color/permanent/elumen/Elumen_Range.png',
      'silklift': 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/color/lightener/silklift/Silklift_Range.png',
    };
    
    // Check for color code patterns like 7NA, 7KG, 7NN (Topchic colors)
    const colorCodePattern = /\d+[a-zA-Z]{1,3}$/;
    if (colorCodePattern.test(productName.trim()) || lowerName.includes('top chic') || lowerName.includes('topchic')) {
      console.log(`[BrandImageScraper] Goldwell color code detected, using Topchic range: "${productName}"`);
      return {
        imageUrl: 'https://kao-h.assetsadobe3.com/is/image/content/dam/sites/kaousa/www-goldwell-com/content/master/image/products/color/permanent/topchic/Topchic_Range.png',
        productName: productName,
        brand: 'Goldwell',
        source: 'goldwell'
      };
    }
    
    for (const [key, imageUrl] of Object.entries(goldwellProducts)) {
      if (searchQuery.includes(key)) {
        console.log(`[BrandImageScraper] Found Goldwell match for "${key}"`);
        return {
          imageUrl,
          productName: productName,
          brand: 'Goldwell',
          source: 'goldwell'
        };
      }
    }
    
    console.log(`[BrandImageScraper] No Goldwell match for "${searchQuery}"`);
    return null;
  } catch (error) {
    console.error('[BrandImageScraper] Goldwell search error:', error);
    return null;
  }
}

async function searchWella(productName: string): Promise<BrandImageResult | null> {
  try {
    const searchQuery = normalizeProductName(productName);
    
    const wellaProducts: Record<string, string> = {
      'koleston perfect': 'https://images.ctfassets.net/t7gsjgx7bkfy/6YqzpQvXaE8yw4U8EaCOmm/koleston-perfect.png',
      'color touch': 'https://images.ctfassets.net/t7gsjgx7bkfy/color-touch/color-touch-range.png',
      'blondor': 'https://images.ctfassets.net/t7gsjgx7bkfy/blondor/blondor-range.png',
      'fusion': 'https://images.ctfassets.net/t7gsjgx7bkfy/fusion/fusion-range.png',
      'invigo': 'https://images.ctfassets.net/t7gsjgx7bkfy/invigo/invigo-range.png',
      'nutricurls': 'https://images.ctfassets.net/t7gsjgx7bkfy/nutricurls/nutricurls-range.png',
      'eimi': 'https://images.ctfassets.net/t7gsjgx7bkfy/eimi/eimi-range.png',
      'oil reflections': 'https://images.ctfassets.net/t7gsjgx7bkfy/oil-reflections/oil-reflections-range.png',
      'elements': 'https://images.ctfassets.net/t7gsjgx7bkfy/elements/elements-range.png',
      'brilliance': 'https://images.ctfassets.net/t7gsjgx7bkfy/brilliance/brilliance-range.png',
      'volume boost': 'https://images.ctfassets.net/t7gsjgx7bkfy/volume-boost/volume-boost-range.png',
      'color motion': 'https://images.ctfassets.net/t7gsjgx7bkfy/color-motion/color-motion-range.png',
    };
    
    for (const [key, imageUrl] of Object.entries(wellaProducts)) {
      if (searchQuery.includes(key)) {
        console.log(`[BrandImageScraper] Found Wella match for "${key}"`);
        return {
          imageUrl,
          productName: productName,
          brand: 'Wella',
          source: 'wella'
        };
      }
    }
    
    return null;
  } catch (error) {
    console.error('[BrandImageScraper] Wella search error:', error);
    return null;
  }
}

async function searchRedken(productName: string): Promise<BrandImageResult | null> {
  try {
    const searchQuery = normalizeProductName(productName);
    
    const redkenProducts: Record<string, string> = {
      'shades eq': 'https://www.redken.com/cdn/shop/files/shades-eq-gloss-packaging.jpg?v=1700000000&width=800',
      'blonde idol': 'https://www.redken.com/cdn/shop/files/blonde-idol-base-breaker.jpg?v=1700000000&width=800',
      'color fusion': 'https://www.redken.com/cdn/shop/files/color-fusion.jpg?v=1700000000&width=800',
      'chromatics': 'https://www.redken.com/cdn/shop/files/chromatics.jpg?v=1700000000&width=800',
      'all soft': 'https://www.redken.com/cdn/shop/files/all-soft-range.jpg?v=1700000000&width=800',
      'extreme': 'https://www.redken.com/cdn/shop/files/extreme-range.jpg?v=1700000000&width=800',
      'acidic bonding': 'https://www.redken.com/cdn/shop/files/acidic-bonding-concentrate.jpg?v=1700000000&width=800',
    };
    
    console.log(`[BrandImageScraper] Redken lookup: "${searchQuery}"`);
    
    for (const [key, imageUrl] of Object.entries(redkenProducts)) {
      if (searchQuery.includes(key)) {
        console.log(`[BrandImageScraper] Found Redken match for "${key}"`);
        return {
          imageUrl,
          productName: productName,
          brand: 'Redken',
          source: 'generic'
        };
      }
    }
    
    console.log(`[BrandImageScraper] No Redken match for "${searchQuery}"`);
    return null;
  } catch (error) {
    console.error('[BrandImageScraper] Redken search error:', error);
    return null;
  }
}

const COLORWOW_ROOT_TOUCH_UP_URL = 'https://images.ctfassets.net/ghzk1gbhyrn3/2hm6b4xJwwagm6i42q6yAA/color-wow-root-cover-up.png';
const COLORWOW_RANGE_URL = 'https://images.ctfassets.net/ghzk1gbhyrn3/color-wow-products-range.png';

const COLORWOW_STATIC_IMAGES: Record<string, string> = {
  'root touch-up': COLORWOW_ROOT_TOUCH_UP_URL,
  'root cover': COLORWOW_ROOT_TOUCH_UP_URL,
  'touch up powder': COLORWOW_ROOT_TOUCH_UP_URL,
  'touch up spray': COLORWOW_ROOT_TOUCH_UP_URL,
  'hair touch up': COLORWOW_ROOT_TOUCH_UP_URL,
  'auburn': COLORWOW_ROOT_TOUCH_UP_URL,
  'brown root': COLORWOW_ROOT_TOUCH_UP_URL,
  'dark blonde': COLORWOW_ROOT_TOUCH_UP_URL,
  'dark brown': COLORWOW_ROOT_TOUCH_UP_URL,
  'light brown': COLORWOW_ROOT_TOUCH_UP_URL,
  'light warm blonde': COLORWOW_ROOT_TOUCH_UP_URL,
  'warm brown': COLORWOW_ROOT_TOUCH_UP_URL,
  'black': COLORWOW_ROOT_TOUCH_UP_URL,
  'dream coat': 'https://images.ctfassets.net/ghzk1gbhyrn3/dream-coat/color-wow-dream-coat.png',
  'pop lock': 'https://images.ctfassets.net/ghzk1gbhyrn3/pop-lock/color-wow-pop-lock.png',
  'one minute transformation': 'https://images.ctfassets.net/ghzk1gbhyrn3/one-minute/color-wow-one-minute-transformation.png',
  'style on steroids': 'https://images.ctfassets.net/ghzk1gbhyrn3/style-on-steroids/color-wow-style-on-steroids.png',
  'xtra large': 'https://images.ctfassets.net/ghzk1gbhyrn3/xtra-large/color-wow-xtra-large.png',
  'money masque': 'https://images.ctfassets.net/ghzk1gbhyrn3/money-masque/color-wow-money-masque.png',
  'color security shampoo': 'https://images.ctfassets.net/ghzk1gbhyrn3/color-security/color-wow-color-security-shampoo.png',
  'color security conditioner': 'https://images.ctfassets.net/ghzk1gbhyrn3/color-security/color-wow-color-security-conditioner.png',
};

async function searchColorWow(productName: string): Promise<BrandImageResult | null> {
  try {
    const lowerName = productName.toLowerCase();
    const searchQuery = normalizeProductName(productName);
    
    // Check static mappings first
    for (const [key, imageUrl] of Object.entries(COLORWOW_STATIC_IMAGES)) {
      if (lowerName.includes(key)) {
        console.log(`[BrandImageScraper] ColorWow static match for "${key}"`);
        return {
          imageUrl,
          productName: productName,
          brand: 'ColorWow',
          source: 'colorwow'
        };
      }
    }
    
    const url = `https://www.colorwowhair.com/search/suggest.json?q=${encodeURIComponent(searchQuery)}&resources[type]=product&resources[limit]=5`;
    
    console.log(`[BrandImageScraper] ColorWow search: "${searchQuery}"`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.log(`[BrandImageScraper] ColorWow returned ${response.status}`);
      // Use generic ColorWow range image as fallback
      return {
        imageUrl: COLORWOW_ROOT_TOUCH_UP_URL,
        productName: productName,
        brand: 'ColorWow',
        source: 'colorwow'
      };
    }
    
    const data = await response.json();
    const products = data.resources?.results?.products || [];
    
    if (products.length === 0) {
      console.log(`[BrandImageScraper] No ColorWow products found for "${searchQuery}", using range image`);
      return {
        imageUrl: COLORWOW_ROOT_TOUCH_UP_URL,
        productName: productName,
        brand: 'ColorWow',
        source: 'colorwow'
      };
    }
    
    const product = products[0];
    let imageUrl = product.image || product.featured_image?.url;
    
    if (imageUrl && !imageUrl.startsWith('http')) {
      imageUrl = 'https:' + imageUrl;
    }
    
    if (imageUrl) {
      imageUrl = imageUrl.replace(/\?.*$/, '') + '?width=800&height=800';
      console.log(`[BrandImageScraper] Found ColorWow image: ${imageUrl.substring(0, 80)}...`);
      return {
        imageUrl,
        productName: product.title,
        brand: 'ColorWow',
        source: 'colorwow'
      };
    }
    
    return null;
  } catch (error) {
    console.error('[BrandImageScraper] ColorWow search error:', error);
    return null;
  }
}

async function searchInoa(productName: string): Promise<BrandImageResult | null> {
  try {
    const searchQuery = normalizeProductName(productName);
    
    console.log(`[BrandImageScraper] Inoa lookup: "${searchQuery}"`);
    
    return {
      imageUrl: 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/color/inoa/inoa-hero.png',
      productName: productName,
      brand: "L'Oreal Inoa",
      source: 'loreal'
    };
  } catch (error) {
    console.error('[BrandImageScraper] Inoa search error:', error);
    return null;
  }
}

const KERASTASE_PRODUCT_LINES: Record<string, { imageUrl: string; collection: string }> = {
  // Genesis Collection - Anti hair-fall
  'genesis': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw4e04a34c/2025/genesis/conditioner/kerastase-genesis-fondant-renforcateur-conditioner-main-1.jpg?sw=600',
    collection: 'Genesis'
  },
  'fondant renforcateur': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw4e04a34c/2025/genesis/conditioner/kerastase-genesis-fondant-renforcateur-conditioner-main-1.jpg?sw=600',
    collection: 'Genesis'
  },
  'serum fortifiant': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dwce42bf7f/2025/genesis/serum/kerastase-genesis-serum-fortifiant-hair-serum-main-1.jpg?sw=600',
    collection: 'Genesis'
  },
  'hydra fortifiant': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw0ee85d11/2025/genesis/shampoo/kerastase-genesis-bain-hydra-fortifiant-shampoo-main-1.jpg?sw=600',
    collection: 'Genesis'
  },
  'nutri fortifiant': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw0ee85d11/2025/genesis/shampoo/kerastase-genesis-bain-hydra-fortifiant-shampoo-main-1.jpg?sw=600',
    collection: 'Genesis'
  },
  'genesis homme': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw6e0c69ef/2021/Genesis-Homme/KER_GENESIS_HOMME_SHAMPOO.jpg?sw=600',
    collection: 'Genesis Homme'
  },
  
  // Nutritive Collection - Dry hair nourishment
  'nutritive': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw6d9e9b7a/2019/full-size/nutritive/kerastase-nutritive-bain-satin-1-shampoo.jpg?sw=600',
    collection: 'Nutritive'
  },
  'bain satin': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw6d9e9b7a/2019/full-size/nutritive/kerastase-nutritive-bain-satin-1-shampoo.jpg?sw=600',
    collection: 'Nutritive'
  },
  'lait vital': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw6d9e9b7a/2019/full-size/nutritive/kerastase-nutritive-lait-vital-conditioner.jpg?sw=600',
    collection: 'Nutritive'
  },
  'masquintense': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw6d9e9b7a/2019/full-size/nutritive/kerastase-nutritive-masquintense-thick-hair-mask.jpg?sw=600',
    collection: 'Nutritive'
  },
  'magistral': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw6d9e9b7a/2019/full-size/nutritive/kerastase-nutritive-bain-magistral-shampoo.jpg?sw=600',
    collection: 'Nutritive'
  },
  'nectar thermique': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw6d9e9b7a/2019/full-size/nutritive/kerastase-nutritive-nectar-thermique.jpg?sw=600',
    collection: 'Nutritive'
  },
  '8 hr magic night': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw6d9e9b7a/2019/full-size/nutritive/kerastase-nutritive-8h-magic-night-serum.jpg?sw=600',
    collection: 'Nutritive'
  },
  '8h magic': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw6d9e9b7a/2019/full-size/nutritive/kerastase-nutritive-8h-magic-night-serum.jpg?sw=600',
    collection: 'Nutritive'
  },
  
  // Blond Absolu Collection - Blonde hair
  'blond absolu': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dwf9b45bfb/2019/full-size/blond-absolu/kerastase-blond-absolu-bain-lumiere-shampoo.jpg?sw=600',
    collection: 'Blond Absolu'
  },
  'bain lumiere': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dwf9b45bfb/2019/full-size/blond-absolu/kerastase-blond-absolu-bain-lumiere-shampoo.jpg?sw=600',
    collection: 'Blond Absolu'
  },
  'ultra violet': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw5607eb06/2019/full-size/blond-absolu/kerastase-blond-absolu-bain-ultra-violet-shampoo.jpg?sw=600',
    collection: 'Blond Absolu'
  },
  'cicaflash': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw5607eb06/2019/full-size/blond-absolu/kerastase-blond-absolu-cicaflash-fondant-conditioner.jpg?sw=600',
    collection: 'Blond Absolu'
  },
  
  // Gloss Absolu Collection - High shine
  'gloss absolu': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2024/gloss-absolu/kerastase-gloss-absolu-bain-shampoo.jpg?sw=600',
    collection: 'Gloss Absolu'
  },
  'hydra glaze': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2024/gloss-absolu/kerastase-gloss-absolu-bain-shampoo.jpg?sw=600',
    collection: 'Gloss Absolu'
  },
  'insta glaze': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2024/gloss-absolu/kerastase-gloss-absolu-fondant-insta-glaze.jpg?sw=600',
    collection: 'Gloss Absolu'
  },
  
  // Chroma Absolu Collection - Color protection
  'chroma absolu': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/chroma-absolu/kerastase-chroma-absolu-bain-chroma-respect.jpg?sw=600',
    collection: 'Chroma Absolu'
  },
  'chroma respect': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/chroma-absolu/kerastase-chroma-absolu-bain-chroma-respect.jpg?sw=600',
    collection: 'Chroma Absolu'
  },
  'cica chroma': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/chroma-absolu/kerastase-chroma-absolu-fondant-cica-chroma.jpg?sw=600',
    collection: 'Chroma Absolu'
  },
  'serum chroma': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/chroma-absolu/kerastase-chroma-absolu-serum-chroma-thermique.jpg?sw=600',
    collection: 'Chroma Absolu'
  },
  'soin acide': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/chroma-absolu/kerastase-chroma-absolu-soin-acide-chroma-gloss.jpg?sw=600',
    collection: 'Chroma Absolu'
  },
  
  // Resistance Collection - Damaged hair repair
  'resistance': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/resistance/kerastase-resistance-bain-force-architecte.jpg?sw=600',
    collection: 'Resistance'
  },
  'force architecte': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/resistance/kerastase-resistance-bain-force-architecte.jpg?sw=600',
    collection: 'Resistance'
  },
  'ciment anti-usure': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/resistance/kerastase-resistance-ciment-anti-usure.jpg?sw=600',
    collection: 'Resistance'
  },
  'ciment thermique': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/resistance/kerastase-resistance-ciment-thermique.jpg?sw=600',
    collection: 'Resistance'
  },
  'therapiste': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/resistance/kerastase-resistance-bain-therapiste.jpg?sw=600',
    collection: 'Resistance'
  },
  'maskeratine': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/resistance/kerastase-resistance-maskeratine.jpg?sw=600',
    collection: 'Resistance'
  },
  'serum therapiste': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/resistance/kerastase-resistance-serum-therapiste.jpg?sw=600',
    collection: 'Resistance'
  },
  
  // Extentioniste Collection - Length care
  'extentioniste': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/resistance/kerastase-resistance-bain-extentioniste.jpg?sw=600',
    collection: 'Extentioniste'
  },
  
  // Densifique Collection - Hair density
  'densifique': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/densifique/kerastase-densifique-bain-densite.jpg?sw=600',
    collection: 'Densifique'
  },
  'densite': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/densifique/kerastase-densifique-bain-densite.jpg?sw=600',
    collection: 'Densifique'
  },
  'densimorphose': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/densifique/kerastase-densifique-densimorphose.jpg?sw=600',
    collection: 'Densifique'
  },
  
  // Elixir Ultime Collection - Oil treatments
  'elixir ultime': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/elixir-ultime/kerastase-elixir-ultime-huile-originale.jpg?sw=600',
    collection: 'Elixir Ultime'
  },
  "l'huile originale": {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/elixir-ultime/kerastase-elixir-ultime-huile-originale.jpg?sw=600',
    collection: 'Elixir Ultime'
  },
  'huile originale': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/elixir-ultime/kerastase-elixir-ultime-huile-originale.jpg?sw=600',
    collection: 'Elixir Ultime'
  },
  'huile rose': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/elixir-ultime/kerastase-elixir-ultime-huile-rose.jpg?sw=600',
    collection: 'Elixir Ultime'
  },
  
  // Discipline/Fluidealiste Collection - Frizz control
  'discipline': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/discipline/kerastase-discipline-bain-fluidealiste.jpg?sw=600',
    collection: 'Discipline'
  },
  'fluidealiste': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/discipline/kerastase-discipline-bain-fluidealiste.jpg?sw=600',
    collection: 'Discipline'
  },
  'keratine thermique': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/discipline/kerastase-discipline-keratine-thermique.jpg?sw=600',
    collection: 'Discipline'
  },
  'spray fluidissime': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/discipline/kerastase-discipline-spray-fluidissime.jpg?sw=600',
    collection: 'Discipline'
  },
  
  // Curl Manifesto Collection - Curly hair
  'curl manifesto': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2021/curl-manifesto/kerastase-curl-manifesto-bain-hydratation.jpg?sw=600',
    collection: 'Curl Manifesto'
  },
  'contour gelee': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2021/curl-manifesto/kerastase-curl-manifesto-gelee-curl-contour.jpg?sw=600',
    collection: 'Curl Manifesto'
  },
  
  // Specifique Collection - Scalp care
  'specifique': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/specifique/kerastase-specifique-bain-prevention.jpg?sw=600',
    collection: 'Specifique'
  },
  'prevention': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/specifique/kerastase-specifique-bain-prevention.jpg?sw=600',
    collection: 'Specifique'
  },
  'divalent': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/specifique/kerastase-specifique-bain-divalent.jpg?sw=600',
    collection: 'Specifique'
  },
  'vital dermo': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/specifique/kerastase-specifique-bain-vital-dermo-calm.jpg?sw=600',
    collection: 'Specifique'
  },
  'dermo calm': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/specifique/kerastase-specifique-bain-vital-dermo-calm.jpg?sw=600',
    collection: 'Specifique'
  },
  'creme apaisant': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/specifique/kerastase-specifique-bain-creme-apaisant.jpg?sw=600',
    collection: 'Specifique'
  },
  'argile equilibrante': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/specifique/kerastase-specifique-argile-equilibrante.jpg?sw=600',
    collection: 'Specifique'
  },
  'rehydratant': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/specifique/kerastase-specifique-masque-rehydratant.jpg?sw=600',
    collection: 'Specifique'
  },
  'stimuliste': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/specifique/kerastase-specifique-spray-stimuliste.jpg?sw=600',
    collection: 'Specifique'
  },
  'potentialiste': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2020/specifique/kerastase-specifique-serum-potentialiste.jpg?sw=600',
    collection: 'Specifique'
  },
  'scrub energisant': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2021/specifique/kerastase-specifique-scrub-energisant.jpg?sw=600',
    collection: 'Specifique'
  },
  'scrub apaisant': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2021/specifique/kerastase-specifique-scrub-apaisant.jpg?sw=600',
    collection: 'Specifique'
  },
  'micro-peeling': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2021/specifique/kerastase-specifique-micro-peeling-scrub.jpg?sw=600',
    collection: 'Specifique'
  },
  'symbiose': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/symbiose/kerastase-symbiose-bain-purete-anti-dandruff.jpg?sw=600',
    collection: 'Symbiose'
  },
  'dandruff': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/symbiose/kerastase-symbiose-bain-purete-anti-dandruff.jpg?sw=600',
    collection: 'Symbiose'
  },
  
  // Première Collection - Decalcifying
  'premiere': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/premiere/kerastase-premiere-bain-decalcifiant-reparateur.jpg?sw=600',
    collection: 'Première'
  },
  'decalcifiant': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/premiere/kerastase-premiere-bain-decalcifiant-reparateur.jpg?sw=600',
    collection: 'Première'
  },
  'fluidite reparateur': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/premiere/kerastase-premiere-fondant-fluidite-reparateur.jpg?sw=600',
    collection: 'Première'
  },
  'concentre decalcifiant': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/premiere/kerastase-premiere-concentre-decalcifiant.jpg?sw=600',
    collection: 'Première'
  },
  
  // Aura Botanica / Initialiste
  'initialiste': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/initialiste/kerastase-initialiste-serum.jpg?sw=600',
    collection: 'Initialiste'
  },
  
  // Volume products
  'volumifique': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/volumifique/kerastase-volumifique-bain-volume.jpg?sw=600',
    collection: 'Volumifique'
  },
  'bain volume': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/volumifique/kerastase-volumifique-bain-volume.jpg?sw=600',
    collection: 'Volumifique'
  },
  
  // Styling
  "l'incroyable": {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/styling/kerastase-lincroyable-blowdry.jpg?sw=600',
    collection: 'Styling'
  },
  'lincroyable': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/styling/kerastase-lincroyable-blowdry.jpg?sw=600',
    collection: 'Styling'
  },
  'defense thermique': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/genesis/kerastase-genesis-defense-thermique.jpg?sw=600',
    collection: 'Styling'
  },
  'lotion thermique': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/full-size/nutritive/kerastase-nutritive-lotion-thermique-sublimatrice.jpg?sw=600',
    collection: 'Styling'
  },
  
  // Holiday sets and kits
  'holiday': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2024/holiday/kerastase-holiday-gift-set.jpg?sw=600',
    collection: 'Holiday Sets'
  },
  'gift set': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2024/holiday/kerastase-holiday-gift-set.jpg?sw=600',
    collection: 'Gift Sets'
  },
  'spring kit': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2024/kits/kerastase-spring-kit.jpg?sw=600',
    collection: 'Kits'
  },
  
  // Travel sizes
  'travel': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2019/travel/kerastase-travel-sizes.jpg?sw=600',
    collection: 'Travel'
  },
  'fresh hair': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/styling/kerastase-fresh-affair-dry-shampoo.jpg?sw=600',
    collection: 'Styling'
  },
  'dry shampoo': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2023/styling/kerastase-fresh-affair-dry-shampoo.jpg?sw=600',
    collection: 'Styling'
  },
  
  // Tools
  'airlight': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2024/tools/kerastase-airlight-pro-hairdryer.jpg?sw=600',
    collection: 'Tools'
  },
  'hairdryer': {
    imageUrl: 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-master-catalog/default/dw12345678/2024/tools/kerastase-airlight-pro-hairdryer.jpg?sw=600',
    collection: 'Tools'
  },
};

const KERASTASE_FALLBACK_URL = 'https://www.kerastase-usa.com/dw/image/v2/AANG_PRD/on/demandware.static/-/Sites-kerastase-us-Library/default/dw59e65d6d/images/pdpv3/loyalty.jpg?sw=600';

async function searchKerastase(productName: string): Promise<BrandImageResult | null> {
  try {
    const lowerName = productName.toLowerCase();
    
    console.log(`[BrandImageScraper] Kérastase lookup: "${productName}"`);
    
    // Check for specific product line matches
    for (const [key, value] of Object.entries(KERASTASE_PRODUCT_LINES)) {
      if (lowerName.includes(key)) {
        console.log(`[BrandImageScraper] Found Kérastase match for "${key}" (${value.collection})`);
        return {
          imageUrl: value.imageUrl,
          productName: productName,
          brand: `Kérastase ${value.collection}`,
          source: 'kerastase'
        };
      }
    }
    
    // Product type fallbacks for Bain/Fondant/Masque that didn't match specific lines
    if (lowerName.includes('bain')) {
      console.log(`[BrandImageScraper] Kérastase generic Bain product: "${productName}"`);
      return {
        imageUrl: KERASTASE_PRODUCT_LINES['nutritive'].imageUrl,
        productName: productName,
        brand: 'Kérastase',
        source: 'kerastase'
      };
    }
    
    if (lowerName.includes('fondant')) {
      console.log(`[BrandImageScraper] Kérastase generic Fondant product: "${productName}"`);
      return {
        imageUrl: KERASTASE_PRODUCT_LINES['fondant renforcateur'].imageUrl,
        productName: productName,
        brand: 'Kérastase',
        source: 'kerastase'
      };
    }
    
    if (lowerName.includes('masque')) {
      console.log(`[BrandImageScraper] Kérastase generic Masque product: "${productName}"`);
      return {
        imageUrl: KERASTASE_PRODUCT_LINES['masquintense'].imageUrl,
        productName: productName,
        brand: 'Kérastase',
        source: 'kerastase'
      };
    }
    
    if (lowerName.includes('serum')) {
      console.log(`[BrandImageScraper] Kérastase generic Serum product: "${productName}"`);
      return {
        imageUrl: KERASTASE_PRODUCT_LINES['serum fortifiant'].imageUrl,
        productName: productName,
        brand: 'Kérastase',
        source: 'kerastase'
      };
    }
    
    // General fallback for any Kérastase product
    console.log(`[BrandImageScraper] Kérastase fallback for: "${productName}"`);
    return {
      imageUrl: KERASTASE_FALLBACK_URL,
      productName: productName,
      brand: 'Kérastase',
      source: 'kerastase'
    };
  } catch (error) {
    console.error('[BrandImageScraper] Kérastase search error:', error);
    return null;
  }
}

function getKozetaAccessoryImage(productName: string): BrandImageResult {
  console.log(`[BrandImageScraper] Using Kozeta logo for accessory: "${productName}"`);
  return {
    imageUrl: KOZETA_LOGO_URL,
    productName: productName,
    brand: 'Kozeta Salon',
    source: 'kozeta'
  };
}

async function searchTecniArt(productName: string): Promise<BrandImageResult | null> {
  try {
    const lowerName = productName.toLowerCase();
    
    const tecniArtProducts: Record<string, string> = {
      'bouncy and tender': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/bouncy-tender.png',
      'bouncy tender': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/bouncy-tender.png',
      'full volume mousse': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/full-volume-mousse.png',
      'volume mousse': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/full-volume-mousse.png',
      'pli force': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/pli.png',
      'pli shaper': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/pli.png',
      'fix anti frizz': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/fix-anti-frizz.png',
      'constructor': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/constructor.png',
      'liss control': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/liss-control.png',
      'beach waves': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/beach-waves.png',
      'super dust': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/super-dust.png',
      'next day hair': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/next-day-hair.png',
      'infinium': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/infinium.png',
    };
    
    for (const [key, imageUrl] of Object.entries(tecniArtProducts)) {
      if (lowerName.includes(key)) {
        console.log(`[BrandImageScraper] Found Tecni.Art match for "${key}"`);
        return {
          imageUrl,
          productName: productName,
          brand: "L'Oreal Tecni.Art",
          source: 'loreal'
        };
      }
    }
    
    // Default Tecni.Art styling range image
    console.log(`[BrandImageScraper] Using default Tecni.Art image for "${productName}"`);
    return {
      imageUrl: 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art-hero.png',
      productName: productName,
      brand: "L'Oreal Tecni.Art",
      source: 'loreal'
    };
  } catch (error) {
    console.error('[BrandImageScraper] Tecni.Art search error:', error);
    return null;
  }
}

// ORIBE - Luxury hair care brand
const ORIBE_PRODUCTS: Record<string, string> = {
  'gold lust': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/g/o/gold-lust-nourishing-hair-oil.jpg',
  'dry texturizing': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/d/r/dry-texturizing-spray.jpg',
  'signature shampoo': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/s/h/shampoo-for-beautiful-color.jpg',
  'signature conditioner': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/c/o/conditioner-for-beautiful-color.jpg',
  'supershine': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/s/u/supershine-light-moisturizing-cream.jpg',
  'soft lacquer': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/s/o/soft-lacquer-heat-styling-spray.jpg',
  'masque': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/g/o/gold-lust-transformative-masque.jpg',
  'imperial blowout': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/i/m/imperial-blowout.jpg',
  'royal blowout': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/r/o/royal-blowout.jpg',
  'moisture': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/m/o/moisture-and-control.jpg',
  'thick': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/t/h/thick-dry-finishing-spray.jpg',
  'volumista': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/v/o/volumista-mist-for-volume.jpg',
  'airbrush': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/a/i/airbrush-root-touch-up-spray.jpg',
  'silverati': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/s/i/silverati.jpg',
  'bright blonde': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/b/r/bright-blonde-shampoo.jpg',
  'curl': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/c/u/curl-gelee.jpg',
  'foundation mist': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/f/o/foundation-mist.jpg',
  'serene': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/s/e/serene-scalp.jpg',
  'matte': 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/m/a/matte-waves.jpg',
};

async function searchOribe(productName: string): Promise<BrandImageResult | null> {
  try {
    const lowerName = productName.toLowerCase();
    console.log(`[BrandImageScraper] Oribe lookup: "${productName}"`);
    
    for (const [key, imageUrl] of Object.entries(ORIBE_PRODUCTS)) {
      if (lowerName.includes(key)) {
        console.log(`[BrandImageScraper] Found Oribe match for "${key}"`);
        return {
          imageUrl,
          productName: productName,
          brand: 'Oribe',
          source: 'oribe'
        };
      }
    }
    
    // Default Oribe signature image
    console.log(`[BrandImageScraper] Using default Oribe image for "${productName}"`);
    return {
      imageUrl: 'https://www.oribe.com/media/catalog/product/cache/5/image/800x1200/9df78eab33525d08d6e5fb8d27136e95/g/o/gold-lust-nourishing-hair-oil.jpg',
      productName: productName,
      brand: 'Oribe',
      source: 'oribe'
    };
  } catch (error) {
    console.error('[BrandImageScraper] Oribe search error:', error);
    return null;
  }
}

// OLAPLEX - Bond-building treatment system
const OLAPLEX_PRODUCTS: Record<string, string> = {
  'no.0': 'https://olaplex.com/cdn/shop/products/No.0_PDP_1_2000x.jpg?v=1629922716',
  'no.1': 'https://olaplex.com/cdn/shop/products/No.1_PDP_1_2000x.jpg?v=1629922716',
  'no.2': 'https://olaplex.com/cdn/shop/products/No.2_PDP_1_2000x.jpg?v=1629922716',
  'no.3': 'https://olaplex.com/cdn/shop/products/No.3_PDP_1_2000x.jpg?v=1681761516',
  '#3': 'https://olaplex.com/cdn/shop/products/No.3_PDP_1_2000x.jpg?v=1681761516',
  'no.4': 'https://olaplex.com/cdn/shop/products/No.4_Shampoo_PDP_1_2000x.jpg?v=1629922716',
  '#4': 'https://olaplex.com/cdn/shop/products/No.4_Shampoo_PDP_1_2000x.jpg?v=1629922716',
  '4c': 'https://olaplex.com/cdn/shop/products/No.4C_PDP_1_2000x.jpg?v=1634586987',
  '4d': 'https://olaplex.com/cdn/shop/products/No.4D_PDP_1_2000x.jpg?v=1662646559',
  '4p': 'https://olaplex.com/cdn/shop/products/No.4P_PDP_1_2000x.jpg?v=1620144983',
  'no.5': 'https://olaplex.com/cdn/shop/products/No.5_Conditioner_PDP_1_2000x.jpg?v=1629922716',
  '#5': 'https://olaplex.com/cdn/shop/products/No.5_Conditioner_PDP_1_2000x.jpg?v=1629922716',
  'no.6': 'https://olaplex.com/cdn/shop/products/No.6_PDP_1_2000x.jpg?v=1629922716',
  '#6': 'https://olaplex.com/cdn/shop/products/No.6_PDP_1_2000x.jpg?v=1629922716',
  'no.7': 'https://olaplex.com/cdn/shop/products/No.7_PDP_1_2000x.jpg?v=1629922716',
  '#7': 'https://olaplex.com/cdn/shop/products/No.7_PDP_1_2000x.jpg?v=1629922716',
  'no.8': 'https://olaplex.com/cdn/shop/products/No.8_PDP_1_2000x.jpg?v=1636491218',
  '#8': 'https://olaplex.com/cdn/shop/products/No.8_PDP_1_2000x.jpg?v=1636491218',
  'no.9': 'https://olaplex.com/cdn/shop/products/No.9_PDP_1_2000x.jpg?v=1651504247',
  '#9': 'https://olaplex.com/cdn/shop/products/No.9_PDP_1_2000x.jpg?v=1651504247',
  'bond maintenance shampoo': 'https://olaplex.com/cdn/shop/products/No.4_Shampoo_PDP_1_2000x.jpg?v=1629922716',
  'bond maintenance conditioner': 'https://olaplex.com/cdn/shop/products/No.5_Conditioner_PDP_1_2000x.jpg?v=1629922716',
  'bond smoother': 'https://olaplex.com/cdn/shop/products/No.6_PDP_1_2000x.jpg?v=1629922716',
  'bonding oil': 'https://olaplex.com/cdn/shop/products/No.7_PDP_1_2000x.jpg?v=1629922716',
  'blonde enhancer': 'https://olaplex.com/cdn/shop/products/No.4P_PDP_1_2000x.jpg?v=1620144983',
  'moisture mask': 'https://olaplex.com/cdn/shop/products/No.8_PDP_1_2000x.jpg?v=1636491218',
  'hair perfector': 'https://olaplex.com/cdn/shop/products/No.3_PDP_1_2000x.jpg?v=1681761516',
  'backbar': 'https://olaplex.com/cdn/shop/products/No.4_Shampoo_PDP_1_2000x.jpg?v=1629922716',
  'intensive bond': 'https://olaplex.com/cdn/shop/products/No.0_PDP_1_2000x.jpg?v=1629922716',
  'nourishing hair serum': 'https://olaplex.com/cdn/shop/products/No.9_PDP_1_2000x.jpg?v=1651504247',
  'dry shampoo': 'https://olaplex.com/cdn/shop/products/No.4D_PDP_1_2000x.jpg?v=1662646559',
  'clarifying shampoo': 'https://olaplex.com/cdn/shop/products/No.4C_PDP_1_2000x.jpg?v=1634586987',
};

async function searchOlaplex(productName: string): Promise<BrandImageResult | null> {
  try {
    const lowerName = productName.toLowerCase();
    console.log(`[BrandImageScraper] Olaplex lookup: "${productName}"`);
    
    for (const [key, imageUrl] of Object.entries(OLAPLEX_PRODUCTS)) {
      if (lowerName.includes(key)) {
        console.log(`[BrandImageScraper] Found Olaplex match for "${key}"`);
        return {
          imageUrl,
          productName: productName,
          brand: 'Olaplex',
          source: 'olaplex'
        };
      }
    }
    
    // Default Olaplex No.3 image (most popular)
    console.log(`[BrandImageScraper] Using default Olaplex image for "${productName}"`);
    return {
      imageUrl: 'https://olaplex.com/cdn/shop/products/No.3_PDP_1_2000x.jpg?v=1681761516',
      productName: productName,
      brand: 'Olaplex',
      source: 'olaplex'
    };
  } catch (error) {
    console.error('[BrandImageScraper] Olaplex search error:', error);
    return null;
  }
}

// K18 - Biomimetic hairscience
const K18_PRODUCTS: Record<string, string> = {
  'leave-in': 'https://k18hair.com/cdn/shop/products/K18-Leave-In-50ml_2000x.jpg?v=1632766543',
  'molecular repair mask': 'https://k18hair.com/cdn/shop/products/K18-Leave-In-50ml_2000x.jpg?v=1632766543',
  'molecular repair hair mask': 'https://k18hair.com/cdn/shop/products/K18-Leave-In-50ml_2000x.jpg?v=1632766543',
  'peptide prep': 'https://k18hair.com/cdn/shop/products/K18-Peptide-Prep-Shampoo_2000x.jpg?v=1675788543',
  'detox shampoo': 'https://k18hair.com/cdn/shop/products/K18-Peptide-Prep-Shampoo_2000x.jpg?v=1675788543',
  'damage shield': 'https://k18hair.com/cdn/shop/products/K18-Damage-Shield-Shampoo_2000x.jpg?v=1695827654',
  'shield shampoo': 'https://k18hair.com/cdn/shop/products/K18-Damage-Shield-Shampoo_2000x.jpg?v=1695827654',
  'shield conditioner': 'https://k18hair.com/cdn/shop/products/K18-Damage-Shield-Conditioner_2000x.jpg?v=1695827654',
  'molecular repair oil': 'https://k18hair.com/cdn/shop/products/K18-Molecular-Repair-Oil_2000x.jpg?v=1690489876',
  'hair oil': 'https://k18hair.com/cdn/shop/products/K18-Molecular-Repair-Oil_2000x.jpg?v=1690489876',
  'airwash': 'https://k18hair.com/cdn/shop/products/K18-Airwash-Dry-Shampoo_2000x.jpg?v=1705324567',
  'dry shampoo': 'https://k18hair.com/cdn/shop/products/K18-Airwash-Dry-Shampoo_2000x.jpg?v=1705324567',
  'heatbounce': 'https://k18hair.com/cdn/shop/products/K18-Heatbounce-Heat-Protectant_2000x.jpg?v=1700123456',
  'heat protectant': 'https://k18hair.com/cdn/shop/products/K18-Heatbounce-Heat-Protectant_2000x.jpg?v=1700123456',
  'astrolift': 'https://k18hair.com/cdn/shop/products/K18-Astrolift-Volume-Spray_2000x.jpg?v=1705456789',
  'volume spray': 'https://k18hair.com/cdn/shop/products/K18-Astrolift-Volume-Spray_2000x.jpg?v=1705456789',
  'client mask': 'https://k18hair.com/cdn/shop/products/K18-Leave-In-50ml_2000x.jpg?v=1632766543',
  'mask pack': 'https://k18hair.com/cdn/shop/products/K18-Leave-In-50ml_2000x.jpg?v=1632766543',
};

async function searchK18(productName: string): Promise<BrandImageResult | null> {
  try {
    const lowerName = productName.toLowerCase();
    console.log(`[BrandImageScraper] K18 lookup: "${productName}"`);
    
    for (const [key, imageUrl] of Object.entries(K18_PRODUCTS)) {
      if (lowerName.includes(key)) {
        console.log(`[BrandImageScraper] Found K18 match for "${key}"`);
        return {
          imageUrl,
          productName: productName,
          brand: 'K18',
          source: 'k18'
        };
      }
    }
    
    // Default K18 molecular repair mask image
    console.log(`[BrandImageScraper] Using default K18 image for "${productName}"`);
    return {
      imageUrl: 'https://k18hair.com/cdn/shop/products/K18-Leave-In-50ml_2000x.jpg?v=1632766543',
      productName: productName,
      brand: 'K18',
      source: 'k18'
    };
  } catch (error) {
    console.error('[BrandImageScraper] K18 search error:', error);
    return null;
  }
}

// PUREOLOGY - Vegan, color-safe professional hair care
const PUREOLOGY_PRODUCTS: Record<string, string> = {
  'hydrate shampoo': 'https://www.pureology.com/media/catalog/product/h/y/hydrate-shampoo.jpg',
  'hydrate conditioner': 'https://www.pureology.com/media/catalog/product/h/y/hydrate-conditioner.jpg',
  'hydrate sheer shampoo': 'https://www.pureology.com/media/catalog/product/h/y/hydrate-sheer-shampoo.jpg',
  'hydrate sheer conditioner': 'https://www.pureology.com/media/catalog/product/h/y/hydrate-sheer-conditioner.jpg',
  'strength cure shampoo': 'https://www.pureology.com/media/catalog/product/s/t/strength-cure-shampoo.jpg',
  'strength cure conditioner': 'https://www.pureology.com/media/catalog/product/s/t/strength-cure-conditioner.jpg',
  'strength cure blonde shampoo': 'https://www.pureology.com/media/catalog/product/s/t/strength-cure-blonde-shampoo.jpg',
  'strength cure blonde conditioner': 'https://www.pureology.com/media/catalog/product/s/t/strength-cure-blonde-conditioner.jpg',
  'color fanatic': 'https://www.pureology.com/media/catalog/product/c/o/color-fanatic-spray.jpg',
  'colour fanatic': 'https://www.pureology.com/media/catalog/product/c/o/color-fanatic-spray.jpg',
  'superfood': 'https://www.pureology.com/media/catalog/product/s/u/superfood-treatment-mask.jpg',
  'deep treatment': 'https://www.pureology.com/media/catalog/product/s/u/superfood-treatment-mask.jpg',
  'smooth perfection': 'https://www.pureology.com/media/catalog/product/s/m/smooth-perfection-shampoo.jpg',
  'style + protect': 'https://www.pureology.com/media/catalog/product/s/t/style-protect-hairspray.jpg',
  'soft finish hairspray': 'https://www.pureology.com/media/catalog/product/s/o/soft-finish-hairspray.jpg',
  'lock it down': 'https://www.pureology.com/media/catalog/product/l/o/lock-it-down-hairspray.jpg',
  'on the rise': 'https://www.pureology.com/media/catalog/product/o/n/on-the-rise-mousse.jpg',
  'root lifting mousse': 'https://www.pureology.com/media/catalog/product/o/n/on-the-rise-mousse.jpg',
  'volumizing mousse': 'https://www.pureology.com/media/catalog/product/w/e/weightless-volume-mousse.jpg',
  'weightless volume': 'https://www.pureology.com/media/catalog/product/w/e/weightless-volume-mousse.jpg',
  'texture finishing': 'https://www.pureology.com/media/catalog/product/t/e/texture-finishing-spray.jpg',
  'wind tossed': 'https://www.pureology.com/media/catalog/product/w/i/wind-tossed-texture-spray.jpg',
  'refresh & go': 'https://www.pureology.com/media/catalog/product/r/e/refresh-go-dry-shampoo.jpg',
  'dry shampoo': 'https://www.pureology.com/media/catalog/product/r/e/refresh-go-dry-shampoo.jpg',
};

async function searchPureology(productName: string): Promise<BrandImageResult | null> {
  try {
    const lowerName = productName.toLowerCase();
    console.log(`[BrandImageScraper] Pureology lookup: "${productName}"`);
    
    for (const [key, imageUrl] of Object.entries(PUREOLOGY_PRODUCTS)) {
      if (lowerName.includes(key)) {
        console.log(`[BrandImageScraper] Found Pureology match for "${key}"`);
        return {
          imageUrl,
          productName: productName,
          brand: 'Pureology',
          source: 'pureology'
        };
      }
    }
    
    // Default Pureology hydrate image
    console.log(`[BrandImageScraper] Using default Pureology image for "${productName}"`);
    return {
      imageUrl: 'https://www.pureology.com/media/catalog/product/h/y/hydrate-shampoo.jpg',
      productName: productName,
      brand: 'Pureology',
      source: 'pureology'
    };
  } catch (error) {
    console.error('[BrandImageScraper] Pureology search error:', error);
    return null;
  }
}

// JOICO - Professional hair care and color
const JOICO_PRODUCTS: Record<string, string> = {
  'lumishine': 'https://www.joico.com/media/catalog/product/l/u/lumishine-dd-color.jpg',
  'color butter': 'https://www.joico.com/media/catalog/product/c/o/color-butter.jpg',
  'blonde life': 'https://www.joico.com/media/catalog/product/b/l/blonde-life-shampoo.jpg',
  'k-pak': 'https://www.joico.com/media/catalog/product/k/-/k-pak-shampoo.jpg',
  'moisture recovery': 'https://www.joico.com/media/catalog/product/m/o/moisture-recovery-shampoo.jpg',
  'defy damage': 'https://www.joico.com/media/catalog/product/d/e/defy-damage-shampoo.jpg',
  'joifull': 'https://www.joico.com/media/catalog/product/j/o/joifull-shampoo.jpg',
  'power spray': 'https://www.joico.com/media/catalog/product/p/o/power-spray-hairspray.jpg',
  'flip turn': 'https://www.joico.com/media/catalog/product/f/l/flip-turn-volumizer.jpg',
  'hair shake': 'https://www.joico.com/media/catalog/product/h/a/hair-shake-texturizer.jpg',
  'dream blowout': 'https://www.joico.com/media/catalog/product/d/r/dream-blowout-cream.jpg',
  'accelerator': 'https://www.joico.com/media/catalog/product/a/c/accelerator.jpg',
  'vero': 'https://www.joico.com/media/catalog/product/v/e/vero-color.jpg',
  'lumi 10 min': 'https://www.joico.com/media/catalog/product/l/u/lumishine-10-minute.jpg',
  '10 min': 'https://www.joico.com/media/catalog/product/l/u/lumishine-10-minute.jpg',
};

async function searchJoico(productName: string): Promise<BrandImageResult | null> {
  try {
    const lowerName = productName.toLowerCase();
    console.log(`[BrandImageScraper] Joico lookup: "${productName}"`);
    
    for (const [key, imageUrl] of Object.entries(JOICO_PRODUCTS)) {
      if (lowerName.includes(key)) {
        console.log(`[BrandImageScraper] Found Joico match for "${key}"`);
        return {
          imageUrl,
          productName: productName,
          brand: 'Joico',
          source: 'joico'
        };
      }
    }
    
    // Default Joico K-PAK image
    console.log(`[BrandImageScraper] Using default Joico image for "${productName}"`);
    return {
      imageUrl: 'https://www.joico.com/media/catalog/product/k/-/k-pak-shampoo.jpg',
      productName: productName,
      brand: 'Joico',
      source: 'joico'
    };
  } catch (error) {
    console.error('[BrandImageScraper] Joico search error:', error);
    return null;
  }
}

async function searchLoreal(productName: string): Promise<BrandImageResult | null> {
  try {
    const searchQuery = normalizeProductName(productName);
    const lowerName = productName.toLowerCase();
    
    // Check for Tecni.Art products first
    if (lowerName.includes('tecni') || lowerName.includes('bouncy') || 
        lowerName.includes('pli') || lowerName.includes('volume mousse')) {
      return await searchTecniArt(productName);
    }
    
    const lorealProducts: Record<string, string> = {
      'metal detox': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/care/metal-detox/product-hero.png',
      'serie expert': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/care/serie-expert.png',
      'absolut repair': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/care/absolut-repair/absolut-repair-hero.png',
      'vitamino color': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/care/vitamino-color/vitamino-color-hero.png',
      'tecni art': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art-hero.png',
      'dia color': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/color/dia-richesse.png',
      'dia colour': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/color/dia-richesse.png',
      'dia richesse': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/color/dia-richesse.png',
      'inoa': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/color/inoa.png',
      'majirel': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/color/majirel.png',
      'blondifier': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/care/blondifier.png',
      'homme': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/homme/homme-range.png',
      'force sculpte': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/homme/homme-force-sculpte.png',
      'steam pod': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/tools/steampod-3.png',
      'steampod': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/tools/steampod-3.png',
      'efassor': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/color/efassor.png',
      'majimeches': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/color/majimeches.png',
      'infinium': 'https://www.lorealprofessionnel.com/-/media/project/loreal/brand-sites/lorealprofessionnel/emea/products/styling/tecni-art/infinium.png',
    };
    
    for (const [key, imageUrl] of Object.entries(lorealProducts)) {
      if (searchQuery.includes(key)) {
        console.log(`[BrandImageScraper] Found L'Oreal match for "${key}"`);
        return {
          imageUrl,
          productName: productName,
          brand: "L'Oreal Professional",
          source: 'loreal'
        };
      }
    }
    
    console.log(`[BrandImageScraper] No L'Oreal match for "${searchQuery}"`);
    return null;
  } catch (error) {
    console.error('[BrandImageScraper] L\'Oreal search error:', error);
    return null;
  }
}

export async function searchBrandImage(productName: string, brandName?: string): Promise<BrandImageResult> {
  const cacheKey = `${brandName || ''}_${productName}`.toLowerCase();
  
  const cached = imageCache.get(cacheKey);
  if (cached) {
    console.log(`[BrandImageScraper] Cache hit for "${productName}"`);
    return cached;
  }
  
  // Check if product is an accessory first - use Kozeta logo
  if (isAccessory(productName)) {
    const result = getKozetaAccessoryImage(productName);
    imageCache.set(cacheKey, result);
    return result;
  }
  
  const brand = extractBrand(brandName || productName);
  let result: BrandImageResult | null = null;
  
  switch (brand) {
    case 'dermalogica':
      result = await searchDermalogica(productName);
      break;
    case 'goldwell':
      result = await searchGoldwell(productName);
      break;
    case 'wella':
      result = await searchWella(productName);
      break;
    case 'redken':
      result = await searchRedken(productName);
      break;
    case 'colorwow':
      result = await searchColorWow(productName);
      break;
    case 'kerastase':
      result = await searchKerastase(productName);
      break;
    case 'oribe':
      result = await searchOribe(productName);
      break;
    case 'olaplex':
      result = await searchOlaplex(productName);
      break;
    case 'k18':
      result = await searchK18(productName);
      break;
    case 'pureology':
      result = await searchPureology(productName);
      break;
    case 'joico':
      result = await searchJoico(productName);
      break;
    case 'inoa':
      result = await searchInoa(productName);
      break;
    case 'loreal':
      result = await searchLoreal(productName);
      break;
    case 'accessory':
      // Tool brands like BabyBliss, Avanti, Dannyco - use Kozeta logo
      result = getKozetaAccessoryImage(productName);
      break;
    case 'misc':
      // Check if it's an accessory-type product
      if (isAccessory(productName)) {
        result = getKozetaAccessoryImage(productName);
      } else {
        console.log(`[BrandImageScraper] Misc item without accessory keywords: "${productName}"`);
        result = null;
      }
      break;
    default:
      // Try Dermalogica first (most products), then fall back to Kerastase and L'Oreal
      result = await searchDermalogica(productName);
      if (!result) {
        result = await searchKerastase(productName);
      }
      if (!result) {
        result = await searchLoreal(productName);
      }
  }
  
  if (!result) {
    result = {
      imageUrl: null,
      brand: brandName || 'Unknown',
      source: 'none'
    };
  }
  
  imageCache.set(cacheKey, result);
  return result;
}

export async function searchBrandImages(products: Array<{name: string; brandName?: string}>): Promise<Map<string, BrandImageResult>> {
  const results = new Map<string, BrandImageResult>();
  
  const chunks: Array<Array<{name: string; brandName?: string}>> = [];
  for (let i = 0; i < products.length; i += 3) {
    chunks.push(products.slice(i, i + 3));
  }
  
  for (const chunk of chunks) {
    const promises = chunk.map(async (product) => {
      const result = await searchBrandImage(product.name, product.brandName);
      return { key: `${product.brandName || ''}_${product.name}`.toLowerCase(), result };
    });
    
    const chunkResults = await Promise.all(promises);
    for (const { key, result } of chunkResults) {
      results.set(key, result);
    }
  }
  
  return results;
}

export function clearBrandImageCache(): void {
  imageCache.clear();
  console.log('[BrandImageScraper] Cache cleared');
}

export function getBrandImageCacheStats(): { 
  size: number; 
  hits: Record<string, number>;
} {
  const hits: Record<string, number> = {
    dermalogica: 0,
    goldwell: 0,
    wella: 0,
    loreal: 0,
    kerastase: 0,
    colorwow: 0,
    kozeta: 0,
    oribe: 0,
    olaplex: 0,
    k18: 0,
    pureology: 0,
    joico: 0,
    generic: 0,
    none: 0
  };
  
  imageCache.forEach(result => {
    hits[result.source] = (hits[result.source] || 0) + 1;
  });
  
  return {
    size: imageCache.size,
    hits
  };
}

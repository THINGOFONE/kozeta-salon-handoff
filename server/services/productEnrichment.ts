import OpenAI from "openai";
import { searchBrandImage } from "./brandImageScraper";

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY
});

interface ProductData {
  productId: string;
  name: string;
  brandName?: string;
  categoryName?: string;
  price?: number;
  imageUrl?: string;
  barcode?: string;
}

interface EnrichedProductData {
  imageUrl: string | null;
  description: string;
  isHdImage: boolean;
  isProfessionalImage: boolean;
  imageSource: string;
  tags: string[];
  category: string;
}

// Product categorization - maps products to categories based on keywords
const PRODUCT_CATEGORIES: Record<string, { keywords: string[]; priority: number }> = {
  'shampoo': {
    keywords: ['shampoo', 'bain', 'cleanser', 'wash', 'cleansing'],
    priority: 1
  },
  'conditioner': {
    keywords: ['conditioner', 'fondant', 'rinse', 'detangler'],
    priority: 2
  },
  'mask': {
    keywords: ['mask', 'masque', 'masquintense', 'treatment mask', 'deep treatment'],
    priority: 3
  },
  'treatment': {
    keywords: ['treatment', 'serum', 'oil', 'elixir', 'repair', 'bond', 'molecular', 'therapy', 'booster'],
    priority: 4
  },
  'styling': {
    keywords: ['spray', 'mousse', 'gel', 'wax', 'paste', 'cream', 'pomade', 'hairspray', 'texture', 'volume', 'hold', 'finishing', 'styling', 'blowout', 'heat protect', 'dry shampoo'],
    priority: 5
  },
  'color': {
    keywords: ['color', 'colour', 'dye', 'toner', 'gloss', 'lightener', 'bleach', 'developer', 'oxidant', 'peroxide', 'ammonia', 'majirel', 'inoa', 'dia', 'topchic', 'colorance', 'lumishine', 'shades eq'],
    priority: 6
  },
  'scalp': {
    keywords: ['scalp', 'anti-dandruff', 'purifying', 'balancing', 'soothing', 'densifique', 'genesis', 'hair fall', 'hair loss', 'thinning'],
    priority: 7
  },
  'skincare': {
    keywords: ['skin', 'face', 'cleanser face', 'moisturizer', 'serum face', 'eye', 'lip', 'sunscreen', 'spf', 'anti-aging', 'wrinkle'],
    priority: 8
  },
  'tools': {
    keywords: ['brush', 'comb', 'dryer', 'iron', 'straightener', 'curler', 'roller', 'clip', 'pin', 'cape', 'towel', 'foil', 'bowl'],
    priority: 9
  }
};

// Tags for additional product attributes
const PRODUCT_TAGS: Record<string, string[]> = {
  'moisturizing': ['hydrate', 'moisture', 'nourish', 'nutritive', 'hydra', 'lait', 'rich'],
  'volumizing': ['volume', 'volumizing', 'thickening', 'body', 'lift', 'fullness', 'joifull'],
  'smoothing': ['smooth', 'frizz', 'anti-frizz', 'discipline', 'fluidealiste', 'sleek'],
  'strengthening': ['strength', 'repair', 'reconstruct', 'fortifying', 'resistance', 'bond', 'k18', 'olaplex'],
  'color-safe': ['color protect', 'colour protect', 'color safe', 'for color', 'vitamino', 'color fanatic'],
  'blonde': ['blonde', 'blond', 'purple', 'silver', 'platinum', 'brass', 'toning', 'bright blonde', 'silverati'],
  'curly': ['curl', 'curly', 'wave', 'coil', 'curl manifesto'],
  'fine-hair': ['fine', 'thin', 'lightweight', 'sheer', 'volumizing'],
  'thick-hair': ['thick', 'coarse', 'dense', 'heavy'],
  'dry-hair': ['dry', 'dehydrated', 'parched', 'thirsty'],
  'damaged': ['damaged', 'repair', 'restore', 'reconstruct', 'broken', 'brittle'],
  'oily': ['oily', 'greasy', 'oil control', 'clarifying', 'purifying'],
  'sensitive': ['sensitive', 'gentle', 'calming', 'soothing', 'hypoallergenic'],
  'professional': ['professional', 'salon', 'pro', 'backbar'],
  'travel-size': ['travel', 'mini', 'trial', 'sample'],
  'luxury': ['luxury', 'premium', 'oribe', 'prestige', 'gold']
};

function categorizeProduct(productName: string, brandName?: string, categoryName?: string): { category: string; tags: string[] } {
  const lowerName = productName.toLowerCase();
  const lowerBrand = (brandName || '').toLowerCase();
  const lowerCategory = (categoryName || '').toLowerCase();
  const combined = `${lowerName} ${lowerBrand} ${lowerCategory}`;
  
  // Determine category
  let matchedCategory = 'other';
  let highestPriority = Infinity;
  
  for (const [category, config] of Object.entries(PRODUCT_CATEGORIES)) {
    for (const keyword of config.keywords) {
      if (combined.includes(keyword)) {
        if (config.priority < highestPriority) {
          matchedCategory = category;
          highestPriority = config.priority;
        }
        break;
      }
    }
  }
  
  // Collect tags
  const tags: string[] = [];
  for (const [tag, keywords] of Object.entries(PRODUCT_TAGS)) {
    for (const keyword of keywords) {
      if (combined.includes(keyword)) {
        tags.push(tag);
        break;
      }
    }
  }
  
  // Add brand as tag
  if (lowerBrand && !tags.includes(lowerBrand)) {
    const brandTag = lowerBrand.replace(/[^a-z0-9]/g, '-');
    if (brandTag.length > 2) {
      tags.push(brandTag);
    }
  }
  
  return { category: matchedCategory, tags };
}

const productCache = new Map<string, EnrichedProductData>();

async function generateProductDescription(product: ProductData): Promise<string> {
  try {
    const prompt = `Generate a professional, concise product description (2-3 sentences max) for a salon/beauty product:

Product Name: ${product.name}
Brand: ${product.brandName || 'Professional Salon'}
Category: ${product.categoryName || 'Hair Care'}
Price: ${product.price ? `$${product.price}` : 'Professional pricing'}

Write a compelling description that highlights the product's key benefits and professional quality. Do not use any markdown formatting. Do not start with the product name.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      temperature: 0.7,
    });

    const description = response.choices[0]?.message?.content?.trim();
    if (description) {
      return description;
    }
  } catch (error) {
    console.error('[ProductEnrichment] OpenAI description generation failed:', error);
  }
  
  return generateFallbackDescription(product);
}

function generateFallbackDescription(product: ProductData): string {
  const brand = product.brandName || 'Professional';
  const category = product.categoryName?.toLowerCase() || 'hair care';
  
  const categoryDescriptions: Record<string, string> = {
    'colour': `Professional-grade ${brand} color formula delivering vibrant, long-lasting results with superior gray coverage and brilliant shine.`,
    'hair care': `Premium ${brand} ${category} product formulated with salon-quality ingredients to nourish, strengthen, and protect your hair.`,
    'skin care': `Luxurious ${brand} skincare treatment designed to rejuvenate and revitalize, leaving skin radiant and youthful.`,
    'styling': `Versatile ${brand} styling product providing flexible hold and beautiful finish for any hairstyle.`,
    'accessories': `High-quality salon accessory from ${brand}, designed for professional results and everyday use.`,
    'tools': `Professional ${brand} tool engineered for precision styling and optimal performance in the salon.`,
    'treatment': `Intensive ${brand} treatment formula that deeply conditions and repairs for healthier, more beautiful hair.`,
    'shampoo': `Gentle yet effective ${brand} shampoo that cleanses while nourishing hair from root to tip.`,
    'conditioner': `Rich ${brand} conditioner that detangles, softens, and adds brilliant shine to all hair types.`,
  };
  
  return categoryDescriptions[category] || `Premium ${brand} ${category} product crafted for professional salon results.`;
}

export async function enrichProduct(product: ProductData, useAiDescriptions: boolean = true): Promise<EnrichedProductData> {
  const cached = productCache.get(product.productId);
  
  if (cached) {
    if (!useAiDescriptions || cached.description.length > 100) {
      return cached;
    }
  }
  
  let imageUrl: string | null = null;
  let isProfessionalImage = false;
  let imageSource = 'none';
  
  // Priority 1: Phorest image (if available)
  if (product.imageUrl && product.imageUrl.length > 10) {
    imageUrl = product.imageUrl;
    isProfessionalImage = true;
    imageSource = 'phorest';
    console.log(`[ProductEnrichment] Using Phorest image for "${product.name}"`);
  } 
  // Priority 2: Brand website image (official product photos)
  else {
    const brandResult = await searchBrandImage(product.name, product.brandName);
    if (brandResult.imageUrl) {
      imageUrl = brandResult.imageUrl;
      isProfessionalImage = true;
      imageSource = brandResult.source;
      console.log(`[ProductEnrichment] Found brand image for "${product.name}" from ${brandResult.source}`);
    } else {
      // No professional image found - use Kozeta logo
      imageUrl = '/kozeta-product-logo.svg';
      imageSource = 'placeholder';
      console.log(`[ProductEnrichment] No professional image for "${product.name}", using Kozeta logo`);
    }
  }
  
  let description: string;
  if (useAiDescriptions) {
    description = await generateProductDescription(product);
  } else {
    description = generateFallbackDescription(product);
  }
  
  // Categorize product and get tags
  const { category, tags } = categorizeProduct(product.name, product.brandName, product.categoryName);
  
  const enriched: EnrichedProductData = {
    imageUrl,
    description,
    isHdImage: isProfessionalImage,
    isProfessionalImage,
    imageSource,
    tags,
    category,
  };
  
  productCache.set(product.productId, enriched);
  
  return enriched;
}

export async function enrichProducts(products: ProductData[], useAiDescriptions: boolean = true): Promise<Map<string, EnrichedProductData>> {
  const results = new Map<string, EnrichedProductData>();
  
  for (const product of products) {
    const cached = productCache.get(product.productId);
    if (cached) {
      results.set(product.productId, cached);
    }
  }
  
  const uncached = products.filter(p => !productCache.has(p.productId));
  
  if (uncached.length === 0) {
    return results;
  }
  
  console.log(`[ProductEnrichment] Enriching ${uncached.length} new products (AI: ${useAiDescriptions})...`);
  
  const shouldUseAi = useAiDescriptions && uncached.length <= 3;
  
  // Process in smaller batches to avoid rate limiting
  const batchSize = 5;
  for (let i = 0; i < uncached.length; i += batchSize) {
    const batch = uncached.slice(i, i + batchSize);
    await Promise.all(batch.map(async (product) => {
      const enriched = await enrichProduct(product, shouldUseAi);
      results.set(product.productId, enriched);
    }));
  }
  
  return results;
}

export function clearProductCache(): void {
  productCache.clear();
  console.log('[ProductEnrichment] Cache cleared');
}

export function getCacheStats(): { 
  size: number; 
  professionalImages: number;
  placeholderImages: number;
  sources: Record<string, number>;
} {
  let professionalImages = 0;
  let placeholderImages = 0;
  const sources: Record<string, number> = {};
  
  productCache.forEach(data => {
    if (data.isProfessionalImage) {
      professionalImages++;
    } else {
      placeholderImages++;
    }
    sources[data.imageSource] = (sources[data.imageSource] || 0) + 1;
  });
  
  return {
    size: productCache.size,
    professionalImages,
    placeholderImages,
    sources,
  };
}

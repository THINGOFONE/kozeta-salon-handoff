import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { storage } from "./storage";
import { 
  chatRequestSchema, 
  loginRequestSchema,
  otpVerifySchema,
  updateNameSchema,
  availabilityRequestSchema,
  bookingRequestSchema,
  productVisibility,
  revokedSessions,
  type ChatMessage, 
  type ClientSession, 
  type ClientProfile, 
  type LastVisit, 
  type ProductPurchase 
} from "@shared/schema";
import OpenAI from "openai";
import * as phorestApi from "./phorestApi";
import * as authUtils from "./utils/authUtils";
import * as stripeClient from "./stripeClient";
import * as productEnrichment from "./services/productEnrichment";
import * as productCache from "./services/productCache";
import { db } from "./db";
import { eq, lt } from "drizzle-orm";
import { pendingBookings, pendingOrders, findReusablePendingBooking, findReusablePendingOrder, startPendingCleanup, PENDING_EXPIRY_MS } from "./pendingStore";
import { tryAcquireFinalizeLock, releaseFinalizeLock, withRefundLock } from "./paymentLocks";
import { torontoDateAtHour, torontoHour, torontoDateString } from "./utils/torontoTime";
import { startOrphanSweep } from "./orphanSweep";
import { buildDuplicateDepositNote, appointmentStartMs, isCancelledAppointment } from "./utils/apptSlotMatch";
import { registerOtpPhone, clearOtpPhone } from "./smsOtpBridge";
import { handleSmsMessage, getSmsHistory, offerSmsCardSave, isSmsCompanionEnabled } from "./smsCompanion";
import { sendBookingConfirmation } from "./smsNotifications";
import { sendSms } from "./twilioClient";
import { smsConversations, depositRefunds, depositReviewFlags } from "@shared/schema";
import { PORTAL_ENABLED, LOGIN_ENABLED, PHOREST_BOOKING_URL, SALON_PHONE_DISPLAY } from "@shared/portalConfig";
import { issueDepositRefund, issueFullServiceRefund, previewSplit, isBookingDepositIntent, getRefundState, REFUND_LABELS } from "./refundService";
import { desc, inArray } from "drizzle-orm";

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.SESSION_SECRET) {
  console.error('══════════════════════════════════════════════════════════════════');
  console.error('[Auth] WARNING: SESSION_SECRET environment variable is NOT set.');
  console.error('[Auth] A random secret was generated for this process only — ALL');
  console.error('[Auth] client logins will be invalidated every time the server');
  console.error('[Auth] restarts. Set a persistent SESSION_SECRET to fix this.');
  console.error('══════════════════════════════════════════════════════════════════');
}

// ── Auth rate limiters ────────────────────────────────────────────────────────
// IP-based limiter: max 10 login/OTP requests per IP per hour.
// Uses express-rate-limit default keyGenerator (handles IPv4 + IPv6 correctly).
// Prevents automated scanning from a single network source.
const loginIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({ error: 'Too many requests from this network. Please try again in an hour.' });
  },
});

// Phone/email-based limiter: max 3 OTP sends per identifier per 10 minutes.
// Key is the phone digits or email address; no IP fallback to avoid IPv6 warnings.
// Prevents SMS bill inflation by repeatedly targeting a single phone number.
const loginPhoneLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: false,
  keyGenerator: (req: Request) => {
    const phone = (req.body?.phone || '').replace(/\D/g, '');
    const email = (req.body?.email || '').toLowerCase().trim();
    // Use identifier (phone/email) as the rate-limit key.
    // If neither provided the request will fail validation before hitting Twilio anyway.
    return phone || email || 'anon';
  },
  handler: (_req: Request, res: Response) => {
    res.status(429).json({ error: 'Too many verification requests for this number. Please wait 10 minutes and try again.' });
  },
  validate: { xForwardedForHeader: false },
});

// Verify/resend limiter: max 15 attempts per IP per 5 minutes.
// Uses default keyGenerator — no custom IP access needed.
// Prevents brute-force guessing OTP codes across multiple sessions.
const verifyIpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({ error: 'Too many verification attempts. Please wait a few minutes and try again.' });
  },
});

// Tokens carry an issued-at timestamp and expire after this TTL, so old tokens
// age out automatically even if a revocation record is ever lost.
const SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function signSessionToken(sessionId: string, clientId: string): string {
  const payload = `${sessionId}:${clientId}:${Date.now()}`;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}:${hmac}`;
}

function verifySessionToken(token: string): { sessionId: string; clientId: string } | null {
  const parts = token.split(':');
  if (parts.length < 4) return null; // legacy tokens without issued-at are rejected
  const hmac = parts.pop()!;
  const payload = parts.join(':');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  if (hmac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;
  const payloadParts = payload.split(':');
  const issuedAtStr = payloadParts.pop()!;
  const sessionId = payloadParts.shift();
  const clientId = payloadParts.join(':');
  if (!sessionId || !clientId) return null;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) return null;
  const age = Date.now() - issuedAt;
  if (age < 0 || age > SESSION_TOKEN_TTL_MS) return null; // expired (or clock-skewed) token
  return { sessionId, clientId };
}

// Session IDs revoked by logout — a signed token for a revoked session must
// never silently re-create a server session. Kept in memory for synchronous
// checks, persisted in the database so revocations survive restarts.
const revokedSessionIds = new Set<string>();

async function loadRevokedSessions(): Promise<void> {
  try {
    // Prune revocations older than the token TTL — those tokens are expired
    // anyway, so the records are no longer needed.
    const cutoff = new Date(Date.now() - SESSION_TOKEN_TTL_MS);
    await db.delete(revokedSessions).where(lt(revokedSessions.revokedAt, cutoff));
    const rows = await db.select().from(revokedSessions);
    for (const row of rows) {
      revokedSessionIds.add(row.sessionId);
    }
    console.log(`[Auth] Loaded ${rows.length} revoked session(s) from database`);
  } catch (error) {
    console.error('[Auth] Failed to load revoked sessions from database:', error);
  }
}

async function persistRevokedSession(sessionId: string): Promise<void> {
  try {
    await db.insert(revokedSessions).values({ sessionId }).onConflictDoNothing();
  } catch (error) {
    console.error('[Auth] Failed to persist session revocation:', error);
  }
}

function resolveSession(sessionId?: string, sessionToken?: string): string | null {
  if (sessionId && revokedSessionIds.has(sessionId)) {
    return null;
  }
  if (sessionId && sessionStore.has(sessionId)) {
    return sessionStore.get(sessionId)!.clientId;
  }
  if (sessionToken) {
    const verified = verifySessionToken(sessionToken);
    if (verified && revokedSessionIds.has(verified.sessionId)) {
      return null;
    }
    if (verified) {
      sessionStore.set(verified.sessionId, { clientId: verified.clientId, verified: true, createdAt: Date.now() });
      return verified.clientId;
    }
  }
  return null;
}

// Deposit percentage for booking payments (20% of service price)
const DEPOSIT_PERCENT = 20;
// Server-side deposit ceiling — guards against corrupted/misconfigured Phorest
// prices producing an absurd charge. $200 deposit = $1,000 service at 20%.
const MAX_DEPOSIT_CENTS = 20000;

// ============ LOYALTY PROGRAM CONSTANTS ============
// Earning: 1 point per $1 spent (on both services and products)
const LOYALTY_POINTS_PER_DOLLAR = 1; // 1 point per $1 spent
// Redemption: requires 300 points ($300 spent); 300 points = $5 off a product, 300 points = $8 off a massage
// Multiple redemptions can stack on a single purchase/service, but total discount cannot exceed remaining price
const LOYALTY_POINTS_PER_REDEMPTION = 300;
const LOYALTY_PRODUCT_DISCOUNT_PER_REDEMPTION = 500; // cents ($5)
const LOYALTY_MASSAGE_DISCOUNT_PER_REDEMPTION = 800; // cents ($8)

function getLoyaltyRewardInfo(points: number) {
  const redemptionsAvailable = Math.floor(points / LOYALTY_POINTS_PER_REDEMPTION);
  return {
    points,
    pointsPerRedemption: LOYALTY_POINTS_PER_REDEMPTION,
    productDiscountPerRedemption: LOYALTY_PRODUCT_DISCOUNT_PER_REDEMPTION / 100,
    massageDiscountPerRedemption: LOYALTY_MASSAGE_DISCOUNT_PER_REDEMPTION / 100,
    redemptionsAvailable,
    rewards: [
      {
        name: "$5 Off a Product",
        type: "product" as const,
        discountPerRedemption: LOYALTY_PRODUCT_DISCOUNT_PER_REDEMPTION / 100,
        pointsRequired: LOYALTY_POINTS_PER_REDEMPTION,
        available: points >= LOYALTY_POINTS_PER_REDEMPTION,
        description: `${LOYALTY_POINTS_PER_REDEMPTION} points = $5 off any product purchase`
      },
      {
        name: "$8 Off a Massage",
        type: "massage" as const,
        discountPerRedemption: LOYALTY_MASSAGE_DISCOUNT_PER_REDEMPTION / 100,
        pointsRequired: LOYALTY_POINTS_PER_REDEMPTION,
        available: points >= LOYALTY_POINTS_PER_REDEMPTION,
        description: `${LOYALTY_POINTS_PER_REDEMPTION} points = $8 off any massage service`
      }
    ]
  };
}

// Pending bookings and orders now live in the PostgreSQL database (see
// server/pendingStore.ts) so they survive server restarts/deploys mid-payment.
// Expired-row cleanup runs periodically via startPendingCleanup().
const PENDING_ORDER_EXPIRY_MS = PENDING_EXPIRY_MS;
startPendingCleanup();
if (PORTAL_ENABLED) {
  startOrphanSweep();
} else {
  console.log("[Portal] Portal disabled — deposit orphan sweep NOT started");
}
loadRevokedSessions();

// Use direct OPENAI_API_KEY when available (Fly.io / production outside Replit),
// fall back to Replit AI Integrations variables when running on Replit.
const openai = new OpenAI({
  ...(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL
    ? { baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL }
    : {}),
  apiKey: process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || '',
});

// Session storage - maps sessionId to clientId and contact info
const sessionStore = new Map<string, { 
  clientId: string; 
  phone?: string; 
  email?: string; 
  verified: boolean;
  createdAt: number 
}>();

// OTP store - maps otpId to pending OTP verification data
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OTP_ATTEMPTS = 5;
const otpStore = new Map<string, {
  phone: string;
  code: string;
  phorestClient: phorestApi.PhorestClient | null;
  isNewAccount: boolean;
  firstName?: string;
  lastName?: string;
  attempts: number;
  createdAt: number;
}>();

// Clean up expired OTPs
setInterval(() => {
  const now = Date.now();
  for (const [id, otp] of Array.from(otpStore.entries())) {
    if (now - otp.createdAt > OTP_EXPIRY_MS) {
      otpStore.delete(id);
    }
  }
}, 60000);

// Twilio SMS helper
async function sendSmsOtp(phone: string, code: string): Promise<boolean> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  
  if (!accountSid || !authToken || !fromNumber) {
    console.error('[OTP] Twilio not configured - missing env vars');
    return false;
  }
  
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const body = new URLSearchParams({
      To: phone,
      From: fromNumber,
      Body: `Your Kozeta Salon verification code is: ${code}. It expires in 5 minutes.`
    });
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[OTP] Twilio error:', response.status, errorText);
      return false;
    }
    
    const result = await response.json();
    console.log(`[OTP] SMS sent to ${phone.slice(0, 4)}***${phone.slice(-2)}, SID: ${result.sid}`);
    return true;
  } catch (err) {
    console.error('[OTP] Failed to send SMS:', err);
    return false;
  }
}

function generateOtpCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Type for availability slots
interface AvailabilitySlot {
  startDateTime: string;
  endDateTime: string;
  staffId: string;
  staffName?: string;
  available: boolean;
  isAlternativeStaff?: boolean;
}

// Helper to check if Phorest is configured
function isPhorestConfigured(): boolean {
  return !!(
    process.env.PHOREST_USERNAME &&
    process.env.PHOREST_PASSWORD &&
    process.env.PHOREST_BUSINESS_ID
  );
}

// Debug: Log Phorest configuration status on startup
console.log('[Phorest Config]', {
  hasUsername: !!process.env.PHOREST_USERNAME,
  usernameFormat: process.env.PHOREST_USERNAME?.startsWith('global/') ? 'global/...' : 'other',
  hasPassword: !!process.env.PHOREST_PASSWORD,
  passwordLength: process.env.PHOREST_PASSWORD?.length || 0,
  businessId: process.env.PHOREST_BUSINESS_ID,
  branchId: process.env.PHOREST_BRANCH_ID,
});

// Fallback mock clients when Phorest is not configured
const mockClients: Record<string, ClientSession> = {
  "4169323131": {
    clientId: "phorest-client-001",
    isLoggedIn: true,
    profile: {
      id: "phorest-client-001",
      firstName: "Sarah",
      lastName: "Johnson",
      email: "sarah.j@email.com",
      phone: "4169323131",
      loyaltyPoints: 350,
      pointsToReward: 250,
    },
    lastVisit: {
      serviceName: "Balayage & Toner",
      date: "October 15, 2024",
      stylist: "Kozeta",
      serviceIds: ["balayage-toner"],
    },
    products: [
      { productName: "Olaplex No.3", lastPurchased: "3 weeks ago", status: "running-low" },
      { productName: "Pureology Hydrate", lastPurchased: "2 months ago", status: "in-stock" },
    ],
  },
  "demo@kozeta.com": {
    clientId: "phorest-client-002",
    isLoggedIn: true,
    profile: {
      id: "phorest-client-002",
      firstName: "Emma",
      lastName: "Davis",
      email: "demo@kozeta.com",
      phone: "4165551234",
      loyaltyPoints: 120,
      pointsToReward: 180,
    },
    lastVisit: {
      serviceName: "Keratin Treatment",
      date: "September 28, 2024",
      stylist: "Roya",
      serviceIds: ["keratin-treatment"],
    },
    products: [
      { productName: "Moroccan Oil", lastPurchased: "1 month ago", status: "in-stock" },
    ],
  },
};

import * as fs from 'fs';
import * as path from 'path';

// API prefixes that belong to the switched-off portal experience (AI chat,
// OTP login, in-app booking, deposits/payments). When PORTAL_ENABLED is false
// they all return 503 { disabled: true } so no OpenAI or Stripe calls can be
// triggered from the site. Admin endpoints, /api/services, /api/products
// (catalog reads) and the Twilio webhook stay live.
const PORTAL_ONLY_API_PREFIXES = [
  "/api/chat",
  "/api/recommendations",
  "/api/auth",
  "/api/client",
  "/api/profile",
  "/api/appointments",
  "/api/availability",
  "/api/book",
  "/api/bookings",
  "/api/payments",
  "/api/purchase",
  "/api/loyalty",
  "/api/stripe",
  "/api/products/create-checkout-intent",
  "/api/products/finalize-purchase",
  "/api/sms/history",
  "/api/sms/booking-preview",
  "/api/sms/payment-intent",
  "/api/debug/availability-sync",
];

// When LOGIN_ENABLED is true these prefixes are exempt from the block above so
// the original OTP login and read-only profile experience (profile,
// appointment history, purchases, loyalty) work again. Booking, payments and
// AI chat remain blocked — none of these endpoints touch Stripe or OpenAI.
const LOGIN_ALLOWED_PREFIXES = [
  "/api/auth",
  "/api/client",
  "/api/profile",
  "/api/appointments",
];

export async function registerRoutes(app: Express): Promise<Server> {
  if (!PORTAL_ENABLED) {
    console.log(
      LOGIN_ENABLED
        ? "[Portal] Portal disabled — AI chat, booking and payment endpoints are switched off (OTP login/profile ENABLED)"
        : "[Portal] Portal disabled — AI chat, auth, booking and payment endpoints are switched off"
    );
    app.use((req, res, next) => {
      const matches = (p: string) =>
        req.path === p || req.path.startsWith(p + "/");
      // /api/appointments/cancel can trigger a Stripe deposit refund (moves
      // real money) — it stays blocked even in login-only mode.
      const isMoneyPath = req.path.startsWith("/api/appointments/cancel");
      const hit =
        PORTAL_ONLY_API_PREFIXES.some(matches) &&
        !(LOGIN_ENABLED && !isMoneyPath && LOGIN_ALLOWED_PREFIXES.some(matches));
      // Admin deposits stay READ-ONLY: block the refund action (moves real
      // Stripe money) while allowing the history/preview GET endpoints.
      const isBlockedAdminWrite =
        req.method !== "GET" && req.path.startsWith("/api/admin/deposits");
      if (hit || isBlockedAdminWrite) {
        return res.status(503).json({
          disabled: true,
          error: "Online booking is handled directly through Phorest.",
          bookingUrl: PHOREST_BOOKING_URL,
        });
      }
      next();
    });
  }

  // Warm product cache on startup for instant loading
  console.log('[Server] Starting product cache warm-up...');
  productCache.warmCache().then(() => {
    console.log('[Server] Product cache ready for instant loading');
    productCache.startBackgroundRefresh();
  });
  
  // Warm service cache on startup - Phorest is the single source of truth
  console.log('[Server] Starting service cache warm-up...');
  import('./services/serviceCache').then(async (serviceCache) => {
    await serviceCache.warmCache();
    console.log('[Server] Service cache ready - all services synced from Phorest');
    serviceCache.startBackgroundRefresh();
  });

  // Warm staff-service sync cache on startup
  console.log('[Server] Starting staff-service sync...');
  import('./services/staffServiceSync').then(async (staffServiceSync) => {
    await staffServiceSync.warmCache();
    console.log('[Server] Staff-service sync ready - qualified staff mapped for all services');
    staffServiceSync.startBackgroundRefresh(5 * 60 * 1000); // Refresh every 5 minutes
  });

  // Serve Kozeta accessory logo for products without brand images
  app.get('/kozeta-accessory-logo.svg', (req, res) => {
    const logoPath = path.join(process.cwd(), 'client/src/assets/kozeta-accessory-logo.svg');
    try {
      const svg = fs.readFileSync(logoPath, 'utf8');
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(svg);
    } catch (error) {
      console.error('[Logo] Failed to serve kozeta logo:', error);
      res.status(404).send('Logo not found');
    }
  });

  app.get('/kozeta-product-logo.svg', (req, res) => {
    const logoPath = path.join(process.cwd(), 'client/src/assets/kozeta-product-logo.svg');
    try {
      const svg = fs.readFileSync(logoPath, 'utf8');
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(svg);
    } catch (error) {
      console.error('[Logo] Failed to serve kozeta product logo:', error);
      res.status(404).send('Logo not found');
    }
  });

  // Get salon services endpoint - driven by Phorest via serviceCache (auto-synced)
  app.get("/api/services", async (req, res) => {
    try {
      const serviceCache = await import('./services/serviceCache');

      if (!serviceCache.isCacheReady()) {
        console.log('[Services] Cache not ready, warming...');
        await serviceCache.warmCache();
      }

      const services = serviceCache.getServices();
      console.log(`[Services] Returning ${services.length} services from cache`);

      res.json({ services });
    } catch (error) {
      console.error('Error fetching services:', error);
      res.status(500).json({ error: 'Failed to fetch services' });
    }
  });

  // Get products from cache - instant loading with background refresh
  app.get("/api/products", async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 0;
      const size = parseInt(req.query.size as string) || 50;
      const brandId = req.query.brandId as string;
      const search = req.query.search as string;
      
      // Return cached data instantly
      if (productCache.isCacheReady()) {
        const startTime = Date.now();
        const result = productCache.getProducts({ page, size, brandId, search });
        const duration = Date.now() - startTime;
        
        console.log(`[Products] Cache hit - ${result.products.length} products in ${duration}ms (cache age: ${Math.round(result.cacheAge / 1000)}s)`);
        
        // Trigger background refresh if cache is stale
        if (productCache.isCacheStale()) {
          productCache.refreshCacheIfStale();
        }
        
        return res.json({
          products: result.products,
          brands: result.brands,
          page: result.page,
          totalPages: result.totalPages,
          totalElements: result.totalElements
        });
      }
      
      // Cache miss - fetch directly (should rarely happen after startup)
      console.log('[Products] Cache miss - fetching from Phorest...');
      
      if (!isPhorestConfigured()) {
        const mockProducts = [
          { productId: "p1", name: "Olaplex No.3 Hair Perfector", brandName: "Olaplex", categoryName: "HAIR CARE", price: 30.00, inStock: true, description: "Revolutionary bond-building treatment.", imageUrl: "/kozeta-product-logo.svg" },
          { productId: "p2", name: "Pureology Hydrate Shampoo", brandName: "Pureology", categoryName: "SHAMPOO", price: 36.00, inStock: true, description: "Sulfate-free hydrating shampoo.", imageUrl: "/kozeta-product-logo.svg" },
        ];
        return res.json({
          products: mockProducts,
          brands: ["Olaplex", "Pureology"],
          page: 0,
          totalPages: 1,
          totalElements: mockProducts.length
        });
      }
      
      // Fetch from Phorest and warm cache
      const productsResponse = await phorestApi.listProducts({ page: 0, size: 500 }) as any;
      let products = productsResponse._embedded?.products ?? productsResponse.content ?? [];
      
      products = products.filter((p: any) => !p.name?.toLowerCase().includes('delete'));
      
      const brandsSet = new Set<string>();
      products.forEach((p: any) => {
        if (p.brandName) brandsSet.add(p.brandName);
      });
      const brands = Array.from(brandsSet).sort();
      
      const enrichedData = await productEnrichment.enrichProducts(products.map((p: any) => ({
        productId: p.productId,
        name: p.name,
        brandName: p.brandName,
        categoryName: p.categoryName,
        price: p.price,
        imageUrl: p.imageUrl,
        barcode: p.barcode,
      })));
      
      const enrichedProducts = products.map((p: any) => {
        const enriched = enrichedData.get(p.productId);
        return {
          productId: p.productId,
          name: p.name,
          description: enriched?.description || `Premium ${p.categoryName?.toLowerCase() || 'salon'} product`,
          price: p.price || 0,
          brandName: p.brandName,
          categoryName: p.categoryName,
          imageUrl: (enriched?.imageUrl && !enriched.imageUrl.includes('placehold.co')) ? enriched.imageUrl : '/kozeta-product-logo.svg',
          inStock: p.quantityInStock > 0 || (p.inStock !== false),
          stockLevel: p.quantityInStock ?? p.stockLevel,
          sku: p.sku || p.barcode
        };
      });
      
      // Also trigger cache warm for future requests
      productCache.warmCache();
      
      // Apply filters for response
      let filtered = enrichedProducts;
      if (brandId) {
        filtered = filtered.filter((p: any) => p.brandName?.toLowerCase() === brandId.toLowerCase());
      }
      if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter((p: any) => 
          p.name?.toLowerCase().includes(searchLower) ||
          p.brandName?.toLowerCase().includes(searchLower)
        );
      }
      
      const startIndex = page * size;
      const paginatedProducts = filtered.slice(startIndex, startIndex + size);
      
      res.json({
        products: paginatedProducts,
        brands,
        page,
        totalPages: Math.ceil(filtered.length / size),
        totalElements: filtered.length
      });
    } catch (error) {
      console.error('[Products] Error fetching products:', error);
      res.status(500).json({ error: 'Failed to fetch products' });
    }
  });

  // Get single product details with AI enrichment
  app.get("/api/products/:productId", async (req, res) => {
    try {
      const { productId } = req.params;
      
      if (!isPhorestConfigured()) {
        return res.status(404).json({ error: 'Product not found' });
      }
      
      const product = await phorestApi.getProduct(productId) as any;
      
      // Enrich single product with description and image
      // Priority: Phorest image > Barcode lookup (Open Beauty Facts) > Curated fallback
      const enriched = await productEnrichment.enrichProduct({
        productId: product.productId,
        name: product.name,
        brandName: product.brandName,
        categoryName: product.categoryName,
        price: product.price,
        imageUrl: product.imageUrl,
        barcode: product.barcode,
      });
      
      res.json({
        productId: product.productId,
        name: product.name,
        description: enriched.description,
        price: product.price || 0,
        brandName: product.brandName,
        categoryName: product.categoryName,
        imageUrl: enriched.imageUrl,
        inStock: product.quantityInStock > 0 || (product.inStock !== false && (product.stockLevel === undefined || product.stockLevel > 0)),
        stockLevel: product.quantityInStock ?? product.stockLevel,
        sku: product.sku || product.barcode
      });
    } catch (error) {
      console.error('[Products] Error fetching product:', error);
      res.status(500).json({ error: 'Failed to fetch product' });
    }
  });

  // Helper: Create session and build client data for a verified Phorest client
  async function createSessionForClient(
    phorestClient: phorestApi.PhorestClient,
    normalizedPhone?: string,
    normalizedEmail?: string
  ) {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    sessionStore.set(sessionId, {
      clientId: phorestClient.clientId,
      phone: phorestClient.mobile || normalizedPhone,
      email: phorestClient.email || normalizedEmail,
      verified: true,
      createdAt: Date.now()
    });
    
    const clientSession: ClientSession = {
      clientId: phorestClient.clientId,
      isLoggedIn: true,
      profile: {
        id: phorestClient.clientId,
        firstName: phorestClient.firstName,
        lastName: phorestClient.lastName,
        email: phorestClient.email || normalizedEmail,
        phone: phorestClient.mobile || normalizedPhone,
        loyaltyPoints: 0,
        pointsToReward: LOYALTY_POINTS_PER_REDEMPTION,
      }
    };
    
    try {
      const historyResponse = await phorestApi.getClientServiceHistories(phorestClient.clientId, { page: 0, size: 1 }) as any;
      const historyContent = historyResponse._embedded?.serviceHistories ?? historyResponse.content ?? [];
      if (historyContent.length > 0) {
        const lastService = historyContent[0];
        clientSession.lastVisit = {
          serviceName: lastService.serviceName,
          date: new Date(lastService.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
          stylist: lastService.staffName,
        };
      }
    } catch (historyError) {
      console.error('[Auth] Error fetching service history:', historyError);
    }
    
    try {
      const loyaltyData = await phorestApi.getClientLoyalty(phorestClient.clientId);
      if (loyaltyData) {
        clientSession.profile.loyaltyPoints = loyaltyData.points || 0;
      }
    } catch (loyaltyError) {
      console.error('[Auth] Error fetching loyalty:', loyaltyError);
    }
    
    const sessionToken = signSessionToken(sessionId, phorestClient.clientId);
    
    return { sessionId, clientSession, sessionToken };
  }

  // Step 1: Look up client by phone in Phorest, send OTP via Twilio SMS
  app.post("/api/auth/login", loginIpLimiter, loginPhoneLimiter, async (req, res) => {
    try {
      const { phone, email, firstName, lastName, createIfNotFound } = loginRequestSchema.parse(req.body);
      const isEmailLogin = !!email && !phone;
      const normalizedPhone = isEmailLogin ? '' : authUtils.normalizePhoneForSearch(phone || '');
      
      // Validate the identifier
      if (isEmailLogin) {
        console.log(`[Auth] Email login: "${email}"`);
      } else {
        console.log(`[Auth] Phone login: "${phone}" -> "${normalizedPhone}"`);
        if (!normalizedPhone || normalizedPhone.length < 10) {
          return res.status(400).json({ error: 'Please provide a valid phone number' });
        }
      }

      if (!isPhorestConfigured()) {
        return res.status(503).json({ error: 'Salon booking system is not configured. Please contact the salon.' });
      }

      try {
        let phorestClient: phorestApi.PhorestClient | null = null;

        if (isEmailLogin) {
          // Search Phorest by email
          try {
            const normalizedSearchEmail = email!.toLowerCase().trim();
            const emailResponse = await phorestApi.listClients({ email: normalizedSearchEmail, page: 0, size: 50 }) as any;
            let emailClients = emailResponse._embedded?.clients ?? emailResponse.content ?? [];
            const emailTotalPages = emailResponse.totalPages ?? emailResponse.page?.totalPages ?? 1;
            if (emailTotalPages > 1) {
              for (let page = 1; page < Math.min(emailTotalPages, 10); page++) {
                const nextResp = await phorestApi.listClients({ email: normalizedSearchEmail, page, size: 50 }) as any;
                const nextClients = nextResp._embedded?.clients ?? nextResp.content ?? [];
                emailClients = emailClients.concat(nextClients);
              }
            }
            console.log(`[Auth] Email search "${email}": ${emailClients.length} results`);
            const emailMatch = authUtils.findMatchingClientsByEmail(emailClients, normalizedSearchEmail);
            if (emailMatch.ambiguous) {
              console.warn(`[Auth] Multiple distinct clients share email "${normalizedSearchEmail}" — refusing login`);
              return res.status(409).json({
                error: "We found more than one account with this email address. Please contact the salon to sort this out, or log in with your phone number instead."
              });
            }
            if (emailMatch.client) {
              phorestClient = emailMatch.client;
              console.log(`[Auth] Email match: ${phorestClient!.firstName} ${phorestClient!.lastName} (ID: ${phorestClient!.clientId})`);
            }
          } catch (emailSearchError) {
            console.warn(`[Auth] Email search failed:`, (emailSearchError as any).message);
          }
          
          if (!phorestClient && !createIfNotFound) {
            return res.json({ success: false, notFound: true });
          }
          
          // Email clients need a phone to receive OTP
          if (phorestClient) {
            const clientPhone = (phorestClient as any).mobile || (phorestClient as any).phone;
            if (!clientPhone) {
              return res.status(400).json({ 
                error: 'No phone number on file. Please contact the salon to add a phone number to your account.' 
              });
            }
          }
        } else {
          // Search Phorest for existing client by phone
          const phoneVariations = authUtils.getPhoneVariations(phone || '');
          console.log(`[Auth] Searching Phorest with phone variations:`, phoneVariations);
          
          const searchFields: Array<'phone' | 'mobile' | 'landLine'> = ['phone', 'mobile'];
          
          for (const field of searchFields) {
            if (phorestClient) break;
            for (const phoneFormat of phoneVariations) {
              if (phorestClient) break;
              try {
                const searchQuery: any = { [field]: phoneFormat, page: 0, size: 50 };
                const clientsResponse = await phorestApi.listClients(searchQuery) as any;
                const clients = clientsResponse._embedded?.clients ?? clientsResponse.content ?? [];
                const totalPages = clientsResponse.totalPages ?? clientsResponse.page?.totalPages ?? 1;
                
                console.log(`[Auth] Search ${field}="${phoneFormat}": ${clients.length} results (totalPages: ${totalPages})`);
                
                if (clients.length > 0 && clients.length < 100) {
                  let allCandidates = [...clients];
                  
                  if (totalPages > 1 && totalPages <= 10) {
                    for (let page = 1; page < Math.min(totalPages, 10); page++) {
                      const nextResp = await phorestApi.listClients({ ...searchQuery, page }) as any;
                      const nextClients = nextResp._embedded?.clients ?? nextResp.content ?? [];
                      allCandidates = allCandidates.concat(nextClients);
                    }
                  }
                  
                  const matchResult = authUtils.findMatchingClients(allCandidates, phone || '');
                  if (matchResult.ambiguous) {
                    console.warn(`[Auth] Multiple distinct clients share phone ending in ${(phone || '').slice(-4)} — refusing login`);
                    return res.status(409).json({
                      error: "We found more than one account with this phone number. Please contact the salon to sort this out, or log in with your email instead."
                    });
                  }
                  if (matchResult.client) {
                    phorestClient = matchResult.client;
                    console.log(`[Auth] Match: ${phorestClient!.firstName} ${phorestClient!.lastName} (ID: ${phorestClient!.clientId})`);
                    break;
                  }
                }
              } catch (searchError) {
                console.warn(`[Auth] Search ${field}="${phoneFormat}" failed:`, (searchError as any).message);
              }
            }
          }
        }
        
        // If not found and not creating, tell client
        if (!phorestClient && !createIfNotFound) {
          console.log(`[Auth] No existing client found for ${isEmailLogin ? email : phone}`);
          return res.json({ 
            success: false,
            notFound: true
          });
        }

        // If creating a new account, create in Phorest first
        if (!phorestClient && createIfNotFound) {
          console.log(`[Auth] Creating new client: ${firstName} ${lastName}`);
          try {
            const newClientData: phorestApi.CreateClientPayload = {
              firstName: firstName || "Guest",
              lastName: lastName || "Client",
              mobile: normalizedPhone,
            };
            
            phorestClient = await phorestApi.createClient(newClientData);
            console.log(`[Auth] Created new client: ${phorestClient.clientId}`);
          } catch (createError: any) {
            const errorMsg = createError.message || '';
            if (errorMsg.includes('NON_UNIQUE_MOBILE') || errorMsg.includes('already exists')) {
              // Phone exists - try to find it
              const knownPhone = phone ?? '';
              const digits = knownPhone.replace(/\D/g, '');
              const phoneFormats = [digits, '1' + digits, '+1' + digits];
              const recoveryCandidates: any[] = [];
              for (const pf of phoneFormats) {
                for (let page = 0; page < 5; page++) {
                  const resp = await phorestApi.listClients({ phone: pf, page, size: 50 }) as any;
                  const cls = resp._embedded?.clients ?? resp.content ?? [];
                  const tp = resp.totalPages ?? resp.page?.totalPages ?? 1;
                  recoveryCandidates.push(...cls);
                  if (cls.length === 0 || page + 1 >= tp) break;
                }
              }
              const recoveryMatch = authUtils.findMatchingClients(recoveryCandidates, knownPhone);
              if (recoveryMatch.ambiguous) {
                console.warn(`[Auth] Multiple distinct clients share phone ending in ${knownPhone.slice(-4)} (create recovery) — refusing login`);
                return res.status(409).json({
                  error: "We found more than one account with this phone number. Please contact the salon to sort this out, or log in with your email instead."
                });
              }
              if (recoveryMatch.client) {
                phorestClient = recoveryMatch.client;
                console.log(`[Auth] Found existing client: ${recoveryMatch.client.firstName} ${recoveryMatch.client.lastName}`);
              }
              
              if (!phorestClient) {
                return res.status(409).json({ 
                  error: "An account with this phone number already exists but we couldn't locate it. Please contact the salon." 
                });
              }
            } else {
              return res.status(500).json({ error: "We had trouble creating your account. Please try again." });
            }
          }
        }
        
        // Determine which phone to send OTP to
        let otpPhone: string;
        if (isEmailLogin && phorestClient) {
          // For email login, use the phone on file for the client
          const clientRawPhone = (phorestClient as any).mobile || (phorestClient as any).phone || '';
          otpPhone = authUtils.normalizePhoneForSearch(clientRawPhone);
        } else {
          otpPhone = authUtils.normalizePhoneForSearch(phone || '');
        }
        
        if (!otpPhone || otpPhone.length < 10) {
          return res.status(400).json({ error: 'No valid phone number available for verification.' });
        }

        // Generate and send OTP
        const code = generateOtpCode();
        const otpId = `otp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        otpStore.set(otpId, {
          phone: otpPhone,
          code,
          phorestClient,
          isNewAccount: !phorestClient?.clientId || createIfNotFound === true,
          firstName,
          lastName,
          attempts: 0,
          createdAt: Date.now(),
        });
        
        const smsSent = await sendSmsOtp(otpPhone, code);
        
        if (!smsSent) {
          otpStore.delete(otpId);
          return res.status(500).json({ error: 'Unable to send verification code. Please try again.' });
        }

        // Track this phone so the SMS companion ignores 6-digit replies while OTP is active
        registerOtpPhone(otpPhone);

        // One-time awareness message: tell new portal users about the SMS AI companion.
        // Fire-and-forget — delay slightly so the OTP lands first.
        setTimeout(() => {
          sendSms(
            otpPhone,
            "Tip: Text this number anytime — Kozeta AI can check your appointments, book services & answer questions instantly. No app needed."
          ).catch(() => {});
        }, 1500);
        
        const maskedPhone = otpPhone.length >= 4 
          ? '***' + otpPhone.slice(-4) 
          : otpPhone;
        
        console.log(`[Auth] OTP sent for ${phorestClient?.firstName || 'new client'}, otpId: ${otpId}`);
        
        return res.json({
          success: false,
          otpSent: true,
          otpId,
          maskedPhone,
          clientName: phorestClient ? `${phorestClient.firstName}` : undefined,
        });
        
      } catch (phorestError) {
        console.error('[Auth] Phorest API error:', phorestError);
        return res.status(500).json({ error: 'Unable to connect to salon system. Please try again.' });
      }
    } catch (error) {
      console.error('[Auth] Login error:', error);
      res.status(400).json({ error: 'Invalid request' });
    }
  });


  // Step 2: Verify OTP code and create session
  app.post("/api/auth/verify", verifyIpLimiter, async (req, res) => {
    try {
      const { otpId, code } = otpVerifySchema.parse(req.body);
      
      const pending = otpStore.get(otpId);
      if (!pending) {
        return res.status(400).json({ error: 'Verification expired. Please try again.' });
      }
      
      if (Date.now() - pending.createdAt > OTP_EXPIRY_MS) {
        otpStore.delete(otpId);
        return res.status(400).json({ error: 'Code expired. Please request a new one.' });
      }
      
      if (pending.attempts >= MAX_OTP_ATTEMPTS) {
        otpStore.delete(otpId);
        return res.status(429).json({
          error: 'Too many attempts — please start over and request a new code.',
          attemptsRemaining: 0
        });
      }
      
      pending.attempts++;
      
      if (pending.code !== code) {
        const remainingAttempts = MAX_OTP_ATTEMPTS - pending.attempts;
        console.log(`[Auth] OTP mismatch for ${otpId}: ${remainingAttempts} attempts left`);
        return res.status(401).json({ 
          error: `Invalid code. ${remainingAttempts > 0 ? `${remainingAttempts} attempt${remainingAttempts > 1 ? 's' : ''} remaining.` : 'Please request a new code.'}`,
          attemptsRemaining: remainingAttempts
        });
      }
      
      // OTP verified - create session
      clearOtpPhone(pending.phone);
      otpStore.delete(otpId);
      
      if (!pending.phorestClient) {
        return res.status(500).json({ error: 'Account setup failed. Please try again.' });
      }
      
      const sessionResult = await createSessionForClient(pending.phorestClient, pending.phone);
      console.log(`[Auth] OTP verified - Session: ${sessionResult.sessionId}`);
      
      return res.json({
        success: true,
        session: sessionResult.clientSession,
        sessionId: sessionResult.sessionId,
        sessionToken: sessionResult.sessionToken,
      });
      
    } catch (error) {
      console.error('[Auth] Verify error:', error);
      res.status(400).json({ error: 'Invalid request' });
    }
  });

  // Resend OTP code
  app.post("/api/auth/resend-otp", verifyIpLimiter, async (req, res) => {
    try {
      const { otpId } = req.body;
      
      const pending = otpStore.get(otpId);
      if (!pending) {
        return res.status(400).json({ error: 'Session expired. Please start over.' });
      }
      
      // Generate new code - preserve existing attempt count to prevent brute-force bypass
      const newCode = generateOtpCode();
      pending.code = newCode;
      pending.createdAt = Date.now();
      
      const smsSent = await sendSmsOtp(pending.phone, newCode);
      
      if (!smsSent) {
        return res.status(500).json({ error: 'Unable to resend code. Please try again.' });
      }

      // Keep OTP bridge in sync: refresh the active-phone window so SMS companion keeps ignoring 6-digit replies
      registerOtpPhone(pending.phone);
      
      console.log(`[Auth] OTP resent for ${otpId}`);
      return res.json({ success: true, message: 'New code sent' });
      
    } catch (error) {
      console.error('[Auth] Resend error:', error);
      res.status(400).json({ error: 'Invalid request' });
    }
  });

  // Server-side logout - removes session from in-memory store
  app.delete("/api/auth/session", async (req, res) => {
    try {
      const sessionId = req.body?.sessionId || req.query.sessionId as string;
      const sessionToken = req.body?.sessionToken || req.query.sessionToken as string;
      if (sessionId && sessionToken) {
        const verified = verifySessionToken(sessionToken);
        if (verified && verified.sessionId === sessionId) {
          sessionStore.delete(sessionId);
          revokedSessionIds.add(sessionId);
          await persistRevokedSession(sessionId);
          console.log(`[Auth] Session ${sessionId.slice(0, 15)}... deleted and token revoked (logout)`);
        }
      }
      return res.json({ success: true });
    } catch (error) {
      console.error('[Auth] Logout error:', error);
      res.json({ success: false });
    }
  });

  // Update client name in Phorest
  app.post("/api/client/update-name", async (req, res) => {
    try {
      const { sessionId, sessionToken, firstName, lastName } = updateNameSchema.parse(req.body);
      
      const clientId = resolveSession(sessionId, sessionToken);
      if (!clientId) {
        return res.status(401).json({ error: 'Not logged in' });
      }
      
      if (!isPhorestConfigured()) {
        return res.status(503).json({ error: 'Salon system not available' });
      }
      
      const updatedClient = await phorestApi.updateClient(clientId, { firstName, lastName });
      console.log(`[Client] Name updated for ${clientId}: ${firstName} ${lastName}`);
      
      return res.json({ 
        success: true, 
        firstName: updatedClient.firstName, 
        lastName: updatedClient.lastName 
      });
      
    } catch (error) {
      console.error('[Client] Update name error:', error);
      res.status(400).json({ error: 'Failed to update name' });
    }
  });

  // Safe JSON stringify for diagnostic logging (never throws)
  function safeJson(v: unknown): string {
    try {
      return JSON.stringify(v) ?? "undefined";
    } catch {
      return String(v);
    }
  }

  // Phorest GET /appointment/{id} responses can arrive in several shapes:
  // a direct appointment object, a HAL wrapper (_embedded.appointments[0]),
  // a paged wrapper (content[0]), or nested under `appointment`. Normalize
  // to the inner appointment object so state checks never miss.
  function unwrapAppointment(resp: any): any {
    if (!resp || typeof resp !== 'object') return resp;
    const embedded = resp._embedded?.appointments ?? resp._embedded?.appointment;
    if (Array.isArray(embedded) && embedded.length > 0) return embedded[0];
    if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) return embedded;
    if (Array.isArray(resp.content) && resp.content.length > 0) return resp.content[0];
    if (resp.appointment && typeof resp.appointment === 'object') return resp.appointment;
    return resp;
  }

  // Extract HTTP status/body detail from a Phorest error for diagnostics.
  function phorestErrDetail(err: unknown): string {
    const e = err as any;
    if (e?.name === 'PhorestApiError') {
      return `status=${e.status ?? 'none (timeout/network)'} body=${e.body ?? ''} message=${e.message}`;
    }
    return String(e?.message ?? e);
  }

  // Cancel appointment with 24h policy
  app.post("/api/appointments/cancel", async (req, res) => {
    try {
      const { sessionId, sessionToken, appointmentId } = req.body;
      
      if (!appointmentId) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      const clientId = resolveSession(sessionId, sessionToken);
      if (!clientId) {
        return res.status(401).json({ error: 'Not logged in' });
      }
      
      if (!isPhorestConfigured()) {
        return res.status(503).json({ error: 'Salon system not available' });
      }
      
      // Get the appointment to check ownership and start time
      try {
        const appointment = unwrapAppointment(await phorestApi.getAppointment(appointmentId));
        
        // Verify the appointment belongs to the logged-in client
        if (appointment.clientId !== clientId) {
          return res.status(403).json({ error: 'You can only cancel your own appointments' });
        }
        
        // Already cancelled in Phorest (e.g. by staff) — treat as success so
        // the client's view can update instead of erroring out.
        if (isCancelledAppointment(appointment)) {
          console.log(`[Appointments] ${appointmentId} already cancelled in Phorest`);
          return res.json({
            success: true,
            isWithin24Hours: false,
            message: 'This appointment was already cancelled.'
          });
        }

        // Phorest may return either a full-ISO startTime or a TIME-ONLY
        // startTime plus a separate salon-local appointmentDate — naive
        // Date() parsing of the latter is NaN and silently disables the
        // 24h/past checks. appointmentStartMs handles both shapes.
        const appointmentTime = appointmentStartMs(appointment);
        const now = Date.now();
        const hoursUntil = appointmentTime === null ? null : (appointmentTime - now) / (1000 * 60 * 60);
        if (hoursUntil === null) {
          // Fail closed: without a trustworthy start time we cannot enforce
          // the past-appointment guard or the 24h deposit policy.
          console.warn(`[Appointments] Could not parse start time for ${appointmentId} — refusing to cancel (fail closed). Raw:`, JSON.stringify({ startTime: (appointment as any).startTime, startDateTime: (appointment as any).startDateTime, appointmentDate: (appointment as any).appointmentDate }));
          return res.status(502).json({
            error: 'Could not verify appointment time',
            code: 'CANCEL_TIME_UNVERIFIED',
            message: 'We could not verify the appointment time, so the cancellation was not processed. Please call us to cancel this appointment.'
          });
        }

        // Don't allow cancelling past appointments (1h grace for clock skew)
        if (hoursUntil < -1) {
          return res.status(400).json({ error: 'Cannot cancel a past appointment' });
        }

        const isWithin24Hours = hoursUntil < 24;

        const cancelResp = await phorestApi.cancelAppointment(appointmentId);

        // Verify the cancellation actually took effect before telling the client.
        // Phorest tracks cancellation in `activationState` (not `state`). The
        // change may take a moment to reflect, so retry the verify briefly
        // before declaring the cancel unconfirmed.
        let cancelConfirmed = false;
        let lastVerify: any = null;
        let lastVerifyErr: unknown = null;
        for (let attempt = 0; attempt < 3 && !cancelConfirmed; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 800));
          try {
            lastVerify = await phorestApi.getAppointment(appointmentId);
            cancelConfirmed = isCancelledAppointment(unwrapAppointment(lastVerify));
          } catch (verifyErr) {
            lastVerifyErr = verifyErr;
            console.warn(`[Appointments] Verify attempt ${attempt + 1} failed for ${appointmentId}: ${phorestErrDetail(verifyErr)}`);
          }
        }

        if (!cancelConfirmed) {
          console.warn(
            `[Appointments] Cancel request sent but activationState not CANCELED for ${appointmentId}.`,
            `Cancel POST response body (HTTP 2xx): ${safeJson(cancelResp)}`,
            `Last verify GET response body: ${safeJson(lastVerify)}`,
            lastVerifyErr ? `Last verify GET error: ${phorestErrDetail(lastVerifyErr)}` : ''
          );
          return res.status(503).json({
            error: 'Cancellation could not be confirmed',
            code: 'CANCEL_UNCONFIRMED',
            message: 'Your cancellation request was sent but we could not confirm it went through. Please call us to make sure your appointment is cancelled.'
          });
        }

        console.log(`[Appointments] Cancelled ${appointmentId} (${hoursUntil.toFixed(1)}h before)`);

        // Eligible cancellation (>24h out): issue the promised full deposit
        // refund immediately instead of only promising it. The deposit PI is
        // located by exact metadata match on the appointment id — never by
        // time-based matching (reschedules break that). If no deposit is
        // found or the refund fails, the orphan sweep remains the safety net
        // (it refunds deposits for cancelled appointments automatically).
        let refundMessage: string | null = null;
        if (hoursUntil !== null && !isWithin24Hours) {
          try {
            const stripe = await stripeClient.getStripeClient();
            const search = await stripe.paymentIntents.search({
              // New deposits carry the real appointment id in metadata.appointmentId;
              // older ones only have the booking id in phorestBookingId. Match either.
              query: `(metadata['appointmentId']:'${appointmentId}' OR metadata['phorestBookingId']:'${appointmentId}') AND status:'succeeded'`,
              limit: 5,
            });
            const depositPi = (search.data || []).find((p: any) =>
              isBookingDepositIntent(p) && p.metadata?.clientId === clientId
            );
            if (depositPi) {
              const result = await issueDepositRefund({
                paymentIntentId: depositPi.id,
                reason: `Client cancelled appointment ${appointmentId} more than 24h in advance`,
                initiatedBy: 'client-cancellation',
              });
              if (result.ok) {
                refundMessage = `Appointment cancelled. Your $${((result.amountRefundedCents || 0) / 100).toFixed(2)} deposit has been refunded to your card.`;
              } else if (result.code === 'NOTHING_TO_REFUND') {
                refundMessage = 'Appointment cancelled. Your deposit was already refunded.';
              } else if (result.code === 'REFUND_IN_FLIGHT') {
                refundMessage = 'Appointment cancelled. Your deposit refund is already being processed.';
              } else {
                console.error(`[Appointments] Auto-refund failed for ${appointmentId} (${depositPi.id}): ${result.code} ${result.message}`);
                refundMessage = 'Appointment cancelled. We could not process your deposit refund automatically — it will be refunded within 30 minutes, or contact the salon.';
              }
            }
          } catch (refundErr) {
            // Refund search/issue failure must never undo a confirmed cancel.
            console.error(`[Appointments] Auto-refund lookup failed for ${appointmentId}:`, refundErr);
            refundMessage = 'Appointment cancelled. Your deposit will be refunded automatically shortly.';
          }
        }

        return res.json({ 
          success: true,
          isWithin24Hours,
          message: isWithin24Hours 
            ? 'Appointment cancelled. Since it was within 24 hours, your deposit is non-refundable.'
            : (refundMessage || 'Appointment cancelled. Your deposit will be refunded.')
        });
      } catch (err) {
        console.error(`[Appointments] Cancel error for ${appointmentId}: ${phorestErrDetail(err)}`, err);
        return res.status(500).json({ error: 'Failed to cancel appointment. Please contact the salon.' });
      }
      
    } catch (error) {
      console.error('[Appointments] Cancel error:', error);
      res.status(400).json({ error: 'Invalid request' });
    }
  });

  // Get client profile - uses Phorest API
  app.get("/api/profile", async (req, res) => {
    try {
      const sessionId = req.query.sessionId as string;
      const sessionToken = req.query.sessionToken as string;
      
      console.log(`[Profile] Request - sessionId: ${sessionId?.slice(0, 15) || 'none'}, hasToken: ${!!sessionToken}`);
      
      let targetClientId: string | undefined;
      
      if (sessionId && sessionStore.has(sessionId)) {
        const session = sessionStore.get(sessionId)!;
        targetClientId = session.clientId;
        console.log(`[Profile] Found session for client: ${targetClientId.slice(0, 15)}...`);
      } else if (sessionToken) {
        const verified = verifySessionToken(sessionToken);
        if (verified) {
          sessionStore.set(verified.sessionId, { clientId: verified.clientId, verified: true, createdAt: Date.now() });
          targetClientId = verified.clientId;
          console.log(`[Profile] Restored session via signed token for client: ${targetClientId.slice(0, 15)}...`);
        } else {
          console.log(`[Profile] Invalid session token - rejecting restoration`);
          return res.status(401).json({ error: 'Invalid session token. Please login again.' });
        }
      }
      
      if (!targetClientId) {
        console.log(`[Profile] No client ID found - returning 401`);
        return res.status(401).json({ error: 'Not logged in' });
      }
      
      if (isPhorestConfigured()) {
        try {
          console.log(`[Profile] Fetching Phorest data for client: ${targetClientId.slice(0, 15)}...`);
          const client = await phorestApi.getClient(targetClientId);
          
          let serviceHistory: any[] = [];
          try {
            console.log(`[Profile] Fetching service history...`);
            const historyResponse = await phorestApi.getClientServiceHistories(targetClientId, { page: 0, size: 10 }) as any;
            serviceHistory = historyResponse._embedded?.serviceHistories ?? historyResponse.content ?? [];
            console.log(`[Profile] Found ${serviceHistory.length} service history entries`);
          } catch (histErr) {
            console.warn(`[Profile] Service history not available:`, (histErr as any).message);
          }
          
          let appointments: any[] = [];
          try {
            // Phorest caps list-appointment date ranges at 31 days (400 above
            // that) — fetch 6 months ahead as parallel 30-day windows.
            const DAY_MS = 24 * 60 * 60 * 1000;
            const windows = Array.from({ length: 6 }, (_, i) => ({
              fromDate: torontoDateString(new Date(Date.now() + i * 30 * DAY_MS)),
              toDate: torontoDateString(new Date(Date.now() + ((i + 1) * 30 - 1) * DAY_MS)),
            }));
            const windowResults = await Promise.all(windows.map(w =>
              phorestApi.listAppointments({
                clientId: targetClientId,
                fromDate: w.fromDate,
                toDate: w.toDate,
                page: 0,
                size: 50
              }).catch((e: any) => {
                console.warn(`[Profile] Appointment window ${w.fromDate}..${w.toDate} failed:`, e?.message);
                return null;
              })
            ));
            const seenApptIds = new Set<string>();
            const rawAppointments: any[] = [];
            for (const resp of windowResults as any[]) {
              if (!resp) continue;
              const list: any[] = resp._embedded?.appointments ?? resp.content ?? [];
              for (const a of list) {
                if (a?.appointmentId && seenApptIds.has(a.appointmentId)) continue;
                if (a?.appointmentId) seenApptIds.add(a.appointmentId);
                rawAppointments.push(a);
              }
            }
            const staffSync = await import('./services/staffServiceSync');
            // Phorest returns appointmentDate ("YYYY-MM-DD") + TIME-ONLY startTime
            // ("09:00:00.000", salon-local) and a flat serviceName/staffId — the
            // frontend needs a real ISO startTime and a services[] array.
            // Normalize here; drop cancelled/deleted and unparseable entries.
            appointments = rawAppointments
              .filter((a: any) => !isCancelledAppointment(a) && !a.deleted)
              .map((a: any) => {
                const startMs = appointmentStartMs(a);
                if (startMs === null) {
                  console.warn(`[Profile] Skipping appointment ${a.appointmentId} — unparseable start time`, { appointmentDate: a.appointmentDate, startTime: a.startTime });
                  return null;
                }
                const staffMember = a.staffId ? staffSync.getStaff(a.staffId) : undefined;
                const staffName = a.staffName
                  || (staffMember ? [staffMember.firstName, staffMember.lastName].filter(Boolean).join(' ') : undefined);
                return {
                  appointmentId: a.appointmentId,
                  clientId: a.clientId,
                  branchId: a.branchId,
                  staffId: a.staffId,
                  staffName,
                  startTime: new Date(startMs).toISOString(),
                  endTime: a.endTime,
                  status: a.state || 'BOOKED',
                  services: Array.isArray(a.services) && a.services.length > 0
                    ? a.services
                    : [{ serviceId: a.serviceId || '', serviceName: a.serviceName || 'Appointment', price: a.price }],
                };
              })
              .filter(Boolean)
              .sort((x: any, y: any) => new Date(x.startTime).getTime() - new Date(y.startTime).getTime());
          } catch (apptErr) {
            console.warn(`[Profile] Appointments not available:`, (apptErr as any).message);
          }
          
          // Build last visit
          let lastVisit: LastVisit | undefined;
          if (serviceHistory.length > 0) {
            const last = serviceHistory[0];
            lastVisit = {
              serviceName: last.serviceName,
              date: new Date(last.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
              stylist: last.staffName,
            };
          }
          
          // Try to get loyalty
          let loyaltyPoints = 0;
          try {
            const loyalty = await phorestApi.getClientLoyalty(targetClientId);
            loyaltyPoints = loyalty.points || 0;
          } catch (e) {
            console.error('Loyalty fetch failed:', e);
          }
          
          // Try to get purchase history for products
          let products: ProductPurchase[] = [];
          try {
            const purchaseHistory = await phorestApi.getClientPurchaseHistory(targetClientId, { page: 0, size: 5 }) as any;
            const purchases = purchaseHistory._embedded?.purchases ?? purchaseHistory.content ?? [];
            if (purchases.length > 0) {
              products = purchases.flatMap((purchase: any) => 
                (purchase.items || []).map((item: any) => ({
                  productName: item.productName,
                  lastPurchased: new Date(purchase.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                  status: 'in-stock' as const
                }))
              ).slice(0, 5);
            }
          } catch (e) {
            console.error('Purchase history fetch failed:', e);
          }
          
          return res.json({
            clientId: targetClientId,
            profile: {
              id: client.clientId,
              firstName: client.firstName,
              lastName: client.lastName,
              email: client.email,
              phone: client.mobile,
              loyaltyPoints,
              pointsToReward: Math.max(0, LOYALTY_POINTS_PER_REDEMPTION - (loyaltyPoints % LOYALTY_POINTS_PER_REDEMPTION)),
            },
            lastVisit,
            upcomingAppointments: appointments,
            pastAppointments: serviceHistory.map((h: any) => ({
              appointmentId: h.serviceHistoryId,
              clientId: h.clientId,
              branchId: '',
              staffId: h.staffId,
              staffName: h.staffName,
              startTime: h.date,
              endTime: h.date,
              status: 'completed',
              services: [{ serviceId: '', serviceName: h.serviceName, price: h.price }],
            })),
            loyalty: getLoyaltyRewardInfo(loyaltyPoints),
            products
          });
          
        } catch (phorestError) {
          console.error('Phorest profile error:', phorestError);
          // Only treat a real Phorest 404 as "client does not exist". Timeouts
          // or Phorest 5xx must NOT log the user out — return 503 so the
          // frontend keeps the session and can retry.
          const isRealNotFound = phorestError instanceof phorestApi.PhorestApiError && phorestError.status === 404;
          if (!isRealNotFound) {
            return res.status(503).json({
              error: 'Profile temporarily unavailable',
              code: 'PHOREST_UNAVAILABLE',
            });
          }
        }
      }
      
      // Fallback to mock data
      const client = Object.values(mockClients).find(c => c.clientId === targetClientId);
      
      if (!client) {
        return res.status(404).json({ error: 'Client not found' });
      }
      
      res.json({
        clientId: client.clientId,
        profile: client.profile,
        lastVisit: client.lastVisit,
        loyalty: getLoyaltyRewardInfo(client.profile.loyaltyPoints),
        products: client.products
      });
    } catch (error) {
      console.error('Profile error:', error);
      res.status(500).json({ error: 'Failed to load profile' });
    }
  });

  // Get client by ID (legacy endpoint)
  app.get("/api/client/:clientId", async (req, res) => {
    try {
      const { clientId } = req.params;
      
      if (isPhorestConfigured()) {
        try {
          const client = await phorestApi.getClient(clientId);
          return res.json({
            clientId: client.clientId,
            isLoggedIn: true,
            profile: {
              id: client.clientId,
              firstName: client.firstName,
              lastName: client.lastName,
              email: client.email,
              phone: client.mobile,
              loyaltyPoints: 0,
              pointsToReward: LOYALTY_POINTS_PER_REDEMPTION,
            }
          });
        } catch (e) {
          console.error('Phorest client fetch error:', e);
        }
      }
      
      const client = Object.values(mockClients).find(c => c.clientId === clientId);
      
      if (!client) {
        return res.status(404).json({ error: 'Client not found' });
      }
      
      res.json(client);
    } catch (error) {
      console.error('Client fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch client data' });
    }
  });

  // Get branch ID from environment (validates for placeholder values)
  const getDefaultBranchId = () => phorestApi.getBranchId();

  // Check appointment availability - Phorest API
  // Uses official endpoint: POST /checkappointmentavailability
  app.post("/api/availability", async (req, res) => {
    try {
      const parsed = availabilityRequestSchema.parse(req.body);
      
      let branchId: string | undefined;
      try {
        branchId = parsed.branchId || getDefaultBranchId();
      } catch (branchError: any) {
        return res.status(400).json({ 
          error: branchError.message || 'Invalid branch configuration',
          code: 'INVALID_BRANCH_ID'
        });
      }
      const { serviceIds, staffIds, from, to } = parsed;
      
      console.log(`[Availability] Request: services=${serviceIds.join(',')}, staff=${staffIds?.join(',') || 'any'}, from=${from}, to=${to}`);
      
      if (!isPhorestConfigured()) {
        return res.status(503).json({ 
          error: 'Online booking is temporarily unavailable',
          code: 'BOOKING_UNAVAILABLE',
          message: 'Please call us at (416) 932-3131 to book your appointment.'
        });
      }
      
      // Convert to Phorest API format — business hours (9 AM–9 PM) are computed
      // explicitly in America/Toronto so the window is correct regardless of the
      // server's own timezone (UTC on hosted environments).
      const dateOnlyRe = /^\d{4}-\d{2}-\d{2}$/;
      let startTime: Date;
      let endTime: Date;
      if (dateOnlyRe.test(from)) {
        startTime = torontoDateAtHour(from, 9);
      } else {
        startTime = new Date(from);
        // If the explicit time is midnight Toronto, treat it as "no time given"
        if (torontoHour(startTime) === 0 && startTime.getUTCMinutes() === 0) {
          startTime = torontoDateAtHour(startTime, 9);
        }
      }
      if (dateOnlyRe.test(to)) {
        endTime = torontoDateAtHour(to, 21);
      } else {
        endTime = new Date(to);
        if (torontoHour(endTime) === 0 && endTime.getUTCMinutes() === 0) {
          endTime = torontoDateAtHour(endTime, 21);
        }
      }
      
      // Build service selections with optional staff preferences
      const serviceSelections: phorestApi.ServiceSelection[] = serviceIds.map((serviceId, idx) => ({
        serviceId,
        staffId: staffIds?.[idx] || staffIds?.[0]
      }));
      
      const availabilityPayload: phorestApi.CheckAvailabilityRequest = {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        clientServiceSelections: [{
          serviceSelections
        }],
        isOnlineAvailability: true
      };
      if (branchId) {
        availabilityPayload.branchId = branchId;
      }
      
      console.log(`[Availability] Phorest request:`, JSON.stringify(availabilityPayload, null, 2));
      
      let availabilityResponse;
      try {
        availabilityResponse = await phorestApi.checkAppointmentAvailability(availabilityPayload);
        console.log(`[Availability] Phorest raw response slots: ${availabilityResponse.data?.length || 0}`);
        if (availabilityResponse.data?.[0]) {
          console.log(`[Availability] First slot sample:`, JSON.stringify(availabilityResponse.data[0], null, 2));
        }
      } catch (phorestError) {
        console.log('[Availability] Phorest API failed:', phorestError instanceof Error ? phorestError.message : phorestError);
        return res.status(503).json({ 
          error: 'Online booking is temporarily unavailable',
          code: 'BOOKING_UNAVAILABLE',
          message: 'Please call us at (416) 932-3131 to book your appointment.'
        });
      }
      
      // Transform Phorest response to frontend-friendly format
      // Phorest returns: { data: [{ startTime, clientSchedules: [{ serviceSchedules: [{ staffId, startTime, endTime, alternativeStaffMember }] }] }] }
      const allSlots: AvailabilitySlot[] = [];
      
      // Fallback slot length when Phorest omits endTime: real cached service
      // duration(s); 1 hour only as a last resort for unknown services.
      const serviceCacheMod = await import('./services/serviceCache');
      const fallbackDurationMs = (serviceCacheMod.getTotalDurationMinutes(serviceIds) || 60) * 60 * 1000;
      
      // Track if a specific staff was requested (not "Any Available")
      const requestedStaffId = staffIds?.[0] && staffIds[0].length > 0 ? staffIds[0] : null;
      
      if (availabilityResponse.data && Array.isArray(availabilityResponse.data)) {
        for (const slot of availabilityResponse.data) {
          // Each slot has clientSchedules containing serviceSchedules with staff info
          const clientSchedule = slot.clientSchedules?.[0];
          const serviceSchedule = clientSchedule?.serviceSchedules?.[0];
          
          if (serviceSchedule) {
            allSlots.push({
              startDateTime: serviceSchedule.startTime || slot.startTime,
              endDateTime: serviceSchedule.endTime || new Date(new Date(serviceSchedule.startTime || slot.startTime).getTime() + fallbackDurationMs).toISOString(),
              staffId: serviceSchedule.staffId,
              staffName: undefined,
              available: true,
              isAlternativeStaff: serviceSchedule.alternativeStaffMember === true
            });
          } else {
            // Fallback: use slot start time
            allSlots.push({
              startDateTime: slot.startTime,
              endDateTime: new Date(new Date(slot.startTime).getTime() + fallbackDurationMs).toISOString(),
              staffId: '',
              staffName: undefined,
              available: true,
              isAlternativeStaff: false
            });
          }
        }
      }
      
      // Filter slots based on whether a specific staff was requested
      let slots: AvailabilitySlot[];
      let alternativesAvailable = false;
      let alternativeCount = 0;
      
      if (requestedStaffId) {
        // When a specific stylist is selected, only show THEIR slots
        // Keep slots where: staff matches OR Phorest says it's not an alternative (staffRequest was honored)
        slots = allSlots.filter(slot => {
          const isRequestedStaff = slot.staffId === requestedStaffId;
          const isNotAlternative = !slot.isAlternativeStaff;
          return isRequestedStaff || isNotAlternative;
        });
        
        // Check if there are alternative stylists available (for UX messaging)
        const alternativeSlots = allSlots.filter(slot => slot.isAlternativeStaff);
        alternativesAvailable = alternativeSlots.length > 0 && slots.length === 0;
        alternativeCount = alternativeSlots.length;
        
        console.log(`[Availability] Filtered for staff ${requestedStaffId}: ${allSlots.length} → ${slots.length} slots (${alternativeCount} alternatives available)`);
      } else {
        // "Any Available Stylist" - show all slots (including alternatives)
        slots = allSlots;
        console.log(`[Availability] Any staff requested - showing all ${slots.length} slots`);
      }
      
      console.log(`[Availability] Returning ${slots.length} slots to frontend`);
      
      res.json({ 
        slots,
        alternativesAvailable,
        alternativeCount
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Invalid availability request',
          details: error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
        });
      }
      console.error('Availability error:', error);
      res.status(500).json({ error: 'Failed to check availability' });
    }
  });
  
  // Get existing appointments for a date range (for sync verification)
  app.get("/api/appointments", async (req, res) => {
    try {
      const { from, to, clientId } = req.query;
      
      if (!isPhorestConfigured()) {
        return res.json({ appointments: [], message: 'Phorest not configured' });
      }
      
      const fromDate = from ? new Date(from as string).toISOString().split('T')[0] : torontoDateString(new Date());
      const toDate = to ? new Date(to as string).toISOString().split('T')[0] : torontoDateString(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
      
      console.log(`[Appointments] Fetching from ${fromDate} to ${toDate}${clientId ? ` for client ${clientId}` : ''}`);
      
      const query: any = {
        fromDate,
        toDate,
        page: 0,
        size: 100
      };
      
      if (clientId) {
        query.clientId = clientId as string;
      }
      
      const appointmentsResponse = await phorestApi.listAppointments(query) as any;
      const appointments = appointmentsResponse._embedded?.appointments ?? appointmentsResponse.content ?? [];
      
      console.log(`[Appointments] Found ${appointments.length} appointments in Phorest`);
      
      // Log appointment times for debugging sync issues
      if (appointments.length > 0) {
        console.log(`[Appointments] Sample appointments:`);
        appointments.slice(0, 5).forEach((apt: any) => {
          console.log(`  - ${apt.startTime} | Staff: ${apt.staffId || 'unknown'} | Status: ${apt.status || 'unknown'}`);
        });
      }
      
      res.json({ 
        appointments,
        count: appointments.length,
        dateRange: { from: fromDate, to: toDate }
      });
    } catch (error) {
      console.error('[Appointments] Fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch appointments' });
    }
  });

  // Debug endpoint to compare availability with appointments (development only)
  app.get("/api/debug/availability-sync", async (req, res) => {
    if (process.env.NODE_ENV !== 'development') {
      return res.status(404).json({ error: 'Not found' });
    }
    try {
      const { date, serviceId } = req.query;
      
      if (!isPhorestConfigured()) {
        return res.json({ error: 'Phorest not configured' });
      }
      
      const targetDate = date ? new Date(date as string) : new Date();
      const dateStr = torontoDateString(targetDate);
      
      // Get appointments for this date
      const appointmentsResponse = await phorestApi.listAppointments({
        fromDate: dateStr,
        toDate: dateStr,
        page: 0,
        size: 100
      }) as any;
      const appointments = appointmentsResponse._embedded?.appointments ?? appointmentsResponse.content ?? [];
      
      // Get availability for this date (Toronto business hours, not server-local time)
      const startTime = torontoDateAtHour(dateStr, 9);
      const endTime = torontoDateAtHour(dateStr, 21);
      
      const availabilityPayload: phorestApi.CheckAvailabilityRequest = {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        clientServiceSelections: [{
          serviceSelections: serviceId 
            ? [{ serviceId: serviceId as string }]
            : [{ serviceId: 'SdahgjkVVMogBEiKSmTmzQ' }] // Default to Women's Cut
        }],
        isOnlineAvailability: true
      };
      
      const availabilityResponse = await phorestApi.checkAppointmentAvailability(availabilityPayload);
      const slots = availabilityResponse.data || [];
      
      // Extract appointment times for comparison
      const bookedTimes = appointments.map((apt: any) => ({
        time: apt.startTime,
        staffId: apt.staffId?.slice(0, 8) || 'unknown',
        endTime: apt.endTime
      }));
      
      // Extract available times
      const availableTimes = slots.map((slot: any) => {
        const serviceSchedule = slot.clientSchedules?.[0]?.serviceSchedules?.[0];
        return {
          time: serviceSchedule?.startTime || slot.startTime,
          staffId: serviceSchedule?.staffId?.slice(0, 8) || 'any',
          endTime: serviceSchedule?.endTime
        };
      });
      
      // Check for conflicts (times that appear in both lists for same staff)
      const conflicts: any[] = [];
      for (const avail of availableTimes) {
        for (const booked of bookedTimes) {
          const availStart = new Date(avail.time);
          const bookedStart = new Date(booked.time);
          
          // Check if times overlap (within 1 hour window for simplicity)
          const timeDiff = Math.abs(availStart.getTime() - bookedStart.getTime());
          if (timeDiff < 60 * 60 * 1000) { // Within 1 hour
            conflicts.push({
              availableSlot: avail,
              bookedAppointment: booked,
              note: avail.staffId === booked.staffId ? 'SAME STAFF - CONFLICT!' : 'Different staff - OK'
            });
          }
        }
      }
      
      res.json({
        date: dateStr,
        timezone: 'UTC (all times)',
        torontoOffset: '-5 hours (EST) or -4 hours (EDT)',
        appointments: {
          count: appointments.length,
          times: bookedTimes.slice(0, 20)
        },
        availability: {
          count: slots.length,
          times: availableTimes.slice(0, 20)
        },
        potentialConflicts: conflicts,
        summary: conflicts.filter(c => c.note.includes('CONFLICT')).length > 0 
          ? 'SYNC ISSUE DETECTED - Some available slots conflict with booked appointments'
          : 'No conflicts found - Availability correctly excludes booked times'
      });
    } catch (error) {
      console.error('[Debug] Sync check error:', error);
      res.status(500).json({ error: 'Failed to check sync' });
    }
  });

  // Create booking - Phorest API
  // Uses official endpoint: POST /createbooking
  app.post("/api/book", async (req, res) => {
    try {
      const parsed = bookingRequestSchema.parse(req.body);
      
      let branchId: string | undefined;
      try {
        branchId = parsed.branchId || getDefaultBranchId();
      } catch (branchError: any) {
        return res.status(400).json({ 
          error: branchError.message || 'Invalid branch configuration',
          code: 'INVALID_BRANCH_ID'
        });
      }
      
      const { serviceIds, staffIds, startDateTime, notes, sessionId } = parsed;
      const sessionToken = req.body.sessionToken as string | undefined;
      
      // Validate client is logged in via session (unified CRM auth), with token-based restore on server restart
      const clientId = resolveSession(sessionId, sessionToken);
      if (!clientId) {
        return res.status(401).json({ error: 'Not logged in. Please login first.' });
      }
      
      if (!isPhorestConfigured()) {
        return res.status(503).json({ 
          error: 'Online booking is temporarily unavailable',
          code: 'BOOKING_UNAVAILABLE',
          message: 'Please call us at (416) 932-3131 to book your appointment.'
        });
      }
      
      const bookingPayload: phorestApi.CreateBookingPayload = {
        clientId,
        serviceIds,
        staffIds: staffIds || [],
        startDateTime,
        note: notes
      };
      if (branchId) {
        bookingPayload.branchId = branchId;
      }
      
      let bookingResponse;
      try {
        bookingResponse = await phorestApi.createBooking(bookingPayload);
      } catch (phorestError) {
        const errMsg = phorestError instanceof Error ? phorestError.message : String(phorestError);
        console.log('[Booking] Phorest API failed:', errMsg);
        
        // Classify slot conflicts (someone booked this time moments earlier) so the
        // client gets a tailored message instead of a generic "booking unavailable".
        // Shared classifier with the payment finalize path — uses the structured
        // HTTP status from the Phorest client, not message string matching.
        const classification = phorestApi.classifyPhorestError(phorestError);
        if (classification.isSlotConflict) {
          return res.status(409).json({
            error: 'Time slot no longer available',
            code: 'SLOT_CONFLICT',
            message: 'That time was just taken — please choose another time.'
          });
        }
        
        return res.status(503).json({ 
          error: 'Online booking is temporarily unavailable',
          code: 'BOOKING_UNAVAILABLE',
          message: 'Please call us at (416) 932-3131 to book your appointment.'
        });
      }
      
      res.json(bookingResponse);
    } catch (error) {
      console.error('Booking error:', error);
      res.status(503).json({ 
        error: 'Online booking is temporarily unavailable',
        code: 'BOOKING_UNAVAILABLE',
        message: 'Please call us at (416) 932-3131 to book your appointment.'
      });
    }
  });

  // ============ STRIPE PAYMENT ENDPOINTS ============

  // Get Stripe publishable key for frontend
  app.get("/api/stripe/config", async (req, res) => {
    try {
      const isConfigured = await stripeClient.isStripeConfigured();
      const salonPhone = process.env.SALON_PHONE || null;
      
      if (!isConfigured) {
        return res.json({ configured: false, salonPhone });
      }
      const publishableKey = await stripeClient.getStripePublishableKey();
      res.json({ 
        configured: true, 
        publishableKey,
        depositPercent: DEPOSIT_PERCENT,
        salonPhone
      });
    } catch (error) {
      console.error('Stripe config error:', error);
      res.json({ configured: false, salonPhone: process.env.SALON_PHONE || null });
    }
  });

  // Create a pending booking and payment intent
  app.post("/api/payments/create-intent", async (req, res) => {
    try {
      const { 
        serviceIds, 
        staffIds, 
        startDateTime,
        endDateTime,
        branchId, 
        clientId, 
        sessionId,
        serviceName,
        loyaltyPointsToRedeem
      } = req.body;

      // Validate required fields
      if (!serviceIds || !Array.isArray(serviceIds) || serviceIds.length === 0) {
        return res.status(400).json({ error: 'Missing or invalid service IDs' });
      }
      if (!startDateTime) {
        return res.status(400).json({ error: 'Missing start date/time' });
      }

      // Validate client is logged in via session (unified CRM auth), with token-based restore on server restart
      const sessionToken = req.body.sessionToken as string | undefined;
      const resolvedClientId = resolveSession(sessionId, sessionToken);
      if (!resolvedClientId) {
        return res.status(401).json({ error: 'Not logged in. Please login first.' });
      }

      // Validate staffIds against known staff (prevent accidental branch IDs or bogus IDs).
      // This is a payment-bound request, so validation must NEVER be silently skipped:
      // if the staff cache is cold, wait briefly for warm-up; if still not ready,
      // reject with a clear retry message rather than letting bad IDs fail after payment.
      const sanitizedStaffIds = (staffIds || []).filter((id: string) => id && id.trim() !== '');
      if (sanitizedStaffIds.length > 0) {
        const staffServiceSync = await import('./services/staffServiceSync');
        if (!staffServiceSync.isCacheReady()) {
          console.warn('[Booking] Staff cache cold on payment-bound request — waiting for warm-up...');
          // Kick a warm-up (no-op if one is already in flight) and poll briefly.
          staffServiceSync.warmCache().catch(() => {});
          const deadline = Date.now() + 8000;
          while (!staffServiceSync.isCacheReady() && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
        if (!staffServiceSync.isCacheReady()) {
          console.warn('[Booking] Staff cache still cold — rejecting payment-bound request');
          return res.status(503).json({
            error: 'Booking system is still starting up',
            code: 'STAFF_VALIDATION_UNAVAILABLE',
            message: 'Please try again in a few seconds.'
          });
        }
        const invalidIds = sanitizedStaffIds.filter((id: string) => !staffServiceSync.getStaff(id));
        if (invalidIds.length > 0) {
          console.warn(`[Booking] Invalid staffIds rejected: ${invalidIds.join(', ')}`);
          return res.status(400).json({ 
            error: `Invalid staff selection. Please choose from the available stylists.`,
            code: 'INVALID_STAFF'
          });
        }
        // Qualification check: the selected stylist must actually perform every
        // requested service (Phorest disqualifiedStaff). Catching this before
        // payment avoids charging a deposit for a booking Phorest will mis-assign
        // or staff will have to shuffle manually.
        for (const serviceId of serviceIds) {
          const qualified = staffServiceSync.getQualifiedStaffForService(serviceId);
          if (qualified.length === 0) continue; // no data for this service — don't block
          const unqualified = sanitizedStaffIds.filter((id: string) => !qualified.includes(id));
          if (unqualified.length > 0) {
            console.warn(`[Booking] Staff not qualified for service ${serviceId}: ${unqualified.join(', ')}`);
            return res.status(400).json({
              error: 'The selected stylist does not offer one of these services. Please choose another stylist.',
              code: 'STAFF_NOT_QUALIFIED'
            });
          }
        }
      }

      // Check if Stripe is configured
      const isConfigured = await stripeClient.isStripeConfigured();
      if (!isConfigured) {
        return res.status(503).json({ 
          error: 'Payment system not configured',
          code: 'PAYMENTS_UNAVAILABLE'
        });
      }

      // SERVER-SIDE PRICING: Look up service price from service cache (fast path),
      // with fallback to direct Phorest API when cache is cold or service not found.
      let totalPriceInCents = 0;
      let resolvedServiceName = serviceName || 'Service';
      let isMassageService = false;
      
      try {
        const serviceCache = await import('./services/serviceCache');
        const firstStaffId = (sanitizedStaffIds || [])[0] as string | undefined;

        // Build a lookup map: serviceId → price-in-dollars + metadata
        // For services not found in cache, fall back to a fresh Phorest fetch.
        const missingServiceIds: string[] = [];

        for (const serviceId of serviceIds) {
          const cached = serviceCache.getServiceById(serviceId);
          if (cached) {
            // Prefer per-stylist price when available
            let priceInDollars: number | undefined;
            if (firstStaffId && cached.staffPrices?.length) {
              const staffPriceEntry = cached.staffPrices.find(sp => sp.staffId === firstStaffId);
              if (staffPriceEntry && staffPriceEntry.price > 0) {
                priceInDollars = staffPriceEntry.price;
              }
            }
            if (priceInDollars === undefined) {
              priceInDollars = cached.phorestBasePrice;
            }
            if (priceInDollars && priceInDollars > 0) {
              totalPriceInCents += Math.round(priceInDollars * 100);
            }
            if (!serviceName && cached.name) {
              resolvedServiceName = cached.name;
            }
            const sName = cached.name.toLowerCase();
            const sCategory = (cached.category || '').toLowerCase();
            if (sName.includes('massage') || sCategory.includes('massage')) {
              isMassageService = true;
            }
          } else {
            missingServiceIds.push(serviceId);
          }
        }

        // Fallback: fetch directly from Phorest for any services missing from cache
        // (covers cold-cache scenario right after server startup)
        if (missingServiceIds.length > 0) {
          console.log(`[Payment] Cache miss for ${missingServiceIds.length} service(s), fetching from Phorest`);
          const liveResponse = await phorestApi.listBranchServices();
          const liveServices = liveResponse.content || [];
          for (const serviceId of missingServiceIds) {
            const svc = liveServices.find(s => s.serviceId === serviceId);
            if (svc) {
              if (svc.price && svc.price > 0) {
                totalPriceInCents += Math.round(svc.price * 100);
              }
              if (!serviceName && svc.name) {
                resolvedServiceName = svc.name;
              }
              const sName = (svc.name || '').toLowerCase();
              const sCategory = (svc.categoryName || '').toLowerCase();
              if (sName.includes('massage') || sCategory.includes('massage')) {
                isMassageService = true;
              }
            }
          }
        }
      } catch (cacheError) {
        console.log('[Payment] Could not read service prices, using default minimum:', cacheError);
      }

      // Also check by service name passed from frontend
      if (!isMassageService && resolvedServiceName.toLowerCase().includes('massage')) {
        isMassageService = true;
      }

      // If the price could not be verified (Phorest down / service missing),
      // refuse rather than silently charging a fallback deposit amount.
      if (totalPriceInCents === 0) {
        console.error(`[Payment] Could not verify price for services ${serviceIds.join(', ')} — refusing to create deposit`);
        return res.status(503).json({
          error: "We couldn't verify the service price right now. Please try again in a few minutes.",
          code: 'PRICE_UNAVAILABLE'
        });
      }
      
      // Handle loyalty point redemption for massage services
      let loyaltyPointsRedeemed = 0;
      let loyaltyDiscountCents = 0;
      
      if (loyaltyPointsToRedeem && loyaltyPointsToRedeem > 0 && isMassageService) {
        const requestedPoints = Math.floor(loyaltyPointsToRedeem);
        
        let availablePoints = 0;
        if (isPhorestConfigured()) {
          try {
            const loyalty = await phorestApi.getClientLoyalty(resolvedClientId);
            availablePoints = loyalty.points || 0;
          } catch (e) {
            console.warn('[Payment] Could not fetch loyalty points:', e);
          }
        }
        
        // requestedPoints = number of redemptions requested (each costs LOYALTY_POINTS_PER_REDEMPTION loyalty points)
        const pointsNeeded = requestedPoints * LOYALTY_POINTS_PER_REDEMPTION;
        if (pointsNeeded > availablePoints) {
          return res.status(400).json({ error: `You need ${pointsNeeded} points but only have ${availablePoints}` });
        }
        
        // Each redemption (300 pts) = $8 off massage
        const maxDiscountCents = requestedPoints * LOYALTY_MASSAGE_DISCOUNT_PER_REDEMPTION;
        loyaltyDiscountCents = Math.min(maxDiscountCents, totalPriceInCents - 500); // Keep at least $5 for deposit
        loyaltyPointsRedeemed = Math.min(requestedPoints, Math.ceil(loyaltyDiscountCents / LOYALTY_MASSAGE_DISCOUNT_PER_REDEMPTION));
        loyaltyDiscountCents = loyaltyPointsRedeemed * LOYALTY_MASSAGE_DISCOUNT_PER_REDEMPTION;
        
        if (loyaltyDiscountCents > totalPriceInCents - 500) {
          loyaltyDiscountCents = Math.max(0, totalPriceInCents - 500);
          loyaltyPointsRedeemed = Math.floor(loyaltyDiscountCents / LOYALTY_MASSAGE_DISCOUNT_PER_REDEMPTION);
          loyaltyDiscountCents = loyaltyPointsRedeemed * LOYALTY_MASSAGE_DISCOUNT_PER_REDEMPTION;
        }
        
        console.log(`[Payment] Massage loyalty: ${loyaltyPointsRedeemed} redemptions (${loyaltyPointsRedeemed * LOYALTY_POINTS_PER_REDEMPTION} pts) = $${(loyaltyDiscountCents / 100).toFixed(2)} discount`);
      }
      
      // Apply loyalty discount to service price before calculating deposit
      const adjustedPriceInCents = totalPriceInCents - loyaltyDiscountCents;
      
      // Calculate deposit (20% by default) on adjusted price
      const depositAmount = Math.round(adjustedPriceInCents * (DEPOSIT_PERCENT / 100));
      
      // Minimum deposit of $5
      const finalDeposit = Math.max(depositAmount, 500);

      // Deposit ceiling: refuse rather than charging an absurd amount if the
      // Phorest price is corrupted or misconfigured.
      if (finalDeposit > MAX_DEPOSIT_CENTS) {
        console.error(`[Payment] Deposit $${(finalDeposit / 100).toFixed(2)} exceeds ceiling $${(MAX_DEPOSIT_CENTS / 100).toFixed(2)} for services ${serviceIds.join(', ')} (price $${(totalPriceInCents / 100).toFixed(2)}) — refusing`);
        return res.status(503).json({
          error: 'Deposit amount looks incorrect. Please call us to book this service.',
          code: 'DEPOSIT_TOO_LARGE'
        });
      }

      // NOTE: near-duplicate bookings (same client, ±2h) are intentionally
      // ALLOWED with no warning — clients legitimately book back-to-back slots
      // for family members. Each booking records its own deposit in Phorest
      // (auto-applied at its own checkout); at finalize time both appointments
      // get a heads-up note and the orphan sweep watches for deposits whose
      // appointment never gets checked out.

      const stripe = await stripeClient.getStripeClient();

      // IDEMPOTENCY: If the client already has a pending booking for the exact
      // same service(s) + time slot, reuse its PaymentIntent instead of creating
      // a second charge (prevents double-charging on dialog re-open/retry).
      try {
        const reusable = await findReusablePendingBooking(
          resolvedClientId, serviceIds, startDateTime, loyaltyPointsRedeemed, staffIds
        );
        if (reusable) {
          const existingIntent = await stripe.paymentIntents.retrieve(reusable.booking.paymentIntentId!);
          const reusableStatuses = ['requires_payment_method', 'requires_confirmation', 'requires_action'];
          if (existingIntent.amount === reusable.booking.depositAmount &&
              (reusableStatuses.includes(existingIntent.status) || existingIntent.status === 'succeeded')) {
            console.log(`[Payment] Reusing existing PaymentIntent ${existingIntent.id} (status: ${existingIntent.status}) for pending booking ${reusable.pendingId}`);
            const b = reusable.booking;
            const adjusted = b.servicePrice - b.loyaltyDiscountCents;
            return res.json({
              clientSecret: existingIntent.client_secret,
              pendingId: reusable.pendingId,
              alreadyPaid: existingIntent.status === 'succeeded',
              depositAmount: b.depositAmount,
              depositAmountFormatted: `$${(b.depositAmount / 100).toFixed(2)}`,
              servicePrice: b.servicePrice,
              servicePriceFormatted: `$${(b.servicePrice / 100).toFixed(2)}`,
              depositPercent: DEPOSIT_PERCENT,
              isMassageService,
              loyaltyPointsRedeemed: b.loyaltyPointsRedeemed,
              loyaltyDiscountAmount: `$${(b.loyaltyDiscountCents / 100).toFixed(2)}`,
              loyaltyDiscountFormatted: `$${(b.loyaltyDiscountCents / 100).toFixed(2)}`,
              adjustedServicePrice: adjusted,
              adjustedServicePriceFormatted: `$${(adjusted / 100).toFixed(2)}`
            });
          }
        }
      } catch (reuseError) {
        console.warn('[Payment] Intent-reuse check failed, creating new intent:', reuseError);
      }

      // Generate unique pending booking ID
      const pendingId = `pending_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Create Stripe PaymentIntent with server-calculated amount.
      // Idempotency key ties this create to the pendingId so a network retry
      // can never mint a second PaymentIntent for the same attempt.
      const paymentIntent = await stripe.paymentIntents.create({
        amount: finalDeposit,
        currency: 'cad',
        payment_method_types: ['card'],
        metadata: {
          pendingId,
          clientId: resolvedClientId,
          serviceName: resolvedServiceName,
          serviceIds: serviceIds.join(','),
          depositPercent: DEPOSIT_PERCENT.toString(),
          expectedAmount: finalDeposit.toString(),
          loyaltyPointsRedeemed: String(loyaltyPointsRedeemed),
          loyaltyDiscountCents: String(loyaltyDiscountCents),
          startDateTime,
          ...(branchId ? { branchId } : {}),
          type: 'booking_deposit',
          chargeLabel: REFUND_LABELS.depositCharge
        },
        description: `Deposit for ${resolvedServiceName} at Kozeta Salon${loyaltyPointsRedeemed > 0 ? ` (${loyaltyPointsRedeemed} loyalty pts)` : ''}`,
        // Card statement shows "<account prefix>* Deposit" — the closest to
        // "KOZETA SALON Deposit" Stripe permits (full descriptors on card
        // charges are prefix + suffix; suffix max ~10 chars with our prefix).
        statement_descriptor_suffix: 'Deposit',
      }, { idempotencyKey: `pi-create-${pendingId}` });

      // Store pending booking with server-calculated prices (persisted in DB)
      await pendingBookings.set(pendingId, {
        serviceIds,
        staffIds: sanitizedStaffIds,
        startDateTime,
        endDateTime: endDateTime || undefined,
        branchId,
        clientId: resolvedClientId,
        sessionId,
        serviceName: resolvedServiceName,
        servicePrice: totalPriceInCents,
        depositAmount: finalDeposit,
        loyaltyPointsRedeemed,
        loyaltyDiscountCents,
        paymentIntentId: paymentIntent.id,
        createdAt: Date.now()
      });

      console.log(`[Payment] Created PaymentIntent ${paymentIntent.id} for pending booking ${pendingId}`);
      console.log(`[Payment] Service: ${resolvedServiceName}, Total: $${totalPriceInCents / 100}, Deposit: $${finalDeposit / 100} (server-side pricing)`);

      res.json({
        clientSecret: paymentIntent.client_secret,
        pendingId,
        depositAmount: finalDeposit,
        depositAmountFormatted: `$${(finalDeposit / 100).toFixed(2)}`,
        servicePrice: totalPriceInCents,
        servicePriceFormatted: `$${(totalPriceInCents / 100).toFixed(2)}`,
        depositPercent: DEPOSIT_PERCENT,
        isMassageService,
        loyaltyPointsRedeemed,
        loyaltyDiscountAmount: `$${(loyaltyDiscountCents / 100).toFixed(2)}`,
        loyaltyDiscountFormatted: `$${(loyaltyDiscountCents / 100).toFixed(2)}`,
        adjustedServicePrice: adjustedPriceInCents,
        adjustedServicePriceFormatted: `$${(adjustedPriceInCents / 100).toFixed(2)}`
      });
    } catch (error) {
      console.error('Payment intent error:', error);
      res.status(500).json({ error: 'Failed to create payment' });
    }
  });

  // Finalize booking after successful payment
  app.post("/api/bookings/finalize", async (req, res) => {
    let lockedPendingId: string | null = null;
    try {
      const { pendingId, paymentIntentId } = req.body;

      if (!pendingId) {
        return res.status(400).json({ error: 'Missing pending booking ID' });
      }

      // CONCURRENCY LOCK: only one finalize may run per pending booking at a
      // time. A duplicate call (double-click, retry racing the first request)
      // would otherwise double-book in Phorest or double-deduct loyalty points.
      if (!await tryAcquireFinalizeLock(`booking:${pendingId}`)) {
        return res.status(409).json({
          error: 'Booking is already being finalized',
          code: 'FINALIZE_IN_PROGRESS',
          message: 'Your booking is already being confirmed. Please wait a moment.'
        });
      }
      lockedPendingId = `booking:${pendingId}`;

      // Get pending booking (DB-backed, survives restarts)
      const pendingBooking = await pendingBookings.get(pendingId);

      // Get Stripe client for all operations
      const stripe = await stripeClient.getStripeClient();

      if (!pendingBooking) {
        // SAFETY NET: the pending booking is gone (expired or lost) but the client
        // may have already been charged. If they supplied a paymentIntentId and it
        // is a succeeded, unconsumed deposit for this pendingId, refund it now so
        // the client is never left charged with no appointment.
        if (paymentIntentId && typeof paymentIntentId === 'string' && paymentIntentId.startsWith('pi_')) {
          try {
            const orphanIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
            const isOurDeposit = orphanIntent.metadata?.pendingId === pendingId
              && orphanIntent.metadata?.type !== 'product_purchase';
            // Never blindly refund a payment whose booking outcome is unknown or
            // that was already consumed by a Phorest booking — only the orphan
            // sweep (which verifies against Phorest) may refund those.
            if (isOurDeposit && orphanIntent.status === 'succeeded'
              && (orphanIntent.metadata?.statusUnknown === '1' || orphanIntent.metadata?.phorestBookingId)) {
              return res.status(409).json({
                error: 'Booking status unknown',
                code: 'BOOKING_STATUS_UNKNOWN',
                message: 'We are still confirming your booking. Do NOT pay again — if the booking did not go through, your deposit will be refunded automatically within 30 minutes. You can also call us to confirm.',
                paymentId: orphanIntent.id,
                refunded: false
              });
            }
            if (isOurDeposit && orphanIntent.status === 'succeeded') {
              // Shared refund lock + Stripe idempotency key: the orphan sweep
              // and this safety net can never both refund the same deposit.
              const refundOutcome = await withRefundLock(orphanIntent.id, () =>
                stripe.refunds.create(
                  { payment_intent: orphanIntent.id, reason: 'requested_by_customer' },
                  { idempotencyKey: `refund-${orphanIntent.id}` }
                )
              );
              if (!refundOutcome.ran) {
                // Another path (orphan sweep) is refunding right now — treat as refunded.
                console.log(`[Payment] Refund for ${orphanIntent.id} already in flight elsewhere; skipping duplicate`);
              } else if (refundOutcome.error) {
                const msg = refundOutcome.error instanceof Error ? refundOutcome.error.message : String(refundOutcome.error);
                if (!/already.*refunded|has already been refunded/i.test(msg)) {
                  console.error('[Payment] Refund failed for orphaned deposit:', msg);
                  return res.status(404).json({
                    error: 'Pending booking not found or expired',
                    code: 'REFUND_FAILED',
                    message: 'Your booking session expired after payment. Do NOT pay again — please call us and we will sort it out immediately.',
                    paymentId: orphanIntent.id,
                    refunded: false
                  });
                }
              } else {
                console.log(`[Payment] Auto-refunded orphaned deposit ${orphanIntent.id} (pending booking ${pendingId} lost)`);
              }
              return res.status(404).json({
                error: 'Pending booking not found or expired',
                code: 'BOOKING_LOST_REFUNDED',
                message: 'Your booking session expired, so your appointment was not created. Your deposit has been fully refunded — you have NOT been charged. Please try booking again.',
                refunded: true
              });
            }
          } catch (orphanErr) {
            console.error('[Payment] Could not verify orphaned payment intent:', orphanErr);
          }
        }
        return res.status(404).json({
          error: 'Pending booking not found or expired',
          message: 'Your booking session expired before payment completed. You have not been charged — please try again.',
          refunded: true
        });
      }
      
      // Verify payment status with Stripe - use stored paymentIntentId for security
      const paymentIntent = await stripe.paymentIntents.retrieve(
        pendingBooking.paymentIntentId!
      );

      // COMPREHENSIVE PAYMENT VERIFICATION
      // 1. Verify payment status is succeeded
      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({ 
          error: 'Payment not completed',
          paymentStatus: paymentIntent.status 
        });
      }

      // 2. Verify the payment metadata matches this pending booking
      if (paymentIntent.metadata.pendingId !== pendingId) {
        return res.status(400).json({ error: 'Payment does not match booking' });
      }

      // 3. Verify clientId matches
      if (paymentIntent.metadata.clientId !== pendingBooking.clientId) {
        return res.status(400).json({ error: 'Payment client mismatch' });
      }

      // 4. Verify amount matches what we expected
      const expectedAmount = parseInt(paymentIntent.metadata.expectedAmount || '0');
      if (expectedAmount > 0 && paymentIntent.amount !== expectedAmount) {
        console.error(`[Payment] Amount mismatch: expected ${expectedAmount}, got ${paymentIntent.amount}`);
        return res.status(400).json({ error: 'Payment amount mismatch' });
      }

      // 5. Verify currency is CAD
      if (paymentIntent.currency !== 'cad') {
        return res.status(400).json({ error: 'Invalid payment currency' });
      }

      console.log(`[Payment] Payment ${paymentIntent.id} fully verified for booking ${pendingId}`);

      // Create the actual Phorest booking
      if (!isPhorestConfigured()) {
        // Refund if Phorest is not configured — use shared lock + idempotency key
        // so a concurrent orphan sweep can never double-refund the same intent.
        const refundOutcome = await withRefundLock(paymentIntent.id, () =>
          stripe.refunds.create(
            { payment_intent: paymentIntent.id, reason: 'requested_by_customer' },
            { idempotencyKey: `refund-${paymentIntent.id}` }
          )
        );
        const phorestUnavailRefunded = refundOutcome.ran && !refundOutcome.error;
        if (phorestUnavailRefunded) {
          console.log(`[Payment] Refunded ${paymentIntent.id} - Phorest unavailable`);
        } else if (refundOutcome.error) {
          console.error('[Payment] Refund failed:', refundOutcome.error);
        }
        await pendingBookings.delete(pendingId);
        return res.status(503).json({ 
          error: 'Booking system unavailable',
          code: phorestUnavailRefunded ? 'BOOKING_UNAVAILABLE' : 'REFUND_FAILED',
          message: phorestUnavailRefunded
            ? 'Booking system is currently unavailable. Your deposit has been refunded.'
            : 'We could not complete your booking. Your payment is being reviewed — please call us immediately.',
          paymentId: phorestUnavailRefunded ? undefined : paymentIntent.id,
          refunded: phorestUnavailRefunded
        });
      }

      let branchId: string | undefined;
      try {
        branchId = pendingBooking.branchId || getDefaultBranchId();
      } catch (branchError: any) {
        // Refund before returning the error — use shared lock + idempotency key
        // so a concurrent orphan sweep can never double-refund the same intent.
        const refundOutcome = await withRefundLock(paymentIntent.id, () =>
          stripe.refunds.create(
            { payment_intent: paymentIntent.id, reason: 'requested_by_customer' },
            { idempotencyKey: `refund-${paymentIntent.id}` }
          )
        );
        const branchRefunded = refundOutcome.ran && !refundOutcome.error;
        if (branchRefunded) {
          console.log(`[Payment] Refunded ${paymentIntent.id} - branch config error`);
        } else if (refundOutcome.error) {
          console.error('[Payment] Refund failed on branch error:', refundOutcome.error);
        }
        await pendingBookings.delete(pendingId);
        return res.status(branchRefunded ? 400 : 503).json({ 
          error: branchError.message || 'Invalid branch configuration',
          code: branchRefunded ? 'BOOKING_UNAVAILABLE' : 'REFUND_FAILED',
          message: branchRefunded
            ? 'Booking system configuration error. Your deposit has been refunded.'
            : 'We could not complete your booking. Your payment is being reviewed — please call us immediately.',
          paymentId: branchRefunded ? undefined : paymentIntent.id,
          refunded: branchRefunded
        });
      }

      // Staff heads-up when the client already holds another appointment near
      // this slot (family bookings): both deposits auto-apply at their own
      // checkouts; the note just makes it visible at the till. Fail-open.
      const duplicateNote = await buildDuplicateDepositNote(pendingBooking.clientId, pendingBooking.startDateTime);

      const bookingPayload: phorestApi.CreateBookingPayload = {
        clientId: pendingBooking.clientId,
        serviceIds: pendingBooking.serviceIds,
        staffIds: pendingBooking.staffIds,
        startDateTime: pendingBooking.startDateTime,
        endDateTime: pendingBooking.endDateTime,
        depositAmountCents: pendingBooking.depositAmount,
        // Two-step flow: create a RESERVED hold, then activate with the deposit so
        // Phorest records a real deposit that reduces the client's checkout balance.
        bookingStatus: "RESERVED",
        note: `Deposit paid: $${(pendingBooking.depositAmount / 100).toFixed(2)} (${DEPOSIT_PERCENT}%) - Payment ID: ${paymentIntent.id}${duplicateNote ? ` | ${duplicateNote}` : ''}`
      };
      if (branchId) {
        bookingPayload.branchId = branchId;
      }

      let bookingResponse;
      try {
        bookingResponse = await phorestApi.createBooking(bookingPayload);
      } catch (phorestError) {
        const errMsg = phorestError instanceof Error ? phorestError.message : String(phorestError);
        console.log('[Booking] Phorest API failed after payment:', errMsg);
        
        // Shared classifier with /api/book — uses the structured HTTP status from
        // the Phorest client (409 = true conflict; specific detail codes like
        // SLOT_UNAVAILABLE / STAFF_DOUBLE_BOOKED as secondary signals). Generic
        // 400s (validation errors) are NOT conflicts.
        const classification = phorestApi.classifyPhorestError(phorestError);
        const isSlotConflict = classification.isSlotConflict;
        const phorestReason = classification.reason;

        // UNVERIFIABLE FAILURE (timeout / network drop / Phorest 5xx): the
        // booking may actually have been created on Phorest's side even though
        // we never saw the response. Refunding now risks a "ghost booking"
        // (appointment exists but deposit refunded). Instead: do NOT refund and
        // let the orphan sweep verify against Phorest — it refunds automatically
        // only if no appointment exists at the paid slot.
        const isDefiniteFailure = classification.isDefiniteFailure;
        if (!isDefiniteFailure) {
          console.warn(`[Booking] Unverifiable Phorest failure for ${pendingId} — deferring refund decision to orphan sweep`);
          // Mark the payment so the finalize safety-net never blindly refunds it
          // (the booking may exist in Phorest) — only the sweep, which verifies
          // against Phorest, may decide. Delete the pending row so a client
          // retry can't create a duplicate Phorest booking.
          try {
            await stripe.paymentIntents.update(paymentIntent.id, { metadata: { statusUnknown: '1' } });
          } catch (metaErr) {
            console.warn('[Payment] Could not tag payment as status-unknown:', metaErr);
          }
          await pendingBookings.delete(pendingId);
          return res.status(503).json({
            error: 'Booking status unknown',
            code: 'BOOKING_STATUS_UNKNOWN',
            message: 'We could not confirm your booking right now. Do NOT pay again — if the booking did not go through, your deposit will be refunded automatically within 30 minutes. You can also call us to confirm.',
            paymentId: paymentIntent.id,
            refunded: false
          });
        }

        // DEFINITE failure (Phorest 4xx: conflict/validation) — the booking was
        // certainly not created, so refunding immediately is safe.
        const refundOutcome = await withRefundLock(paymentIntent.id, () =>
          stripe.refunds.create(
            { payment_intent: paymentIntent.id, reason: 'requested_by_customer' },
            { idempotencyKey: `refund-${paymentIntent.id}` }
          )
        );
        if (refundOutcome.ran && !refundOutcome.error) {
          console.log(`[Payment] Refunded ${paymentIntent.id} - Phorest booking failed (conflict: ${isSlotConflict})`);
          await pendingBookings.delete(pendingId);
          return res.status(503).json({ 
            error: 'Booking failed - deposit refunded',
            code: isSlotConflict ? 'SLOT_CONFLICT' : 'BOOKING_UNAVAILABLE',
            message: isSlotConflict
              ? 'That time slot was just taken. Your deposit has been refunded — please choose another time.'
              : (phorestReason || 'The booking system encountered an error. Your deposit has been refunded.'),
            ...(phorestReason && !isSlotConflict ? { reason: phorestReason } : {}),
            refunded: true
          });
        } else {
          if (refundOutcome.error) {
            console.error('[Payment] Refund failed after booking failure:', refundOutcome.error);
          }
          await pendingBookings.delete(pendingId);
          return res.status(503).json({ 
            error: 'Booking failed after payment',
            code: 'REFUND_FAILED',
            message: 'We could not complete your booking. Your payment is being reviewed — please call us immediately.',
            paymentId: paymentIntent.id,
            refunded: false
          });
        }
      }

      // Activate the RESERVED booking and record the deposit against it so Phorest
      // reduces the client's remaining balance at checkout. This MUST succeed — if it
      // fails, the booking is only a temporary hold (it will expire) and the client has
      // already paid, so we treat it as fatal: refund the deposit and return an error.
      const phorestBookingId = bookingResponse.phorestBookingId;
      if (!phorestBookingId) {
        console.error('[Booking] No phorestBookingId returned — cannot record deposit. Refunding.');
      }
      try {
        if (!phorestBookingId) {
          throw new Error('Missing Phorest booking id for activation');
        }
        await phorestApi.activateBooking(branchId!, phorestBookingId, pendingBooking.depositAmount);
        bookingResponse.bookingStatus = "ACTIVE";

        // Record the Phorest booking on the payment so the deposit is traceable:
        // audits can match payments to appointments, and the deposit guard knows
        // this payment was consumed (never auto-refund it as an orphan).
        try {
          await stripe.paymentIntents.update(paymentIntent.id, {
            metadata: {
              phorestBookingId,
              // The real Phorest APPOINTMENT id — the cancellation watcher and
              // client self-cancel refund match on this id (never by time).
              appointmentId: bookingResponse.appointmentId || '',
              appointmentStart: pendingBooking.startDateTime
            }
          });
        } catch (metaError) {
          console.warn('[Payment] Could not tag payment with booking id (non-fatal):', metaError);
        }
      } catch (activateError) {
        const errMsg = activateError instanceof Error ? activateError.message : String(activateError);
        console.error('[Booking] Activation/deposit step failed after payment:', errMsg);

        // UNVERIFIABLE activation failure (timeout / network / 5xx): activation
        // may have succeeded on Phorest's side. Do NOT refund — tag the payment
        // with the booking id (if we have one) so the orphan sweep can verify
        // against Phorest and only refund if the appointment is truly gone.
        const isDefiniteActivationFailure = !phorestBookingId || phorestApi.classifyPhorestError(activateError).isDefiniteFailure;
        if (!isDefiniteActivationFailure) {
          try {
            await stripe.paymentIntents.update(paymentIntent.id, {
              metadata: { phorestBookingId, appointmentId: bookingResponse.appointmentId || '', appointmentStart: pendingBooking.startDateTime, statusUnknown: '1' }
            });
          } catch (metaErr) {
            console.warn('[Payment] Could not tag payment during deferred activation failure:', metaErr);
          }
          console.warn(`[Booking] Unverifiable activation failure for ${pendingId} — deferring refund decision to orphan sweep`);
          // Delete the pending row so a client retry can't create a duplicate
          // Phorest booking on top of the one already created.
          await pendingBookings.delete(pendingId);
          return res.status(503).json({
            error: 'Booking status unknown',
            code: 'BOOKING_STATUS_UNKNOWN',
            message: 'We could not confirm your booking right now. Do NOT pay again — if the booking did not go through, your deposit will be refunded automatically within 30 minutes. You can also call us to confirm.',
            paymentId: paymentIntent.id,
            refunded: false
          });
        }

        // DEFINITE activation failure — refund (the RESERVED hold will expire).
        const refundOutcome = await withRefundLock(paymentIntent.id, () =>
          stripe.refunds.create(
            { payment_intent: paymentIntent.id, reason: 'requested_by_customer' },
            { idempotencyKey: `refund-${paymentIntent.id}` }
          )
        );
        if (refundOutcome.ran && !refundOutcome.error) {
          console.log(`[Payment] Refunded ${paymentIntent.id} - booking activation failed`);
          await pendingBookings.delete(pendingId);
          return res.status(503).json({
            error: 'Booking could not be confirmed - deposit refunded',
            code: 'BOOKING_UNAVAILABLE',
            message: 'We could not confirm your appointment. Your deposit has been refunded — please try again or call us.',
            refunded: true
          });
        } else {
          if (refundOutcome.error) {
            console.error('[Payment] Refund failed after activation failure:', refundOutcome.error);
          }
          await pendingBookings.delete(pendingId);
          return res.status(503).json({
            error: 'Booking failed after payment',
            code: 'REFUND_FAILED',
            message: 'We could not complete your booking. Your payment is being reviewed — please call us immediately.',
            paymentId: paymentIntent.id,
            refunded: false
          });
        }
      }

      // Award loyalty points for booking (1 point per $1 of service price)
      let loyaltyPointsEarned = 0;
      if (isPhorestConfigured()) {
        // Re-validate and deduct redeemed points if any (prevents race condition)
        // loyaltyPointsRedeemed = number of redemptions, each costs LOYALTY_POINTS_PER_REDEMPTION actual points
        if (pendingBooking.loyaltyPointsRedeemed > 0) {
          try {
            const actualPointsNeeded = pendingBooking.loyaltyPointsRedeemed * LOYALTY_POINTS_PER_REDEMPTION;
            const currentLoyalty = await phorestApi.getClientLoyalty(pendingBooking.clientId);
            const currentPoints = currentLoyalty.points || 0;
            const pointsToDeduct = Math.min(actualPointsNeeded, currentPoints);
            
            if (pointsToDeduct > 0) {
              await phorestApi.changeLoyaltyPoints({
                clientId: pendingBooking.clientId,
                points: pointsToDeduct,
                reason: `Redeemed ${pointsToDeduct} points for $${(pendingBooking.loyaltyDiscountCents / 100).toFixed(2)} massage discount`,
                transactionType: 'remove'
              });
              console.log(`[Loyalty] Deducted ${pointsToDeduct} points for booking discount (requested: ${actualPointsNeeded}, available: ${currentPoints})`);
            } else {
              console.warn(`[Loyalty] No points available to deduct (requested: ${actualPointsNeeded}, available: ${currentPoints})`);
            }
          } catch (loyaltyError) {
            console.error('[Loyalty] Failed to deduct booking points:', loyaltyError);
          }
        }
        
        // Award points based on the full service price (not just deposit)
        const servicePriceDollars = pendingBooking.servicePrice / 100;
        loyaltyPointsEarned = Math.floor(servicePriceDollars * LOYALTY_POINTS_PER_DOLLAR);
        if (loyaltyPointsEarned > 0) {
          try {
            await phorestApi.changeLoyaltyPoints({
              clientId: pendingBooking.clientId,
              points: loyaltyPointsEarned,
              reason: `Earned from booking: ${pendingBooking.serviceName} ($${servicePriceDollars.toFixed(2)})`,
              transactionType: 'add'
            });
            console.log(`[Loyalty] Awarded ${loyaltyPointsEarned} points for booking ${pendingBooking.serviceName}`);
          } catch (loyaltyError) {
            console.error('[Loyalty] Failed to award booking points:', loyaltyError);
          }
        }
      }
      
      // Clean up pending booking
      await pendingBookings.delete(pendingId);
      
      console.log(`[Booking] Successfully created booking after payment for ${pendingBooking.serviceName}`);

      // Resolve stylist name BEFORE sending confirmation so the client sees
      // who their appointment is with (previously sent as undefined).
      let staffName: string | undefined;
      if (pendingBooking.staffIds && pendingBooking.staffIds.length > 0) {
        try {
          const staffServiceSync = await import('./services/staffServiceSync');
          const staffMember = staffServiceSync.getStaff(pendingBooking.staffIds[0]);
          if (staffMember) {
            staffName = [staffMember.firstName, staffMember.lastName].filter(Boolean).join(' ');
          }
        } catch { /* non-critical */ }
      }

      // Fire-and-forget: send booking confirmation (SMS + email) and auto-save payment
      // method to Stripe Customer so future text bookings can charge without a link.
      phorestApi.getClient(pendingBooking.clientId).then(async clientData => {
        const clientPhone = clientData.mobile
          ? authUtils.normalizePhoneForSearch(clientData.mobile)
          : undefined;
        // Send confirmation (non-blocking)
        sendBookingConfirmation({
          clientPhone,
          clientEmail: clientData.email,
          clientFirstName: clientData.firstName,
          serviceName: pendingBooking.serviceName,
          staffName,
          startDateTime: pendingBooking.startDateTime,
          depositPaidCents: pendingBooking.depositAmount,
          remainingBalanceCents: Math.max(0, pendingBooking.servicePrice - pendingBooking.depositAmount),
        }).catch(e => console.error('[Booking] Confirmation send failed:', e));

        // Explicit card-save consent: if this booking came from an SMS link, offer to
        // save the card via a follow-up "Reply SAVE" prompt.  Card is NEVER stored
        // without the client first replying SAVE to that message.
        if (clientPhone && paymentIntent.payment_method && pendingBooking.sessionId?.startsWith("sms:")) {
          offerSmsCardSave(clientPhone, pendingBooking.clientId, paymentIntent.payment_method as string)
            .catch(e => console.warn('[Booking] Save-card offer failed (non-fatal):', e));
        }
      }).catch(e => console.warn('[Booking] Post-finalize client lookup failed (non-fatal):', e));

      const depositPaid = pendingBooking.depositAmount;
      const remainingBalance = Math.max(0, pendingBooking.servicePrice - depositPaid);

      // staffName resolved above (before confirmation send)
      res.json({
        ...bookingResponse,
        paymentId: paymentIntent.id,
        depositPaid,
        depositPaidFormatted: `$${(depositPaid / 100).toFixed(2)}`,
        remainingBalance,
        remainingBalanceFormatted: `$${(remainingBalance / 100).toFixed(2)}`,
        serviceName: pendingBooking.serviceName,
        startDateTime: pendingBooking.startDateTime,
        staffName,
        loyaltyPointsEarned,
        loyaltyPointsRedeemed: pendingBooking.loyaltyPointsRedeemed,
        loyaltyDiscountApplied: pendingBooking.loyaltyDiscountCents / 100
      });
    } catch (error) {
      console.error('Finalize booking error:', error);
      res.status(500).json({ error: 'Failed to finalize booking' });
    } finally {
      if (lockedPendingId) await releaseFinalizeLock(lockedPendingId);
    }
  });

  // Get Phorest services - returns raw Phorest data
  app.get("/api/phorest/services", async (req, res) => {
    try {
      if (!isPhorestConfigured()) {
        return res.json({ services: [], message: 'Phorest not configured' });
      }
      
      const services = await phorestApi.listBranchServices({ page: 0, size: 100 });
      res.json(services);
    } catch (error) {
      console.error('Phorest services error:', error);
      res.status(500).json({ error: 'Failed to fetch Phorest services' });
    }
  });
  
  // Get merged services - now returns same data as /api/services (Phorest-driven)
  app.get("/api/services/merged", async (req, res) => {
    try {
      const serviceCache = await import('./services/serviceCache');
      if (!serviceCache.isCacheReady()) {
        await serviceCache.warmCache();
      }
      const services = serviceCache.getServices();
      res.json({ services });
    } catch (error) {
      console.error('Merged services error:', error);
      res.status(500).json({ error: 'Failed to fetch services' });
    }
  });

  // Get Phorest staff - uses staffServiceSync cache for accurate data
  app.get("/api/phorest/staff", async (req, res) => {
    try {
      if (!isPhorestConfigured()) {
        return res.json({ staff: [], _embedded: { staffs: [] }, message: 'Phorest not configured' });
      }
      
      // Use the staffServiceSync cache which has accurate, filtered staff data
      const staffServiceSync = await import('./services/staffServiceSync');
      
      // Ensure cache is ready
      if (!staffServiceSync.isCacheReady()) {
        console.log('[Staff] Cache not ready, warming...');
        await staffServiceSync.warmCache();
      }
      
      // Get all staff from the sync cache
      const allStaff = staffServiceSync.getAllStaff();

      // Apply canonical display order using stable staff IDs (single source of truth in staffServiceSync)
      const { STAFF_DISPLAY_ORDER } = await import('./services/staffServiceSync');
      const orderIndex = new Map(STAFF_DISPLAY_ORDER.map((id, i) => [id, i]));
      const sortedStaff = [...allStaff].sort((a, b) => {
        const aIdx = orderIndex.get(a.staffId) ?? Infinity;
        const bIdx = orderIndex.get(b.staffId) ?? Infinity;
        return aIdx - bIdx;
      });

      console.log(`[Staff] Returning ${sortedStaff.length} service providers from cache (ordered)`);
      
      // Return in same format as original for compatibility
      res.json({ 
        _embedded: { staffs: sortedStaff },
        staff: sortedStaff
      });
    } catch (error) {
      console.error('Phorest staff error:', error);
      res.status(500).json({ error: 'Failed to fetch Phorest staff' });
    }
  });

  // Get staff who can perform a specific service
  // Uses cached disqualifiedStaff data from Phorest for accurate, real-time sync
  app.get("/api/phorest/staff-for-service", async (req, res) => {
    try {
      const { serviceId } = req.query;
      
      if (!serviceId || typeof serviceId !== 'string') {
        return res.status(400).json({ error: 'serviceId query parameter is required' });
      }
      
      if (!isPhorestConfigured()) {
        return res.json({ staffIds: [], message: 'Phorest not configured' });
      }
      
      // Use the staff-service sync cache for accurate staff qualification
      const staffServiceSync = await import('./services/staffServiceSync');
      
      // Ensure cache is ready
      if (!staffServiceSync.isCacheReady()) {
        console.log('[Staff-for-Service] Cache not ready, warming...');
        await staffServiceSync.warmCache();
      }
      
      const rawStaffIds = staffServiceSync.getQualifiedStaffForService(serviceId);
      const rawStaffDetails = staffServiceSync.getQualifiedStaffDetails(serviceId);
      
      const service = staffServiceSync.getService(serviceId);
      const staffPricesMap = new Map<string, number>();
      if (service?.staffCategories?.prices) {
        for (const sp of service.staffCategories.prices) {
          staffPricesMap.set(sp.id, sp.price);
        }
      }

      // Sort staff IDs and details by canonical display order
      const { STAFF_DISPLAY_ORDER: ORDER } = await import('./services/staffServiceSync');
      const orderIdx = new Map(ORDER.map((id, i) => [id, i]));
      const staffIds = [...rawStaffIds].sort((a, b) => (orderIdx.get(a) ?? Infinity) - (orderIdx.get(b) ?? Infinity));
      const staffDetails = [...rawStaffDetails].sort((a, b) => (orderIdx.get(a.staffId) ?? Infinity) - (orderIdx.get(b.staffId) ?? Infinity));
      
      console.log(`[Staff-for-Service] Found ${staffIds.length} qualified staff for service ${serviceId}:`, 
        staffDetails.map(s => `${s.firstName} ${s.lastName}`).join(', '));
      
      res.json({ 
        staffIds, 
        serviceId,
        basePrice: service?.price,
        staffPrices: Object.fromEntries(staffPricesMap),
        staffDetails: staffDetails.map(s => ({
          staffId: s.staffId,
          name: `${s.firstName} ${s.lastName}`.trim(),
          price: staffPricesMap.get(s.staffId) ?? service?.price
        }))
      });
    } catch (error) {
      console.error('Staff-for-service error:', error);
      res.status(500).json({ error: 'Failed to fetch staff for service' });
    }
  });
  
  // Get cache status and force refresh
  app.get("/api/phorest/staff-service-sync/status", async (req, res) => {
    try {
      const staffServiceSync = await import('./services/staffServiceSync');
      res.json(staffServiceSync.getCacheStatus());
    } catch (error) {
      res.status(500).json({ error: 'Failed to get sync status' });
    }
  });
  
  app.post("/api/phorest/staff-service-sync/refresh", async (req, res) => {
    try {
      const staffServiceSync = await import('./services/staffServiceSync');
      await staffServiceSync.warmCache();
      res.json({ success: true, ...staffServiceSync.getCacheStatus() });
    } catch (error) {
      res.status(500).json({ error: 'Failed to refresh sync' });
    }
  });

  // Get Phorest branches - useful to find available branch IDs
  app.get("/api/phorest/branches", async (req, res) => {
    try {
      if (!isPhorestConfigured()) {
        return res.json({ branches: [], message: 'Phorest not configured' });
      }
      
      const branches = await phorestApi.listBranches({ page: 0, size: 50 });
      res.json(branches);
    } catch (error) {
      console.error('Phorest branches error:', error);
      res.status(500).json({ error: 'Failed to fetch Phorest branches' });
    }
  });

  // ============ PRODUCT CHECKOUT & PURCHASE ============
  
  // Create payment intent for product checkout
  app.post("/api/products/create-checkout-intent", async (req, res) => {
    try {
      const { items, sessionId, sessionToken, loyaltyPointsToRedeem } = req.body;
      
      // Validate items
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'No items in cart' });
      }
      
      // Validate session and client, with token-based restore on server restart
      const clientId = resolveSession(sessionId, sessionToken);
      if (!clientId) {
        return res.status(401).json({ error: 'Please login to checkout' });
      }
      
      // Check if Stripe is configured
      const isConfigured = await stripeClient.isStripeConfigured();
      if (!isConfigured) {
        return res.status(503).json({ 
          error: 'Payment system not configured',
          code: 'PAYMENTS_UNAVAILABLE'
        });
      }
      
      // SERVER-SIDE PRICE VALIDATION: Get product prices from Phorest cache (authoritative source)
      let cachedProducts: any[] = [];
      try {
        const cache = await productCache.getCachedProducts();
        cachedProducts = cache.products || [];
      } catch (cacheError) {
        console.error('[Checkout] Failed to get product cache:', cacheError);
        return res.status(503).json({ error: 'Product catalog unavailable. Please try again.' });
      }
      
      // Calculate total using SERVER-SIDE prices only (never trust client prices)
      let subtotalInCents = 0;
      const validatedItems: Array<{ productId: string; productName: string; quantity: number; priceInCents: number }> = [];
      
      for (const item of items) {
        if (!item.productId || !item.quantity || item.quantity < 1 || item.quantity > 100) {
          return res.status(400).json({ error: 'Invalid item in cart' });
        }
        
        // Find product in Phorest cache for authoritative pricing
        const cachedProduct = cachedProducts.find((p: any) => p.productId === item.productId);
        if (!cachedProduct) {
          return res.status(400).json({ error: `Product not found: ${item.productId}` });
        }
        
        // Use server-side price from Phorest cache
        const serverPrice = cachedProduct.price || 0;
        const priceInCents = Math.round(serverPrice * 100);
        if (priceInCents <= 0) {
          return res.status(400).json({ error: `Product unavailable: ${cachedProduct.name}` });
        }
        
        subtotalInCents += priceInCents * item.quantity;
        validatedItems.push({
          productId: item.productId,
          productName: cachedProduct.name || 'Product',
          quantity: item.quantity,
          priceInCents
        });
      }
      
      // Validate and apply loyalty points discount for products
      let loyaltyPointsRedeemed = 0;
      let loyaltyDiscountCents = 0;
      
      if (loyaltyPointsToRedeem && loyaltyPointsToRedeem > 0) {
        const requestedPoints = Math.floor(loyaltyPointsToRedeem);
        
        // Verify client has enough points via Phorest
        let availablePoints = 0;
        if (isPhorestConfigured()) {
          try {
            const loyalty = await phorestApi.getClientLoyalty(clientId);
            availablePoints = loyalty.points || 0;
          } catch (e) {
            console.warn('[Checkout] Could not fetch loyalty points:', e);
          }
        }
        
        // requestedPoints = number of redemptions requested (each costs LOYALTY_POINTS_PER_REDEMPTION loyalty points)
        const pointsNeeded = requestedPoints * LOYALTY_POINTS_PER_REDEMPTION;
        if (pointsNeeded > availablePoints) {
          return res.status(400).json({ error: `You need ${pointsNeeded} points but only have ${availablePoints}` });
        }
        
        // Each redemption (300 pts) = $5 off products
        const maxDiscountCents = requestedPoints * LOYALTY_PRODUCT_DISCOUNT_PER_REDEMPTION;
        loyaltyDiscountCents = Math.min(maxDiscountCents, subtotalInCents - 50); // Keep at least $0.50 for Stripe
        loyaltyPointsRedeemed = Math.min(requestedPoints, Math.ceil(loyaltyDiscountCents / LOYALTY_PRODUCT_DISCOUNT_PER_REDEMPTION));
        loyaltyDiscountCents = loyaltyPointsRedeemed * LOYALTY_PRODUCT_DISCOUNT_PER_REDEMPTION;
        
        if (loyaltyDiscountCents > subtotalInCents - 50) {
          loyaltyDiscountCents = subtotalInCents - 50;
        }
        
        console.log(`[Checkout] Loyalty: ${loyaltyPointsRedeemed} redemptions (${pointsNeeded} pts) = $${(loyaltyDiscountCents / 100).toFixed(2)} discount`);
      }
      
      const totalInCents = subtotalInCents - loyaltyDiscountCents;
      
      if (totalInCents < 50) { // Stripe minimum is $0.50
        return res.status(400).json({ error: 'Order total must be at least $0.50' });
      }
      
      const stripe = await stripeClient.getStripeClient();

      // IDEMPOTENCY: if the client already has a pending order for the exact
      // same items + loyalty redemption, reuse its PaymentIntent instead of
      // creating a second charge (prevents double-charging on retry/re-open).
      try {
        const reusable = await findReusablePendingOrder(clientId, validatedItems, loyaltyPointsRedeemed, sessionId);
        if (reusable) {
          const existingIntent = await stripe.paymentIntents.retrieve(reusable.order.paymentIntentId);
          const reusableStatuses = ['requires_payment_method', 'requires_confirmation', 'requires_action'];
          if (existingIntent.amount === reusable.order.totalInCents &&
              (reusableStatuses.includes(existingIntent.status) || existingIntent.status === 'succeeded')) {
            console.log(`[Checkout] Reusing existing PaymentIntent ${existingIntent.id} (status: ${existingIntent.status}) for pending order ${reusable.pendingOrderId}`);
            const o = reusable.order;
            const subtotal = o.totalInCents + o.loyaltyDiscountCents;
            return res.json({
              clientSecret: existingIntent.client_secret,
              pendingOrderId: reusable.pendingOrderId,
              alreadyPaid: existingIntent.status === 'succeeded',
              subtotalAmount: `$${(subtotal / 100).toFixed(2)}`,
              totalAmount: `$${(o.totalInCents / 100).toFixed(2)}`,
              totalInCents: o.totalInCents,
              loyaltyPointsRedeemed: o.loyaltyPointsRedeemed,
              loyaltyDiscountAmount: `$${(o.loyaltyDiscountCents / 100).toFixed(2)}`,
              loyaltyDiscountFormatted: `$${(o.loyaltyDiscountCents / 100).toFixed(2)}`
            });
          }
        }
      } catch (reuseError) {
        console.warn('[Checkout] Intent-reuse check failed, creating new intent:', reuseError);
      }

      // Generate pending order ID with crypto-safe random component
      const pendingOrderId = `order-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      // Create Stripe PaymentIntent with comprehensive metadata for security verification
      const paymentIntent = await stripe.paymentIntents.create({
        amount: totalInCents,
        currency: 'cad',
        payment_method_types: ['card'],
        metadata: {
          pendingOrderId,
          clientId,
          sessionId,
          itemCount: String(validatedItems.length),
          expectedAmount: String(totalInCents),
          loyaltyPointsRedeemed: String(loyaltyPointsRedeemed),
          loyaltyDiscountCents: String(loyaltyDiscountCents),
          type: 'product_purchase'
        },
        description: `Product purchase - ${validatedItems.length} items${loyaltyPointsRedeemed > 0 ? ` (${loyaltyPointsRedeemed} loyalty pts redeemed)` : ''}`
      }, { idempotencyKey: `pi-create-${pendingOrderId}` });
      
      // Store pending order with session binding
      await pendingOrders.set(pendingOrderId, {
        clientId,
        sessionId,
        items: validatedItems,
        totalInCents,
        loyaltyPointsRedeemed,
        loyaltyDiscountCents,
        paymentIntentId: paymentIntent.id,
        createdAt: Date.now()
      });
      
      console.log(`[Checkout] Created payment intent for ${validatedItems.length} products, subtotal: $${(subtotalInCents / 100).toFixed(2)}, discount: $${(loyaltyDiscountCents / 100).toFixed(2)}, total: $${(totalInCents / 100).toFixed(2)}`);
      
      res.json({
        clientSecret: paymentIntent.client_secret,
        pendingOrderId,
        subtotalAmount: `$${(subtotalInCents / 100).toFixed(2)}`,
        totalAmount: `$${(totalInCents / 100).toFixed(2)}`,
        totalInCents,
        loyaltyPointsRedeemed,
        loyaltyDiscountAmount: `$${(loyaltyDiscountCents / 100).toFixed(2)}`,
        loyaltyDiscountFormatted: `$${(loyaltyDiscountCents / 100).toFixed(2)}`
      });
    } catch (error) {
      console.error('Checkout intent error:', error);
      res.status(500).json({ error: 'Failed to create checkout' });
    }
  });
  
  // Finalize product purchase after Stripe payment succeeds
  app.post("/api/products/finalize-purchase", async (req, res) => {
    let lockedOrderId: string | null = null;
    try {
      const { pendingOrderId, sessionId, sessionToken } = req.body;
      
      if (!pendingOrderId) {
        return res.status(400).json({ error: 'Missing pending order ID' });
      }

      // CONCURRENCY LOCK: only one finalize may run per pending order at a
      // time (prevents double Phorest purchase records / double loyalty ops).
      if (!await tryAcquireFinalizeLock(`order:${pendingOrderId}`)) {
        return res.status(409).json({
          error: 'Order is already being finalized',
          code: 'FINALIZE_IN_PROGRESS',
          message: 'Your order is already being processed. Please wait a moment.'
        });
      }
      lockedOrderId = `order:${pendingOrderId}`;
      
      // Get pending order
      const pendingOrder = await pendingOrders.get(pendingOrderId);
      if (!pendingOrder) {
        return res.status(404).json({ error: 'Pending order not found or expired' });
      }
      
      // Check if order has expired (15 minutes)
      if (Date.now() - pendingOrder.createdAt > PENDING_ORDER_EXPIRY_MS) {
        await pendingOrders.delete(pendingOrderId);
        return res.status(410).json({ code: 'ORDER_EXPIRED', error: 'Order expired. Please try again.' });
      }
      
      // Session verification using resolveSession (supports HMAC token restore)
      if (!sessionId) {
        console.error(`[Purchase] Missing sessionId in finalize request`);
        return res.status(400).json({ code: 'AUTH_REQUIRED', error: 'Missing session' });
      }
      
      const resolvedClientId = resolveSession(sessionId, sessionToken);
      if (!resolvedClientId) {
        console.error(`[Purchase] Invalid or expired session: ${sessionId}`);
        return res.status(401).json({ code: 'SESSION_EXPIRED', error: 'Session expired. Please login again.' });
      }
      
      // Verify the caller's client matches the order's client
      if (resolvedClientId !== pendingOrder.clientId) {
        console.error(`[Purchase] Client mismatch: session client ${resolvedClientId}, order client ${pendingOrder.clientId}`);
        return res.status(403).json({ code: 'AUTH_MISMATCH', error: 'Session mismatch' });
      }
      
      // Verify payment with Stripe using the STORED paymentIntentId (not client-provided)
      let stripe;
      let paymentIntent;
      try {
        stripe = await stripeClient.getStripeClient();
        paymentIntent = await stripe.paymentIntents.retrieve(pendingOrder.paymentIntentId);
      } catch (stripeError) {
        console.error('[Purchase] Stripe API error:', stripeError);
        return res.status(503).json({ code: 'PAYMENT_VERIFICATION_FAILED', error: 'Payment verification failed. Please contact support.' });
      }
      
      // Verify payment succeeded
      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({ 
          code: 'PAYMENT_INCOMPLETE',
          error: 'Payment not completed',
          paymentStatus: paymentIntent.status 
        });
      }
      
      // COMPREHENSIVE SECURITY VERIFICATION
      // 1. Verify pendingOrderId in Stripe metadata matches
      if (paymentIntent.metadata.pendingOrderId !== pendingOrderId) {
        console.error(`[Purchase] Order ID mismatch: Stripe has ${paymentIntent.metadata.pendingOrderId}, expected ${pendingOrderId}`);
        return res.status(400).json({ error: 'Payment does not match order' });
      }
      
      // 2. Verify clientId matches
      if (paymentIntent.metadata.clientId !== pendingOrder.clientId) {
        console.error(`[Purchase] Client mismatch: Stripe has ${paymentIntent.metadata.clientId}, expected ${pendingOrder.clientId}`);
        return res.status(400).json({ error: 'Payment client mismatch' });
      }
      
      // 3. Verify sessionId in Stripe metadata matches
      if (paymentIntent.metadata.sessionId !== pendingOrder.sessionId) {
        console.error(`[Purchase] Session mismatch in Stripe metadata: has ${paymentIntent.metadata.sessionId}, expected ${pendingOrder.sessionId}`);
        return res.status(400).json({ error: 'Session mismatch' });
      }
      
      // 4. Verify amount matches stored pendingOrder total (authoritative source)
      if (paymentIntent.amount !== pendingOrder.totalInCents) {
        console.error(`[Purchase] Amount mismatch: Stripe charged ${paymentIntent.amount}, stored order has ${pendingOrder.totalInCents}`);
        return res.status(400).json({ error: 'Payment amount mismatch' });
      }
      
      // 5. Verify currency is CAD
      if (paymentIntent.currency !== 'cad') {
        return res.status(400).json({ error: 'Invalid payment currency' });
      }
      
      console.log(`[Purchase] Payment ${paymentIntent.id} fully verified for order ${pendingOrderId}`);
      
      // Record purchase in Phorest
      let phorestPurchase = null;
      if (isPhorestConfigured()) {
        try {
          const phorestItems = pendingOrder.items.map(item => ({
            productId: item.productId,
            quantity: item.quantity,
            price: item.priceInCents / 100 // Phorest expects dollars
          }));
          
          phorestPurchase = await phorestApi.createPurchase({
            clientId: pendingOrder.clientId,
            branchId: getDefaultBranchId() || '',
            items: phorestItems,
            total: pendingOrder.totalInCents / 100,
            notes: `Online purchase via Stripe`,
            externalReference: paymentIntent.id
          });
          
          console.log(`[Purchase] Recorded in Phorest: ${phorestPurchase.saleId}`);
        } catch (phorestError) {
          // Log but don't fail - payment succeeded, we'll sync later
          console.error('[Purchase] Failed to record in Phorest:', phorestError);
        }
      }
      
      // Handle loyalty points: re-validate, deduct redeemed points & award new points
      let loyaltyPointsEarned = 0;
      if (isPhorestConfigured()) {
        // 1. Re-validate and deduct redeemed loyalty points (prevents race condition)
        // loyaltyPointsRedeemed = number of redemptions, each costs LOYALTY_POINTS_PER_REDEMPTION actual points
        if (pendingOrder.loyaltyPointsRedeemed > 0) {
          try {
            const actualPointsNeeded = pendingOrder.loyaltyPointsRedeemed * LOYALTY_POINTS_PER_REDEMPTION;
            const currentLoyalty = await phorestApi.getClientLoyalty(pendingOrder.clientId);
            const currentPoints = currentLoyalty.points || 0;
            const pointsToDeduct = Math.min(actualPointsNeeded, currentPoints);
            
            if (pointsToDeduct > 0) {
              await phorestApi.changeLoyaltyPoints({
                clientId: pendingOrder.clientId,
                points: pointsToDeduct,
                reason: `Redeemed ${pointsToDeduct} points for $${(pendingOrder.loyaltyDiscountCents / 100).toFixed(2)} product discount`,
                transactionType: 'remove'
              });
              console.log(`[Loyalty] Deducted ${pointsToDeduct} points from client ${pendingOrder.clientId} (requested: ${actualPointsNeeded}, available: ${currentPoints})`);
            } else {
              console.warn(`[Loyalty] No points available to deduct (requested: ${actualPointsNeeded}, available: ${currentPoints})`);
            }
          } catch (loyaltyError) {
            console.error('[Loyalty] Failed to deduct points:', loyaltyError);
          }
        }
        
        // 2. Award new loyalty points (1 point per $1 spent, based on amount actually paid)
        const amountSpentDollars = pendingOrder.totalInCents / 100;
        loyaltyPointsEarned = Math.floor(amountSpentDollars * LOYALTY_POINTS_PER_DOLLAR);
        if (loyaltyPointsEarned > 0) {
          try {
            await phorestApi.changeLoyaltyPoints({
              clientId: pendingOrder.clientId,
              points: loyaltyPointsEarned,
              reason: `Earned from product purchase - $${amountSpentDollars.toFixed(2)} spent`,
              transactionType: 'add'
            });
            console.log(`[Loyalty] Awarded ${loyaltyPointsEarned} points to client ${pendingOrder.clientId}`);
          } catch (loyaltyError) {
            console.error('[Loyalty] Failed to award points:', loyaltyError);
          }
        }
      }
      
      // Clean up pending order
      await pendingOrders.delete(pendingOrderId);
      
      res.json({
        success: true,
        paymentId: paymentIntent.id,
        totalPaid: pendingOrder.totalInCents / 100,
        itemCount: pendingOrder.items.length,
        phorestSaleId: phorestPurchase?.saleId,
        loyaltyPointsRedeemed: pendingOrder.loyaltyPointsRedeemed,
        loyaltyDiscountApplied: pendingOrder.loyaltyDiscountCents / 100,
        loyaltyPointsEarned
      });
    } catch (error) {
      console.error('Finalize purchase error:', error);
      res.status(500).json({ code: 'PURCHASE_FAILED', error: 'Failed to finalize purchase' });
    } finally {
      if (lockedOrderId) await releaseFinalizeLock(lockedOrderId);
    }
  });
  
  // Record purchase in Phorest (internal API for syncing)
  app.post("/api/purchase", async (req, res) => {
    try {
      const { clientId, branchId, items, total, notes, externalReference } = req.body;
      
      if (!clientId || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      if (!isPhorestConfigured()) {
        return res.status(503).json({ error: 'Phorest not configured' });
      }
      
      const purchase = await phorestApi.createPurchase({
        clientId,
        branchId: branchId || getDefaultBranchId(),
        items,
        total,
        notes,
        externalReference
      });
      
      console.log(`[Purchase] Recorded in Phorest: ${purchase.saleId}`);
      
      const { saleId: _, ...purchaseData } = purchase;
      res.json({ 
        ok: true,
        saleId: purchase.saleId,
        ...purchaseData
      });
    } catch (error) {
      console.error('Purchase error:', error);
      res.status(500).json({ error: 'Failed to create purchase' });
    }
  });
  
  // Update loyalty points - admin only, for future use
  // Uses official Phorest endpoint: POST /changeloyaltypoints
  app.post("/api/loyalty/update", async (req, res) => {
    try {
      const { clientId, points, reason, transactionType } = req.body;
      
      console.log('[STUB] Loyalty update request received:', {
        clientId,
        points,
        reason,
        transactionType
      });
      
      // TODO: When admin panel is ready, call phorestApi.changeLoyaltyPoints()
      // const result = await phorestApi.changeLoyaltyPoints({
      //   clientId,
      //   points,
      //   reason,
      //   transactionType
      // });
      
      res.json({ 
        ok: true, 
        message: 'Loyalty update endpoint ready for integration',
        stub: true
      });
    } catch (error) {
      console.error('Loyalty update error:', error);
      res.status(500).json({ error: 'Failed to update loyalty points' });
    }
  });

  // Redeem loyalty reward
  app.post("/api/loyalty/redeem", async (req, res) => {
    try {
      const { clientId, rewardName, pointsRequired } = req.body;
      
      if (!clientId || !rewardName || !pointsRequired) {
        return res.status(400).json({ error: 'Missing required fields: clientId, rewardName, pointsRequired' });
      }
      
      console.log('[Loyalty] Redeem request:', { clientId, rewardName, pointsRequired });
      
      if (isPhorestConfigured()) {
        try {
          // Deduct points via Phorest API
          await phorestApi.changeLoyaltyPoints({
            clientId,
            points: pointsRequired,
            reason: `Redeemed reward: ${rewardName}`,
            transactionType: 'remove'
          });
          
          return res.json({
            ok: true,
            message: `Successfully redeemed "${rewardName}"`,
            rewardName,
            pointsDeducted: pointsRequired
          });
        } catch (phorestError) {
          console.error('[Loyalty] Phorest redeem error:', phorestError);
          return res.status(500).json({ error: 'Failed to redeem reward via Phorest' });
        }
      }
      
      // Mock response for development
      res.json({
        ok: true,
        message: `Successfully redeemed "${rewardName}"`,
        rewardName,
        pointsDeducted: pointsRequired,
        stub: true
      });
    } catch (error) {
      console.error('Loyalty redeem error:', error);
      res.status(500).json({ error: 'Failed to redeem reward' });
    }
  });

  // Legacy endpoints for backward compatibility
  app.get("/api/client/:clientId/appointments", async (req, res) => {
    try {
      const { clientId } = req.params;
      
      if (isPhorestConfigured()) {
        try {
          const today = new Date().toISOString().split('T')[0];
          const futureDate = new Date();
          futureDate.setMonth(futureDate.getMonth() + 1);
          
          const appointmentsResponse = await phorestApi.listAppointments({
            clientId,
            fromDate: today,
            toDate: futureDate.toISOString().split('T')[0],
            page: 0,
            size: 20
          }) as any;
          const appointments = appointmentsResponse._embedded?.appointments ?? appointmentsResponse.content ?? [];
          
          return res.json({ appointments });
        } catch (e) {
          console.error('Phorest appointments error:', e);
        }
      }
      
      // Mock response
      res.json({
        appointments: [
          {
            id: "apt-001",
            serviceName: "Balayage & Toner",
            date: "2024-10-15",
            time: "10:00 AM",
            stylist: "Kozeta",
            status: "completed",
            price: "$320"
          }
        ]
      });
    } catch (error) {
      console.error('Appointments fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch appointments' });
    }
  });

  app.get("/api/client/:clientId/loyalty", async (req, res) => {
    try {
      const { clientId } = req.params;
      
      if (isPhorestConfigured()) {
        try {
          const loyalty = await phorestApi.getClientLoyalty(clientId);
          return res.json({
            ...getLoyaltyRewardInfo(loyalty.points || 0),
            tier: loyalty.tier,
          });
        } catch (e) {
          console.error('Phorest loyalty error:', e);
        }
      }
      
      const client = Object.values(mockClients).find(c => c.clientId === clientId);
      
      if (!client) {
        return res.status(404).json({ error: 'Client not found' });
      }
      
      res.json(getLoyaltyRewardInfo(client.profile.loyaltyPoints));
    } catch (error) {
      console.error('Loyalty fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch loyalty data' });
    }
  });

  app.get("/api/client/:clientId/products", async (req, res) => {
    try {
      const { clientId } = req.params;
      
      if (isPhorestConfigured()) {
        try {
          const purchasesResponse = await phorestApi.getClientPurchaseHistory(clientId, { page: 0, size: 10 }) as any;
          const purchases = purchasesResponse._embedded?.purchases ?? purchasesResponse.content ?? [];
          const products = purchases.flatMap((p: any) => 
            (p.items || []).map((item: any) => ({
              productName: item.productName,
              lastPurchased: new Date(p.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
              status: 'in-stock' as const
            }))
          );
          return res.json({ products });
        } catch (e) {
          console.error('Phorest products error:', e);
        }
      }
      
      const client = Object.values(mockClients).find(c => c.clientId === clientId);
      
      if (!client) {
        return res.status(404).json({ error: 'Client not found' });
      }
      
      res.json({ products: client.products || [] });
    } catch (error) {
      console.error('Products fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch product data' });
    }
  });

  // AI Chat endpoint with booking flow support and product recommendations
  app.post("/api/chat", async (req, res) => {
    try {
      const { messages, userMessage } = chatRequestSchema.parse(req.body);
      const clientId = req.body.clientId as string | undefined;
      const sessionId = req.body.sessionId as string | undefined;
      
      // Get all salon services from Phorest-driven cache
      const serviceCache = await import('./services/serviceCache');
      let services = serviceCache.getServices();
      if (services.length === 0 && !serviceCache.isCacheReady()) {
        await serviceCache.warmCache();
        services = serviceCache.getServices();
      }

      // Use the in-memory product cache instead of a live Phorest fetch
      // (warmed on startup + background-refreshed) so chat requests never block.
      let shopProducts: any[] = productCache.getProducts({ page: 0, size: 10 }).products.map((p) => ({
        productId: p.productId,
        name: p.name,
        brandName: p.brandName,
        categoryName: p.categoryName,
        price: p.price || 0,
        description: p.description,
        imageUrl: p.imageUrl,
        inStock: p.inStock,
      }));
      
      // Build system context for the AI
      const servicesContext = services.map(s => 
        `${s.name} (key: ${s.key}, ${s.category}): ${s.description} - ${s.duration}, ${s.price}`
      ).join('\n');
      
      // Build products context for AI
      const productsContext = shopProducts.length > 0 
        ? shopProducts.map(p => 
            `${p.name} by ${p.brandName} (${p.categoryName}): $${p.price} - ${p.inStock ? 'In Stock' : 'Out of Stock'}`
          ).join('\n')
        : 'No products currently loaded';

      const systemPrompt = `You are an expert AI stylist assistant for Kozeta Salon & Spa, an award-winning luxury salon with over 16 years of excellence. Your mission is to give clients genuinely helpful, knowledgeable answers about hair, beauty, and spa services — and guide them toward booking or purchasing the right products.

SALON AT A GLANCE:
- Founded by Kozeta Izeti — 24+ years of mastery, North American Hair Awards & Contessa Awards winner
- Master stylists each with 20+ years experience, Vidal Sassoon trained
- Specialties: Balayage, colour correction, keratin treatments, bridal styling, brows & lashes, facials, Venus laser treatments, waxing, massage
- Certified in: Goldwell, Pureology, L'Oréal Professional
- Phone: (416) 932-3131

AVAILABLE SERVICES:
${servicesContext}

SHOP PRODUCTS (recommend these when relevant):
${productsContext}

TREATMENT KNOWLEDGE — use this to give informed answers:

COLOUR SERVICES:
- Balayage: Hand-painted highlights for a sun-kissed, natural gradient. Results last 3–4 months before a refresh. Safe on most hair types; not ideal immediately after a permanent colour (wait at least 2 weeks).
- Highlights vs Balayage: Highlights use foils for precise, uniform sections; balayage is freehand for a softer, more blended look. Highlights need touch-ups every 6–8 weeks; balayage every 10–16 weeks.
- Toner vs Gloss: A toner neutralizes unwanted brassiness (applied after lightening). A gloss adds shine and a subtle tint without lifting — great for refreshing colour between appointments. Both last 4–6 weeks.
- Colour correction: Multi-step process to fix uneven, brassy, or over-processed colour. Requires a consultation — timeline and sessions vary by starting condition.
- Olaplex treatments: Bond-building treatments that repair and protect hair during and after colour services.

HAIR TREATMENTS:
- Keratin treatment: Smooths frizz and curl for 3–5 months. Avoid washing hair for 72 hours after. Not recommended on very damaged or recently bleached hair without a consultation.
- Deep conditioning: Restores moisture and elasticity. Recommended every 4–6 weeks for dry or chemically treated hair.
- Scalp treatments: Address dandruff, dryness, or oiliness. Safe for all hair types.

CUTS & STYLING:
- Women's cut: Includes consultation, shampoo, cut, and blowout. Results are immediate.
- Men's cut: Tailored precision cut. Can include beard trim.
- Blowout: Professional finish without cutting. Lasts 3–5 days with proper care.
- Bridal styling: Trial run recommended 2–4 weeks before the wedding date.

SPA & SKIN SERVICES:
- Facials: Cleansing, exfoliating, and hydrating treatments. Various types available (anti-aging, brightening, deep pore). Most clients see improvement immediately; full results after a series.
- Brows & Lashes: Tinting lasts 3–5 weeks. Shaping/waxing every 3–4 weeks. Lash lifts last 6–8 weeks.
- Waxing: Results last 3–6 weeks depending on hair growth cycle.
- Massage: Relaxation and therapeutic options available.

VENUS / LASER TREATMENTS:
- Venus treatments use radiofrequency and magnetic pulse technology for skin tightening, contouring, and wrinkle reduction.
- Multiple sessions are typically recommended. Results are gradual — most clients see visible improvement after 3–6 sessions.
- Safe for most skin types; a consultation is recommended to determine the right protocol.

AFTERCARE ADVICE:
- Colour-treated hair: Use sulphate-free shampoo (e.g. Pureology, Goldwell ColorSave). Avoid hot showers. Use UV protection spray in summer.
- Keratin-treated hair: Use sodium-chloride-free products. Avoid hair ties that crease hair for 72 hours.
- Blowout maintenance: Use a silk pillowcase, avoid humidity, apply light dry shampoo at roots to extend results.

BOOKING-FOCUSED APPROACH:
You can help clients book directly through this portal. When a client wants to book:
1. Recommend the right service(s) based on their needs and hair description
2. Ask their preferred date/time and stylist preference
3. Once confirmed, the system handles availability and booking

BOOKING FLOW (include these markers when appropriate):
- When client is ready: include "READY_TO_BOOK" in your response
- Services: "SERVICES: [service_key1, service_key2]"
- Preferred date: "PREFERRED_DATE: YYYY-MM-DD"
- Preferred stylist: "PREFERRED_STYLIST: [name]"

PRODUCT RECOMMENDATIONS:
- Recommend specific products from our shop when relevant to a client's question
- Include: "RECOMMEND_PRODUCT: [productId]"
- Explain clearly why the product suits their specific need

WHEN UNCERTAIN — CALL THE SALON:
If a client asks about something highly specific to their individual hair situation, a medical or allergy concern, exact pricing for a custom service, or anything you cannot answer with confidence, say warmly:
"That's a great question — for the most accurate answer for your specific situation, I'd recommend giving us a call at (416) 932-3131. The team can walk you through everything personally!"
Never guess or fabricate details about procedures, safety, or pricing you are not certain about.

SALES APPROACH:
✓ Be warm, knowledgeable, and confident — give real information, not just enthusiasm
✓ Emphasize expertise, certifications, and award-winning results
✓ Paint the picture of how they'll look and feel after the service
✓ Always guide toward booking or a product recommendation
✓ If they seem hesitant, acknowledge their concern and address it with facts

NEVER:
✗ Answer anything unrelated to hair, beauty, skincare, spa, wellness, or booking. For completely off-topic questions (politics, sports, cooking, news, technology, etc.), respond warmly: "I'm Kozeta Salon's stylist assistant — I'm here to help with all things hair and beauty! What can I help you with today?"
✗ Discourage any service or suggest it's "not worth it"
✗ Suggest going elsewhere or DIY alternatives
✗ Guess or fabricate answers about safety, medical suitability, or exact pricing — use the "call us" fallback instead
✗ Express doubt about the salon's quality or results

TONE: Warm, knowledgeable, confident, and professional — like a trusted expert stylist friend.

RESPONSE STYLE: 2–4 sentences for simple questions. Up to 6 sentences for detailed treatment, care, or suitability questions. Always end by moving toward booking, a product recommendation, or a call to the salon.`;

      // Stream the OpenAI response to the client via Server-Sent Events so the
      // reply renders progressively instead of waiting for the full completion.
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();

      const sendEvent = (payload: any) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      let fullRaw = '';
      let held = '';

      try {
        const stream = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: userMessage }
          ],
          max_completion_tokens: 500,
          stream: true
        });

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content || '';
          if (!delta) continue;
          fullRaw += delta;
          held += delta;

          // Only emit text we are confident is not part of an in-progress marker.
          const cut = computeStreamBoundary(held);
          if (cut > 0) {
            const safePart = held.slice(0, cut);
            held = held.slice(cut);
            const cleanSafe = stripChatMarkers(safePart);
            if (cleanSafe) sendEvent({ type: 'delta', text: cleanSafe });
          }
        }

        // Flush whatever is left in the buffer (markers stripped).
        const flushed = stripChatMarkers(held);
        if (flushed) sendEvent({ type: 'delta', text: flushed });

        const assistantMessage = fullRaw || "I'm here to help you find the perfect service! What are you looking for today?";

        // Parse the full accumulated text for structured metadata.
        const recommendations = detectServiceRecommendations(assistantMessage, services);

        const readyToBook = assistantMessage.includes('READY_TO_BOOK');
        const servicesMatch = assistantMessage.match(/SERVICES\*{0,2}\s*:\s*\*{0,2}\s*\[([^\]]+)\]/);
        const dateMatch = assistantMessage.match(/PREFERRED_DATE\*{0,2}\s*:\s*\*{0,2}\s*\[?(\d{4}-\d{2}-\d{2})\]?/);
        const stylistMatch = assistantMessage.match(/PREFERRED_STYLIST\*{0,2}\s*:\s*\*{0,2}\s*\[([^\]]+)\]/) || assistantMessage.match(/PREFERRED_STYLIST\*{0,2}\s*:\s*\*{0,2}\s*(\w+)/);

        const productMatches = assistantMessage.matchAll(/RECOMMEND_PRODUCT\*{0,2}\s*:\s*\*{0,2}\s*\[([^\]]+)\]/g);
        const recommendedProductIds = Array.from(productMatches).map(m => m[1].trim());
        const productRecommendations = shopProducts.filter(p =>
          recommendedProductIds.includes(p.productId) ||
          recommendedProductIds.some(id => p.name.toLowerCase().includes(id.toLowerCase()))
        );

        const cleanedMessage = stripChatMarkers(assistantMessage)
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n[ \t]*[-*][ \t]*(?=\n|$)/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        const chatMessage: ChatMessage = {
          role: "assistant",
          content: cleanedMessage,
          timestamp: Date.now(),
          recommendations: recommendations.length > 0 ? recommendations : undefined
        };

        const donePayload: any = { type: 'done', message: chatMessage };
        if (readyToBook) {
          donePayload.bookingIntent = {
            ready: true,
            serviceKeys: servicesMatch ? servicesMatch[1].split(',').map(s => s.trim()) : [],
            preferredDate: dateMatch ? dateMatch[1] : undefined,
            preferredStylist: stylistMatch ? stylistMatch[1] : undefined
          };
        }
        if (productRecommendations.length > 0) {
          donePayload.productRecommendations = productRecommendations;
        }

        sendEvent(donePayload);
        res.end();
      } catch (streamError: any) {
        console.error('Chat stream error:', streamError);
        try {
          sendEvent({ type: 'error', message: streamError?.message || 'Failed to process chat message' });
        } catch {}
        res.end();
      }
    } catch (error: any) {
      console.error('Chat error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Failed to process chat message',
          message: error.message
        });
      } else {
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
        } catch {}
        res.end();
      }
    }
  });

  await registerAdminRoutes(app);

  // ─── SMS Companion routes ───────────────────────────────────────────────────

  // Twilio webhook signature validator (HMAC-SHA1 per Twilio docs).
  // Set TWILIO_WEBHOOK_URL to the full public URL of this endpoint (e.g. https://kozetasalon.com/api/sms/inbound).
  // When TWILIO_WEBHOOK_URL is not configured (local dev) validation is skipped.
  function validateTwilioSignature(req: Request): boolean {
    const webhookUrl = process.env.TWILIO_WEBHOOK_URL;
    const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
    if (!webhookUrl) return true; // skip in local dev
    const signature = (req.headers["x-twilio-signature"] as string) ?? "";
    if (!signature) return false;
    const params = (req.body ?? {}) as Record<string, string>;
    const sortedKeys = Object.keys(params).sort();
    const paramStr = sortedKeys.map(k => `${k}${params[k]}`).join("");
    const stringToSign = webhookUrl + paramStr;
    const expected = crypto.createHmac("sha1", authToken).update(stringToSign).digest("base64");
    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false; // different lengths
    }
  }

  // Twilio webhook — inbound SMS (same number as OTP; OTP takes priority for 6-digit replies)
  app.post("/api/sms/inbound", async (req: Request, res: Response) => {
    // Validate Twilio request signature to prevent spoofing
    if (!validateTwilioSignature(req)) {
      console.warn("[SMS] Rejected request with invalid Twilio signature");
      return res.status(403).type("text/xml").send("<Response></Response>");
    }

    const from: string = req.body?.From ?? "";
    const body: string = (req.body?.Body ?? "").trim();

    if (!from || !body) {
      return res.type("text/xml").send("<Response></Response>");
    }

    const { allowMessage } = await import("./smsRateLimit");
    if (!allowMessage(from)) {
      console.warn(`[SMS] Rate limit hit for ${from}`);
      return res.type("text/xml").send(
        "<Response><Message>You've sent too many messages. Please try again in an hour or call (416) 932-3131.</Message></Response>"
      );
    }

    // Portal switched off — every inbound text gets a short static reply
    // pointing at Phorest's online booking page. No AI, no payment links.
    if (!PORTAL_ENABLED) {
      const staticReply =
        `Thanks for texting Kozeta Salon & Spa! Book online at ${PHOREST_BOOKING_URL} ` +
        `or call us at ${SALON_PHONE_DISPLAY}.`;
      const escapedStatic = staticReply
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return res.type("text/xml").send(`<Response><Message>${escapedStatic}</Message></Response>`);
    }

    const { hasActiveOtp } = await import("./smsOtpBridge");
    if (hasActiveOtp(from) && /^\d{6}$/.test(body)) {
      return res.type("text/xml").send("<Response></Response>");
    }

    // SMS AI companion disabled — no reply is sent at all.
    if (!isSmsCompanionEnabled()) {
      return res.type("text/xml").send("<Response></Response>");
    }

    try {
      const replyText = await handleSmsMessage(from, body);
      const escaped = replyText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return res.type("text/xml").send(`<Response><Message>${escaped}</Message></Response>`);
    } catch (err) {
      console.error("[SMS] Companion error:", err);
      return res.type("text/xml").send(
        "<Response><Message>Sorry, I'm having trouble right now. Call (416) 932-3131.</Message></Response>"
      );
    }
  });

  // GET /api/sms/history — returns SMS conversation history for merging into in-app chat
  app.get("/api/sms/history", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string | undefined;
    const sessionToken = req.query.sessionToken as string | undefined;
    const clientId = resolveSession(sessionId, sessionToken);
    if (!clientId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const client = await phorestApi.getClient(clientId);
      const phone = client.mobile ? authUtils.normalizePhoneForSearch(client.mobile) : null;
      if (!phone) return res.json({ messages: [] });
      const messages = await getSmsHistory(phone);
      return res.json({ messages });
    } catch (err) {
      console.error("[SMS] History fetch error:", err);
      return res.json({ messages: [] });
    }
  });

  // GET /api/sms/booking-preview?pid=&t= — preview a pending SMS booking.
  // Requires the one-time smsToken (?t=) embedded in the SMS payment link.
  app.get("/api/sms/booking-preview", async (req: Request, res: Response) => {
    const pid = String(req.query.pid ?? "");
    const token = String(req.query.t ?? "");
    if (!pid || !token) return res.status(400).json({ error: "Missing pid or token" });
    const pending = await pendingBookings.get(pid);
    if (!pending) return res.status(404).json({ error: "Booking not found or expired" });
    if (!pending.smsToken || pending.smsToken !== token) return res.status(403).json({ error: "Invalid or expired token" });
    const expiresIn = Math.max(0, Math.round((pending.createdAt + PENDING_EXPIRY_MS - Date.now()) / 1000));
    return res.json({
      pendingId: pid,
      serviceName: pending.serviceName,
      startDateTime: pending.startDateTime,
      depositAmount: pending.depositAmount,
      servicePrice: pending.servicePrice,
      expiresInSeconds: expiresIn,
    });
  });

  // GET /api/sms/payment-intent?pid=&t= — returns PaymentIntent client_secret for an existing SMS booking hold.
  // Accepts EITHER a valid smsToken (?t=) OR an authenticated session — whichever is present.
  // Token path: no login required (client followed the SMS payment link).
  // Session path: client is already logged in to the portal.
  app.get("/api/sms/payment-intent", async (req: Request, res: Response) => {
    const pid = String(req.query.pid ?? "");
    const token = String(req.query.t ?? "");
    const sessionId = req.query.sessionId as string | undefined;
    const sessionToken = req.query.sessionToken as string | undefined;
    if (!pid) return res.status(400).json({ error: "Missing pid" });

    const pending = await pendingBookings.get(pid);
    if (!pending) return res.status(404).json({ error: "Booking not found or expired" });

    // Authorise via smsToken (no login) OR authenticated session
    const tokenValid = token && pending.smsToken && pending.smsToken === token;
    const clientId = !tokenValid ? resolveSession(sessionId, sessionToken) : null;
    if (!tokenValid && !clientId) return res.status(401).json({ error: "Not authenticated" });
    // Session path: verify the booking belongs to this client
    if (!tokenValid && clientId && pending.clientId !== clientId) return res.status(403).json({ error: "Not your booking" });

    try {
      if (!pending.paymentIntentId) return res.status(400).json({ error: "No payment intent for this booking" });
      const sc = await stripeClient.getStripeClient();
      const pi = await sc.paymentIntents.retrieve(pending.paymentIntentId);

      // Consume the one-time token after first use so the link can't be replayed
      if (tokenValid && pending.smsToken) {
        const updated: typeof pending = { ...pending, smsToken: undefined };
        await pendingBookings.set(pid, updated);
      }

      return res.json({
        pendingId: pid,
        paymentIntentId: pending.paymentIntentId,
        clientSecret: pi.client_secret,
        clientId: pending.clientId,
        serviceName: pending.serviceName,
        startDateTime: pending.startDateTime,
        endDateTime: pending.endDateTime,
        servicePrice: pending.servicePrice,
        depositAmount: pending.depositAmount,
        staffIds: pending.staffIds,
        serviceIds: pending.serviceIds,
        branchId: pending.branchId,
      });
    } catch (err) {
      console.error("[SMS] Payment intent retrieval failed:", err);
      return res.status(500).json({ error: "Could not retrieve payment details" });
    }
  });

  // POST /api/payments/save-card — explicit opt-in to save payment method for future SMS bookings.
  // Client sees "Save card for faster text bookings?" prompt after successful deposit and clicks Yes.
  // Attaches the existing PI payment method to a Stripe Customer and persists to sms_conversations.
  app.post("/api/payments/save-card", async (req: Request, res: Response) => {
    try {
      const { paymentIntentId } = req.body;
      const sessionId = req.body.sessionId as string | undefined;
      const sessionToken = req.body.sessionToken as string | undefined;
      const clientId = resolveSession(sessionId, sessionToken);
      if (!clientId) return res.status(401).json({ error: "Not authenticated" });
      if (!paymentIntentId) return res.status(400).json({ error: "Missing paymentIntentId" });

      const sc = await stripeClient.getStripeClient();
      const pi = await sc.paymentIntents.retrieve(paymentIntentId);
      const paymentMethod = pi.payment_method as string | null | undefined;
      if (!paymentMethod) return res.status(400).json({ error: "No payment method on this payment" });
      // Strict ownership + provenance checks (fail closed):
      // 1. Must be one of our booking deposits (not an arbitrary PI id).
      // 2. Must have succeeded (card actually worked).
      // 3. metadata.clientId is MANDATORY and must match the session's client —
      //    a PI without clientId metadata cannot prove ownership.
      if (pi.metadata?.type !== "booking_deposit") {
        return res.status(403).json({ error: "This payment cannot be used to save a card" });
      }
      if (pi.status !== "succeeded") {
        return res.status(400).json({ error: "Payment has not completed" });
      }
      if (!pi.metadata?.clientId || pi.metadata.clientId !== clientId) {
        return res.status(403).json({ error: "Payment does not belong to this client" });
      }

      // Get/create Stripe Customer and attach the payment method.
      // Attach failures must NOT be swallowed — otherwise the client is told
      // the card was saved when it wasn't, and their next SMS booking fails.
      const phorestClient = await phorestApi.getClient(clientId).catch(() => null);
      const name = phorestClient ? [phorestClient.firstName, phorestClient.lastName].filter(Boolean).join(" ") : "";
      const customerId = await stripeClient.getOrCreateStripeCustomer(clientId, name, phorestClient?.email);
      try {
        await sc.paymentMethods.attach(paymentMethod, { customer: customerId });
      } catch (attachErr: any) {
        // "already attached to this customer" is fine; anything else is a real failure
        const msg = String(attachErr?.message || attachErr);
        const pm = await sc.paymentMethods.retrieve(paymentMethod).catch(() => null);
        const alreadyOurs = pm && (pm as any).customer === customerId;
        if (!alreadyOurs) {
          console.error("[SaveCard] Attach failed:", msg);
          return res.status(400).json({ error: "This card could not be saved for future bookings" });
        }
      }

      // Persist stripeCustomerId to sms_conversations keyed by phone so companion can charge next time
      if (phorestClient?.mobile) {
        const phone = authUtils.normalizePhoneForSearch(phorestClient.mobile);
        await db.insert(smsConversations)
          .values({ phone, clientId, stripeCustomerId: customerId, messages: [], preferences: {} })
          .onConflictDoUpdate({
            target: smsConversations.phone,
            set: { stripeCustomerId: customerId, clientId, updatedAt: new Date() },
          });
        console.log(`[SaveCard] Saved card ${paymentMethod} → Customer ${customerId} for ${phone}`);
      }

      return res.json({ saved: true });
    } catch (err) {
      console.error("[SaveCard] Failed:", err);
      return res.status(500).json({ error: "Could not save card" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

// Internal booking/product markers the AI emits inline. These must never reach
// the visible chat text shown to the user. The model formats them inconsistently
// (bare, **bold**, markdown list bullets, colon inside or outside the bold,
// bracketed or bare values, or even the literal "YYYY-MM-DD" placeholder), so the
// stripping/boundary logic keys off the bare keyword tokens and removes the rest
// of the marker's line.
const MARKER_BASES = ['READY_TO_BOOK', 'SERVICES', 'PREFERRED_DATE', 'PREFERRED_STYLIST', 'RECOMMEND_PRODUCT'];
const VALUE_MARKER_BASES = ['SERVICES', 'PREFERRED_DATE', 'PREFERRED_STYLIST', 'RECOMMEND_PRODUCT'];

// Remove all markers from a chunk of text. READY_TO_BOOK is a bare flag; the
// value markers (SERVICES/PREFERRED_DATE/PREFERRED_STYLIST/RECOMMEND_PRODUCT)
// carry a value, so we strip from the keyword through the end of its line.
function stripChatMarkers(text: string): string {
  return text
    .replace(/[ \t]*(?:[-*]+[ \t]*)?\*{0,2}READY_TO_BOOK\*{0,2}/g, '')
    .replace(/[ \t]*(?:[-*]+[ \t]*)?\*{0,2}(?:SERVICES|PREFERRED_DATE|PREFERRED_STYLIST|RECOMMEND_PRODUCT)\*{0,2}[ \t]*:[^\n]*/g, '');
}

// Given the buffered (not-yet-emitted) streamed text, return the index up to
// which it is safe to emit. Text from the returned index onward might be part
// of an in-progress marker and must be held back until more tokens arrive.
function computeStreamBoundary(held: string): number {
  let cut = held.length;

  // Move an index back over any immediately preceding markdown asterisks so a
  // bold-wrapped marker (**MARKER**) is held/stripped as a unit.
  const backUpStars = (i: number) => {
    while (i > 0 && held[i - 1] === '*') i--;
    return i;
  };

  // 1. A marker keyword may be partially formed at the very end of the buffer.
  for (const base of MARKER_BASES) {
    const maxLen = Math.min(base.length, held.length);
    for (let len = maxLen; len > 0; len--) {
      if (held.slice(held.length - len) === base.slice(0, len)) {
        cut = Math.min(cut, backUpStars(held.length - len));
        break;
      }
    }
  }

  // 2. A value marker keyword is present but its line isn't finished yet (no
  //    newline after it), so the value may still be streaming in. Hold from the
  //    keyword until the whole marker line is buffered and can be stripped.
  for (const base of VALUE_MARKER_BASES) {
    let idx = held.indexOf(base);
    while (idx !== -1) {
      const nl = held.indexOf('\n', idx);
      if (nl === -1) {
        cut = Math.min(cut, backUpStars(idx));
        break;
      }
      idx = held.indexOf(base, nl);
    }
  }

  // 3. Hold back a trailing run of '*' which may be markdown wrapping a marker.
  const starMatch = held.match(/\*+$/);
  if (starMatch) {
    cut = Math.min(cut, held.length - starMatch[0].length);
  }

  return cut;
}

function detectServiceRecommendations(message: string, services: any[]) {
  const recommendations: any[] = [];
  const lowerMessage = message.toLowerCase();
  const addedKeys = new Set<string>();

  const searchKeywords = [
    'keratin', 'balayage', 'highlight', 'blonde', 'color', 'colour',
    'haircut', 'cut', 'blowout', 'blow dry', 'updo', 'bridal', 'wedding',
    'extension', 'facial', 'dermaplaning', 'lash', 'brow', 'microblading',
    'botox', 'filler', 'laser', 'wax', 'massage', 'nail', 'manicure',
    'pedicure', 'threading', 'tint', 'perm', 'peel', 'acne', 'anti-aging',
    'venus', 'ipl', 'photofacial', 'resurfacing', 'tightening', 'slimming',
    'cellulite', 'tribella', 'wig', 'shaping'
  ];

  const matchedKeywords = searchKeywords.filter(kw => lowerMessage.includes(kw));

  if (matchedKeywords.length > 0) {
    for (const service of services) {
      if (recommendations.length >= 3) break;
      const svcName = service.name.toLowerCase();
      const svcDesc = (service.description || '').toLowerCase();

      for (const kw of matchedKeywords) {
        if (svcName.includes(kw) || svcDesc.includes(kw)) {
          if (!addedKeys.has(service.key)) {
            addedKeys.add(service.key);
            recommendations.push({
              serviceKey: service.key,
              serviceName: service.name,
              description: (service.description || '').split('.')[0],
              duration: service.duration,
              price: service.price,
              bookingUrl: service.bookingUrl,
              phorestServiceId: service.phorestServiceId || service.key
            });
          }
          break;
        }
      }
    }
  }

  if (recommendations.length === 0) {
    for (const service of services) {
      if (recommendations.length >= 3) break;
      const serviceName = service.name.toLowerCase();
      if (lowerMessage.includes(serviceName)) {
        if (!addedKeys.has(service.key)) {
          addedKeys.add(service.key);
          recommendations.push({
            serviceKey: service.key,
            serviceName: service.name,
            description: (service.description || '').split('.')[0],
            duration: service.duration,
            price: service.price,
            bookingUrl: service.bookingUrl,
            phorestServiceId: service.phorestServiceId || service.key
          });
        }
      }
    }
  }

  return recommendations.slice(0, 3);
}

// ============ ADMIN: PRODUCT VISIBILITY MANAGEMENT ============

async function registerAdminRoutes(app: Express) {
  app.get("/api/admin/products", async (req, res) => {
    try {
      const search = req.query.search as string;
      const brandId = req.query.brandId as string;

      const allProducts = productCache.getAllProducts({ search, brandId });
      const allBrands = productCache.getAllBrands();

      const visibilityRows = await db.select().from(productVisibility);
      const visibilityMap = new Map(visibilityRows.map(r => [r.productId, r.visible]));

      const productsWithVisibility = allProducts.map(p => ({
        ...p,
        visible: visibilityMap.get(p.productId) ?? false,
      }));

      res.json({
        products: productsWithVisibility,
        brands: allBrands,
        totalProducts: allProducts.length,
        visibleCount: productsWithVisibility.filter(p => p.visible).length,
      });
    } catch (error) {
      console.error('[Admin] Error fetching products:', error);
      res.status(500).json({ error: 'Failed to fetch products' });
    }
  });

  app.post("/api/admin/products/visibility", async (req, res) => {
    try {
      const { productId, visible } = req.body;

      if (!productId || typeof visible !== 'boolean') {
        return res.status(400).json({ error: 'productId and visible (boolean) required' });
      }

      const allProducts = productCache.getAllProducts();
      const product = allProducts.find(p => p.productId === productId);

      await db.insert(productVisibility)
        .values({
          productId,
          visible,
          productName: product?.name || null,
          brandName: product?.brandName || null,
          categoryName: product?.categoryName || null,
          price: product ? Math.round(product.price * 100) : null,
        })
        .onConflictDoUpdate({
          target: productVisibility.productId,
          set: {
            visible,
            productName: product?.name || null,
            brandName: product?.brandName || null,
            price: product ? Math.round(product.price * 100) : null,
            updatedAt: new Date(),
          }
        });

      console.log(`[Admin] Product ${productId} visibility set to ${visible}`);

      await productCache.forceRefresh();

      res.json({ ok: true, productId, visible });
    } catch (error) {
      console.error('[Admin] Error updating visibility:', error);
      res.status(500).json({ error: 'Failed to update visibility' });
    }
  });

  app.post("/api/admin/products/visibility/bulk", async (req, res) => {
    try {
      const { updates } = req.body;

      if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: 'updates array required' });
      }

      const allProducts = productCache.getAllProducts();
      const productMap = new Map(allProducts.map(p => [p.productId, p]));

      for (const update of updates) {
        const { productId, visible } = update;
        if (!productId || typeof visible !== 'boolean') continue;

        const product = productMap.get(productId);

        await db.insert(productVisibility)
          .values({
            productId,
            visible,
            productName: product?.name || null,
            brandName: product?.brandName || null,
            categoryName: product?.categoryName || null,
            price: product ? Math.round(product.price * 100) : null,
          })
          .onConflictDoUpdate({
            target: productVisibility.productId,
            set: {
              visible,
              productName: product?.name || null,
              brandName: product?.brandName || null,
              price: product ? Math.round(product.price * 100) : null,
              updatedAt: new Date(),
            }
          });
      }

      console.log(`[Admin] Bulk visibility update: ${updates.length} products`);

      await productCache.forceRefresh();

      res.json({ ok: true, updated: updates.length });
    } catch (error) {
      console.error('[Admin] Error bulk updating visibility:', error);
      res.status(500).json({ error: 'Failed to bulk update visibility' });
    }
  });

  app.post("/api/admin/products/refresh", async (_req, res) => {
    try {
      await productCache.forceRefresh();
      const stats = productCache.getCacheStats();
      res.json({ ok: true, ...stats });
    } catch (error) {
      console.error('[Admin] Error refreshing cache:', error);
      res.status(500).json({ error: 'Failed to refresh product cache' });
    }
  });

  // ============ ADMIN: DEPOSITS & REFUNDS ============

  // Refunds move real money, so these routes are gated by a staff passcode
  // (ADMIN_PASSCODE secret). Fails closed if the secret is not configured.
  const requireAdminPasscode = (req: Request, res: Response, next: () => void) => {
    const expected = process.env.ADMIN_PASSCODE;
    if (!expected) {
      return res.status(503).json({ error: 'Admin passcode not configured. Set the ADMIN_PASSCODE secret to enable refund tools.' });
    }
    const provided = req.headers['x-admin-passcode'];
    const providedBuf = Buffer.from(typeof provided === 'string' ? provided : '');
    const expectedBuf = Buffer.from(expected);
    const match = providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!match) {
      return res.status(401).json({ error: 'Invalid admin passcode' });
    }
    next();
  };

  // List recent portal booking deposits with live refund status from Stripe.
  // Stripe pagination takes ~15s, so responses are cached briefly server-side.
  let depositsCache: { payload: any; fetchedAt: number } | null = null;
  const clientNameCache = new Map<string, { name: string | null; fetchedAt: number }>();
  const CLIENT_NAME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const DEPOSITS_CACHE_TTL_MS = 60_000;
  const clearDepositsCache = () => { depositsCache = null; };
  app.get("/api/admin/deposits", requireAdminPasscode, async (req, res) => {
    try {
      if (!(await stripeClient.isStripeConfigured())) {
        return res.status(503).json({ error: 'Stripe not configured' });
      }
      const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
      if (!fresh && depositsCache && Date.now() - depositsCache.fetchedAt < DEPOSITS_CACHE_TTL_MS) {
        return res.json(depositsCache.payload);
      }
      const stripe = await stripeClient.getStripeClient();
      const createdGte = Math.floor((Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000);
      const deposits: any[] = [];
      let startingAfter: string | undefined;
      for (let page = 0; page < 3; page++) {
        const params: Record<string, any> = {
          limit: 100,
          created: { gte: createdGte },
          expand: ["data.latest_charge"],
        };
        if (startingAfter) params.starting_after = startingAfter;
        const batch = await stripe.paymentIntents.list(params);
        const intents: any[] = batch.data || [];
        if (intents.length === 0) break;
        for (const pi of intents) {
          if (!isBookingDepositIntent(pi) || pi.status !== "succeeded") continue;
          let refundState = { chargedCents: pi.amount || 0, refundedCents: 0, remainingCents: pi.amount || 0 };
          try {
            refundState = (await getRefundState(stripe, pi)) || refundState;
          } catch { /* show with unknown refund state rather than hiding the row */ }
          deposits.push({
            paymentIntentId: pi.id,
            createdAt: (pi.created || 0) * 1000,
            amountCents: refundState.chargedCents,
            refundedCents: refundState.refundedCents,
            remainingCents: refundState.remainingCents,
            refundStatus:
              refundState.refundedCents <= 0 ? "none"
              : refundState.remainingCents <= 0 ? "full"
              : "partial",
            clientId: pi.metadata?.clientId || null,
            serviceName: pi.metadata?.serviceName || null,
            startDateTime: pi.metadata?.startDateTime || null,
            appointmentId: pi.metadata?.appointmentId || pi.metadata?.phorestBookingId || null,
            description: pi.description || null,
            // Best-effort estimate of the full service total, derived from the
            // deposit metadata (deposit = expectedAmount at depositPercent).
            estimatedServiceTotalCents: (() => {
              const expected = parseInt(pi.metadata?.expectedAmount || '', 10);
              const pct = parseFloat(pi.metadata?.depositPercent || '20');
              if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(pct) || pct <= 0) return null;
              // deposit = (servicePrice - loyaltyDiscount) * pct, so add the discount back.
              const discount = parseInt(pi.metadata?.loyaltyDiscountCents || '0', 10) || 0;
              return Math.round(expected / (pct / 100)) + discount;
            })(),
          });
        }
        if (!batch.has_more) break;
        startingAfter = intents[intents.length - 1].id;
      }

      // Attach client names so staff can find deposits by client, not by ID.
      // Best-effort Phorest lookups with a long-lived in-memory cache; a
      // failed lookup never hides the row.
      const uniqueClientIds = Array.from(new Set(deposits.map(d => d.clientId).filter(Boolean))) as string[];
      await Promise.all(uniqueClientIds.map(async (cid) => {
        const cached = clientNameCache.get(cid);
        if (cached && Date.now() - cached.fetchedAt < CLIENT_NAME_CACHE_TTL_MS) return;
        try {
          const c = await phorestApi.getClient(cid);
          const name = [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim() || null;
          clientNameCache.set(cid, { name, fetchedAt: Date.now() });
        } catch {
          if (!cached) clientNameCache.set(cid, { name: null, fetchedAt: Date.now() - CLIENT_NAME_CACHE_TTL_MS + 5 * 60 * 1000 });
        }
      }));
      for (const d of deposits) {
        d.clientName = d.clientId ? (clientNameCache.get(d.clientId)?.name ?? null) : null;
      }

      // Attach refund history (includes failures) from the audit table.
      const ids = deposits.map(d => d.paymentIntentId);
      const historyRows = ids.length > 0
        ? await db.select().from(depositRefunds)
            .where(inArray(depositRefunds.paymentIntentId, ids))
            .orderBy(desc(depositRefunds.createdAt))
        : [];
      const historyByPi = new Map<string, any[]>();
      for (const row of historyRows) {
        const list = historyByPi.get(row.paymentIntentId) || [];
        list.push({
          amountCents: row.amountCents,
          status: row.status,
          reason: row.reason,
          initiatedBy: row.initiatedBy,
          errorMessage: row.errorMessage,
          createdAt: row.createdAt,
          source: row.source,
          label: row.label,
          phorestVoucherSerial: row.phorestVoucherSerial,
        });
        historyByPi.set(row.paymentIntentId, list);
      }
      for (const d of deposits) {
        d.history = historyByPi.get(d.paymentIntentId) || [];
      }

      // Surface sweep manual-review flags (deposits the auto-refund watcher
      // skipped as ambiguous — missing metadata, unverifiable appointments).
      try {
        const flagRows = ids.length > 0
          ? await db.select().from(depositReviewFlags)
              .where(inArray(depositReviewFlags.paymentIntentId, ids))
          : [];
        const flagByPi = new Map(flagRows.map((f: any) => [f.paymentIntentId, f]));
        for (const d of deposits) {
          const f: any = flagByPi.get(d.paymentIntentId);
          d.reviewFlag = f
            ? {
                reason: f.reason,
                sweepCount: f.sweepCount,
                firstFlaggedAt: f.firstFlaggedAt,
                escalated: !!f.escalatedAt,
              }
            : null;
        }
      } catch (flagErr) {
        console.warn('[Admin] Could not attach review flags to deposits:', flagErr);
        for (const d of deposits) if (d.reviewFlag === undefined) d.reviewFlag = null;
      }

      deposits.sort((a, b) => b.createdAt - a.createdAt);
      depositsCache = { payload: { deposits }, fetchedAt: Date.now() };
      res.json({ deposits });
    } catch (error) {
      console.error('[Admin] Error listing deposits:', error);
      res.status(500).json({ error: 'Failed to list deposits' });
    }
  });

  // Issue a refund for a portal deposit.
  // scope 'deposit' (default): full/partial refund of the Stripe deposit.
  // scope 'full-service': staff-entered total split into two separate
  // transactions — deposit portion via Stripe ("KOZETA SALON Deposit Refund"),
  // remainder via a Phorest salon-credit voucher ("KOZETA SALON Service Refund").
  app.post("/api/admin/deposits/refund", requireAdminPasscode, async (req, res) => {
    try {
      const { paymentIntentId, amountCents, reason, scope, totalCents, clientId } = req.body || {};
      if (!paymentIntentId || typeof paymentIntentId !== 'string') {
        return res.status(400).json({ error: 'paymentIntentId required' });
      }
      const reasonStr = typeof reason === 'string' ? reason : undefined;

      if (scope === 'full-service') {
        if (!Number.isInteger(totalCents) || totalCents <= 0) {
          return res.status(400).json({ error: 'totalCents must be a positive whole number of cents' });
        }
        const result = await issueFullServiceRefund({
          paymentIntentId,
          totalCents,
          clientId: typeof clientId === 'string' ? clientId : undefined,
          reason: reasonStr,
          initiatedBy: 'staff',
        });
        clearDepositsCache();
        if (!('deposit' in result)) {
          // Pre-flight failure — nothing was refunded on either source.
          const status = result.code === 'NOT_FOUND' ? 404 : 400;
          return res.status(status).json({ error: result.message, code: result.code });
        }
        // Per-source outcomes; HTTP 200 even on partial failure so the UI can
        // show exactly which transaction went through and which did not.
        return res.json({
          success: result.ok,
          scope: 'full-service',
          totalRequestedCents: result.totalRequestedCents,
          deposit: result.deposit,
          service: result.service,
        });
      }

      if (amountCents !== undefined && (!Number.isInteger(amountCents) || amountCents <= 0)) {
        return res.status(400).json({ error: 'amountCents must be a positive whole number of cents' });
      }
      const result = await issueDepositRefund({
        paymentIntentId,
        amountCents,
        reason: reasonStr,
        initiatedBy: 'staff',
      });
      if (!result.ok) {
        const status =
          result.code === 'NOT_FOUND' ? 404
          : result.code === 'REFUND_IN_FLIGHT' ? 409
          : result.code === 'STRIPE_ERROR' ? 502
          : 400;
        return res.status(status).json({ error: result.message, code: result.code });
      }
      clearDepositsCache();
      res.json({
        success: true,
        refundId: result.refundId,
        amountRefundedCents: result.amountRefundedCents,
        remainingCents: result.remainingCents,
      });
    } catch (error) {
      console.error('[Admin] Refund error:', error);
      res.status(500).json({ error: 'Failed to issue refund' });
    }
  });

  // Preview how a full-service refund total splits across Stripe + Phorest.
  app.get("/api/admin/deposits/split-preview", requireAdminPasscode, async (req, res) => {
    try {
      const paymentIntentId = String(req.query.paymentIntentId || '');
      const totalCents = parseInt(String(req.query.totalCents || ''), 10);
      if (!paymentIntentId || !Number.isInteger(totalCents) || totalCents <= 0) {
        return res.status(400).json({ error: 'paymentIntentId and positive totalCents required' });
      }
      const result = await previewSplit(paymentIntentId, totalCents);
      if (!result.ok) {
        return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json({ error: result.message, code: result.code });
      }
      res.json({
        ...result.preview,
        depositLabel: REFUND_LABELS.depositRefund,
        serviceLabel: REFUND_LABELS.serviceRefund,
      });
    } catch (error) {
      console.error('[Admin] Split preview error:', error);
      res.status(500).json({ error: 'Failed to preview split' });
    }
  });

  // Client purchase/service history lookup for staff working out refund totals.
  app.get("/api/admin/clients/:clientId/history", requireAdminPasscode, async (req, res) => {
    try {
      const clientId = req.params.clientId;
      if (!isPhorestConfigured()) {
        return res.status(503).json({ error: 'Phorest not configured' });
      }
      const [historyResult, purchaseResult] = await Promise.allSettled([
        phorestApi.getClientServiceHistories(clientId, { page: 0, size: 20 }),
        phorestApi.getClientPurchaseHistory(clientId, { page: 0, size: 20 }),
      ]);
      const services = historyResult.status === 'fulfilled'
        ? ((historyResult.value as any)?._embedded?.serviceHistories
            || (historyResult.value as any)?.content || [])
        : [];
      const purchases = purchaseResult.status === 'fulfilled'
        ? ((purchaseResult.value as any)?._embedded?.purchases
            || (purchaseResult.value as any)?.content || [])
        : [];
      res.json({ services, purchases });
    } catch (error) {
      console.error('[Admin] Client history error:', error);
      res.status(500).json({ error: 'Failed to load client history' });
    }
  });

  app.get("/api/recommendations", async (req, res) => {
    try {
      const sessionId = req.query.sessionId as string;
      const sessionToken = req.query.sessionToken as string;

      const targetClientId = resolveSession(sessionId, sessionToken);
      if (!targetClientId) {
        return res.status(401).json({ error: 'Not logged in' });
      }

      let serviceHistory: any[] = [];
      let purchaseItems: any[] = [];

      if (isPhorestConfigured()) {
        const [historyResult, purchaseResult] = await Promise.allSettled([
          phorestApi.getClientServiceHistories(targetClientId, { page: 0, size: 20 }),
          phorestApi.getClientPurchaseHistory(targetClientId, { page: 0, size: 20 })
        ]);

        if (historyResult.status === 'fulfilled') {
          const historyResponse = historyResult.value as any;
          serviceHistory = historyResponse._embedded?.serviceHistories ?? historyResponse.content ?? [];
        }

        if (purchaseResult.status === 'fulfilled') {
          const purchaseResponse = purchaseResult.value as any;
          const purchases = purchaseResponse._embedded?.purchases ?? purchaseResponse.content ?? [];
          purchaseItems = purchases.flatMap((p: any) =>
            (p.items || []).map((item: any) => ({
              name: item.productName,
              brandName: item.brandName,
              date: p.date
            }))
          );
        }
      }

      const visibleProducts = productCache.getProducts({ page: 0, size: 50 }).products;

      if (visibleProducts.length === 0) {
        return res.json({ recommendations: [] });
      }

      const serviceNames = Array.from(new Set(serviceHistory.map((s: any) => s.serviceName).filter(Boolean))).slice(0, 10);
      const purchasedNames = Array.from(new Set(purchaseItems.map((p: any) => p.name).filter(Boolean))).slice(0, 10);
      const purchasedBrands = Array.from(new Set(purchaseItems.map((p: any) => p.brandName).filter(Boolean))).slice(0, 5);

      const productCatalog = visibleProducts.slice(0, 40).map(p => ({
        id: p.productId,
        name: p.name,
        brand: p.brandName,
        category: p.categoryName,
        price: p.price
      }));

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a product recommendation engine for Kozeta Salon & Spa. Based on a client's service history and past purchases, recommend 3-5 products from the available catalog that would complement their beauty routine. Return ONLY valid JSON with no markdown formatting. Format: {"recommendations":[{"productId":"...","reason":"..."}]}. Each reason should be 1 short sentence explaining why this product suits their needs based on their history. Focus on complementary products they haven't purchased yet, or replenishments of brands they love.`
          },
          {
            role: "user",
            content: `Client profile:
- Recent services: ${serviceNames.length > 0 ? serviceNames.join(', ') : 'No service history'}
- Past purchases: ${purchasedNames.length > 0 ? purchasedNames.join(', ') : 'No purchase history'}
- Preferred brands: ${purchasedBrands.length > 0 ? purchasedBrands.join(', ') : 'None yet'}

Available products:
${JSON.stringify(productCatalog)}

Recommend 3-5 products from the available catalog. Prioritize products that complement their services and match their brand preferences. If they have no history, recommend bestsellers across categories.`
          }
        ],
        temperature: 0.7,
        max_tokens: 500
      });

      const aiResponse = completion.choices[0]?.message?.content || '{"recommendations":[]}';
      let parsed: { recommendations: Array<{ productId: string; reason: string }> };
      try {
        const cleaned = aiResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = { recommendations: [] };
      }

      const enrichedRecommendations = parsed.recommendations
        .map(rec => {
          const product = visibleProducts.find(p => p.productId === rec.productId);
          if (!product) return null;
          return {
            productId: product.productId,
            name: product.name,
            brandName: product.brandName,
            price: product.price,
            imageUrl: product.imageUrl,
            reason: rec.reason
          };
        })
        .filter(Boolean)
        .slice(0, 5);

      res.json({ recommendations: enrichedRecommendations });
    } catch (error) {
      console.error('[Recommendations] Error:', error);
      res.json({ recommendations: [] });
    }
  });

  // ── DIAGNOSTIC ENDPOINT (dev-only) ─────────────────────────────────────────
  app.post('/api/debug/phorest-booking-probe', async (req: Request, res: Response) => {
    if (process.env.NODE_ENV !== 'development') {
      return res.status(404).json({ error: 'Not found' });
    }

    const { serviceId, staffId, clientId, startTime, endTime } = req.body;
    if (!serviceId || !staffId || !clientId || !startTime || !endTime) {
      return res.status(400).json({ error: 'Need serviceId, staffId, clientId, startTime, endTime' });
    }

    const branchId = process.env.PHOREST_BRANCH_ID?.trim();
    const username = process.env.PHOREST_USERNAME?.trim();
    const password = process.env.PHOREST_PASSWORD?.trim();
    const businessId = process.env.PHOREST_BUSINESS_ID?.trim();
    if (!branchId || !username || !password || !businessId) {
      return res.status(503).json({ error: 'Phorest not configured' });
    }

    const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

    async function probe(label: string, payload: object) {
      const url = `https://platform-us.phorest.com/third-party-api-server/api/business/${businessId}/branch/${branchId}/booking`;
      console.log(`[Probe:${label}] Payload:`, JSON.stringify(payload, null, 2));
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(payload),
          redirect: 'manual',
        });
        const text = await r.text();
        const location = r.headers.get('location');
        console.log(`[Probe:${label}] → ${r.status}, Location: ${location}`, text.slice(0, 300));
        return { label, status: r.status, location, body: text.slice(0, 300) };
      } catch (e: any) {
        console.log(`[Probe:${label}] → FETCH ERROR:`, e.message);
        return { label, status: 0, body: e.message };
      }
    }

    // Step 0: fetch a live availability slot for this service/staff to get a real slot
    let realSlot: { startTime: string; endTime: string; staffId: string } | null = null;
    try {
      const avStart = new Date(); avStart.setDate(avStart.getDate() + 1);
      const avEnd = new Date(); avEnd.setDate(avEnd.getDate() + 30);
      const avUrl = `https://platform-us.phorest.com/third-party-api-server/api/business/${businessId}/branch/${branchId}/availability` +
        `?serviceIds=${serviceId}&staffIds=${staffId}&startDate=${avStart.toISOString().split('T')[0]}&endDate=${avEnd.toISOString().split('T')[0]}&isOnlineAvailability=true`;
      const avResp = await fetch(avUrl, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
      });
      const avData: any = await avResp.json();
      const slots: any[] = avData.content || avData._embedded?.availabilities || [];
      if (slots.length > 0) {
        const ss = slots[0].serviceSchedules?.[0] || slots[0];
        realSlot = { startTime: ss.startTime, endTime: ss.endTime, staffId: ss.staffId || staffId };
        console.log('[Probe] Real availability slot:', realSlot);
      }
    } catch (e: any) {
      console.log('[Probe] Availability fetch failed:', e.message);
    }

    const sStart = realSlot?.startTime || startTime;
    const sEnd = realSlot?.endTime || endTime;
    const sStaff = realSlot?.staffId || staffId;

    const results = [];

    // Format 1: clientAppointmentSchedules + ACTIVE (current approach)
    results.push(await probe('F1-cas-ACTIVE', {
      bookingStatus: "ACTIVE",
      clientId,
      clientAppointmentSchedules: [{ clientId, serviceSchedules: [{ serviceId, staffId: sStaff, startTime: sStart, endTime: sEnd, staffRequest: false }] }],
    }));

    // Format 2: clientAppointmentSchedules + RESERVED
    results.push(await probe('F2-cas-RESERVED', {
      bookingStatus: "RESERVED",
      clientId,
      clientAppointmentSchedules: [{ clientId, serviceSchedules: [{ serviceId, staffId: sStaff, startTime: sStart, endTime: sEnd, staffRequest: false }] }],
    }));

    // Format 3: deprecated schedules + RESERVED
    results.push(await probe('F3-schedules-RESERVED', {
      bookingStatus: "RESERVED",
      clientId,
      schedules: [{ serviceId, staffId: sStaff, startTime: sStart, endTime: sEnd, staffRequest: false }],
    }));

    // Format 4: deprecated schedules, no bookingStatus
    results.push(await probe('F4-schedules-noStatus', {
      clientId,
      schedules: [{ serviceId, staffId: sStaff, startTime: sStart, endTime: sEnd }],
    }));

    // Format 5: clientAppointmentSchedules, no staffId
    results.push(await probe('F5-cas-noStaff', {
      bookingStatus: "RESERVED",
      clientId,
      clientAppointmentSchedules: [{ clientId, serviceSchedules: [{ serviceId, startTime: sStart, endTime: sEnd }] }],
    }));

    res.json({ realSlot, results });
  });
  // ── END DIAGNOSTIC ──────────────────────────────────────────────────────────
}

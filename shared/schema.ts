import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Canonical service recommendation type used across AI chat and floating dock
export const serviceRecommendationSchema = z.object({
  serviceKey: z.string(),
  serviceName: z.string(),
  phorestServiceId: z.string().optional(),
  description: z.string().optional(),
  duration: z.string().optional(),
  price: z.string().optional(),
  bookingUrl: z.string().optional(),
});

export type ServiceRecommendation = z.infer<typeof serviceRecommendationSchema>;

// Product recommendation returned by AI chat
export const productRecommendationSchema = z.object({
  productId: z.string(),
  name: z.string(),
  brandName: z.string(),
  categoryName: z.string(),
  price: z.number(),
  description: z.string(),
  imageUrl: z.string(),
  inStock: z.boolean(),
});

export type ProductRecommendation = z.infer<typeof productRecommendationSchema>;

// Chat message schema for AI Stylist conversations
export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.number(),
  recommendations: z.array(serviceRecommendationSchema).optional(),
  productRecommendations: z.array(productRecommendationSchema).optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

// Service schema for salon services
export const salonServiceSchema = z.object({
  key: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string(),
  duration: z.string(),
  price: z.string(),
  imageUrl: z.string().optional(),
  bookingUrl: z.string().optional(),
  phorestServiceId: z.string().optional(),
});

export type SalonService = z.infer<typeof salonServiceSchema>;

// Chat request/response schemas
export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema),
  userMessage: z.string(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chatResponseSchema = z.object({
  message: chatMessageSchema,
});

export type ChatResponse = z.infer<typeof chatResponseSchema>;

// Client profile schema for Phorest integration
export const clientProfileSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  loyaltyPoints: z.number().default(0),
  pointsToReward: z.number().default(300),
});

export type ClientProfile = z.infer<typeof clientProfileSchema>;

// Last visit schema
export const lastVisitSchema = z.object({
  serviceName: z.string(),
  date: z.string(),
  stylist: z.string().optional(),
  serviceIds: z.array(z.string()).optional(),
});

export type LastVisit = z.infer<typeof lastVisitSchema>;

// Product purchase schema
export const productPurchaseSchema = z.object({
  productName: z.string(),
  lastPurchased: z.string(),
  status: z.enum(["in-stock", "running-low", "out-of-stock"]),
});

export type ProductPurchase = z.infer<typeof productPurchaseSchema>;

// Client session data (stored after login)
export const clientSessionSchema = z.object({
  clientId: z.string(),
  profile: clientProfileSchema,
  lastVisit: lastVisitSchema.optional(),
  products: z.array(productPurchaseSchema).optional(),
  isLoggedIn: z.boolean(),
});

export type ClientSession = z.infer<typeof clientSessionSchema>;

// Login request schema - phone-only OTP flow
export const loginRequestSchema = z.object({
  phone: z.string().optional(),
  email: z.string().email().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  createIfNotFound: z.boolean().optional(),
}).refine(data => data.phone || data.email, {
  message: 'Either phone or email is required',
  path: ['phone'],
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

// OTP verification request
export const otpVerifySchema = z.object({
  otpId: z.string(),
  code: z.string().length(6),
});

export type OtpVerifyRequest = z.infer<typeof otpVerifySchema>;

// Update client name request
export const updateNameSchema = z.object({
  sessionId: z.string(),
  sessionToken: z.string().optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
});

export type UpdateNameRequest = z.infer<typeof updateNameSchema>;

// ============ PHOREST API SCHEMAS ============

// Phorest availability slot
export const availabilitySlotSchema = z.object({
  startDateTime: z.string(),
  endDateTime: z.string(),
  staffId: z.string(),
  staffName: z.string().optional(),
  available: z.boolean(),
  isAlternativeStaff: z.boolean().optional(),
});

export type AvailabilitySlot = z.infer<typeof availabilitySlotSchema>;

// Availability request (uses staffIds array per Phorest API)
export const availabilityRequestSchema = z.object({
  branchId: z.string().optional(),
  serviceIds: z.array(z.string()),
  staffIds: z.array(z.string()).optional(),
  from: z.string(),
  to: z.string(),
});

export type AvailabilityRequest = z.infer<typeof availabilityRequestSchema>;

// Availability response
export const availabilityResponseSchema = z.object({
  slots: z.array(availabilitySlotSchema),
  alternativesAvailable: z.boolean().optional(),
  alternativeCount: z.number().optional(),
});

export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

// Booking request (uses staffIds array per Phorest API)
export const bookingRequestSchema = z.object({
  branchId: z.string().optional(),
  serviceIds: z.array(z.string()),
  staffIds: z.array(z.string()).optional(),
  startDateTime: z.string(),
  notes: z.string().optional(),
  clientId: z.string().optional(),
  sessionId: z.string().optional(),
  sessionToken: z.string().optional(),
});

export type BookingRequest = z.infer<typeof bookingRequestSchema>;

// Booking response
export const bookingResponseSchema = z.object({
  bookingId: z.string(),
  appointmentId: z.string().optional(),
  clientId: z.string(),
  branchId: z.string(),
  staffId: z.string().optional(),
  staffName: z.string().optional(),
  startDateTime: z.string(),
  endDateTime: z.string().optional(),
  status: z.string(),
  services: z.array(z.object({
    serviceId: z.string(),
    serviceName: z.string(),
  })),
  confirmationNumber: z.string().optional(),
});

export type BookingResponse = z.infer<typeof bookingResponseSchema>;

// Phorest appointment
export const phorestAppointmentSchema = z.object({
  appointmentId: z.string(),
  clientId: z.string(),
  branchId: z.string(),
  staffId: z.string().optional(),
  staffName: z.string().optional(),
  startTime: z.string(),
  endTime: z.string(),
  status: z.string(),
  services: z.array(z.object({
    serviceId: z.string(),
    serviceName: z.string(),
    price: z.number().optional(),
    duration: z.number().optional(),
  })),
  notes: z.string().optional(),
});

export type PhorestAppointment = z.infer<typeof phorestAppointmentSchema>;

// Profile response (combined data from Phorest)
export const profileResponseSchema = z.object({
  clientId: z.string(),
  profile: clientProfileSchema,
  lastVisit: lastVisitSchema.optional(),
  upcomingAppointments: z.array(phorestAppointmentSchema).optional(),
  pastAppointments: z.array(phorestAppointmentSchema).optional(),
  loyalty: z.object({
    points: z.number(),
    tier: z.string().optional(),
    pointsToReward: z.number().optional(),
    rewards: z.array(z.object({
      name: z.string(),
      pointsRequired: z.number(),
      available: z.boolean(),
    })).optional(),
  }).optional(),
  products: z.array(productPurchaseSchema).optional(),
});

export type ProfileResponse = z.infer<typeof profileResponseSchema>;

// Phorest service (from API)
export const phorestServiceSchema = z.object({
  serviceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  price: z.number().optional(),
  duration: z.number().optional(),
  categoryId: z.string().optional(),
  categoryName: z.string().optional(),
});

export type PhorestService = z.infer<typeof phorestServiceSchema>;

// Phorest staff
export const phorestStaffSchema = z.object({
  staffId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().optional(),
  branchId: z.string().optional(),
});

export type PhorestStaff = z.infer<typeof phorestStaffSchema>;

// SMS companion conversation history — one row per E.164 phone number
export const smsConversations = pgTable("sms_conversations", {
  phone: text("phone").primaryKey(),
  clientId: text("client_id"),
  stripeCustomerId: text("stripe_customer_id"),
  messages: jsonb("messages").notNull().default([]),
  preferences: jsonb("preferences").notNull().default({}),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type SmsConversation = typeof smsConversations.$inferSelect;

// Dedupe table so each appointment reminder is sent exactly once
export const smsRemindersSent = pgTable("sms_reminders_sent", {
  id: text("id").primaryKey(),
  appointmentId: text("appointment_id").notNull(),
  phone: text("phone").notNull(),
  sentAt: timestamp("sent_at").defaultNow(),
});

export type SmsReminderSent = typeof smsRemindersSent.$inferSelect;

export const productVisibility = pgTable("product_visibility", {
  productId: text("product_id").primaryKey(),
  visible: boolean("visible").notNull().default(false),
  productName: text("product_name"),
  brandName: text("brand_name"),
  categoryName: text("category_name"),
  price: integer("price"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Pending payments (bookings + product orders) persisted in the database so they
// survive server restarts/deploys. Previously stored in memory, which caused
// paid-but-lost bookings when the server restarted mid-payment.
export const pendingPayments = pgTable("pending_payments", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // 'booking' | 'order'
  payload: jsonb("payload").notNull(),
  paymentIntentId: text("payment_intent_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type PendingPayment = typeof pendingPayments.$inferSelect;

// Session IDs revoked by logout, persisted so a server restart doesn't forget
// revocations (a logged-out client's saved token must never re-create a session).
export const revokedSessions = pgTable("revoked_sessions", {
  sessionId: text("session_id").primaryKey(),
  revokedAt: timestamp("revoked_at").notNull().defaultNow(),
});

export type RevokedSession = typeof revokedSessions.$inferSelect;

// Deposits flagged for manual review by the orphan sweep (legacy intents without
// verifiable metadata, or payments stuck in an unknown state). Persisted so
// flags survive server restarts and repeated flags escalate instead of
// silently re-warning forever.
export const depositReviewFlags = pgTable("deposit_review_flags", {
  paymentIntentId: text("payment_intent_id").primaryKey(),
  reason: text("reason").notNull(),
  sweepCount: integer("sweep_count").notNull().default(1),
  firstFlaggedAt: timestamp("first_flagged_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  escalatedAt: timestamp("escalated_at"),
});

export type DepositReviewFlag = typeof depositReviewFlags.$inferSelect;

// Refund history for portal deposits (staff refunds + automatic cancellation
// refunds). Stripe remains the source of truth for balances; this table gives
// staff a durable audit trail (who/when/how much/why, including failures).
export const depositRefunds = pgTable("deposit_refunds", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  paymentIntentId: text("payment_intent_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  stripeRefundId: text("stripe_refund_id"),
  status: text("status").notNull(), // 'succeeded' | 'failed'
  reason: text("reason"),
  initiatedBy: text("initiated_by").notNull(), // 'staff' | 'client-cancellation'
  errorMessage: text("error_message"),
  // Which source the money came back from: 'stripe' (deposit portion) or
  // 'phorest' (service portion, delivered as a salon credit voucher).
  source: text("source").notNull().default("stripe"),
  // Human-facing label, e.g. "KOZETA SALON Deposit Refund" / "KOZETA SALON Service Refund".
  label: text("label"),
  phorestVoucherId: text("phorest_voucher_id"),
  phorestVoucherSerial: text("phorest_voucher_serial"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type DepositRefund = typeof depositRefunds.$inferSelect;

export const insertProductVisibilitySchema = createInsertSchema(productVisibility).omit({
  updatedAt: true,
});

export type InsertProductVisibility = z.infer<typeof insertProductVisibilitySchema>;
export type ProductVisibility = typeof productVisibility.$inferSelect;

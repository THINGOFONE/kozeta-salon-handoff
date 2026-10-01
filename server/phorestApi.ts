// Phorest API wrapper - all Phorest communication goes through this module
// Credentials are read from environment variables, never exposed to client

const BASE_URL = process.env.PHOREST_BASE_URL || 
  "https://platform.phorest.com/third-party-api-server/api";

const WRITE_BASE_URL = process.env.PHOREST_WRITE_BASE_URL || 
  "https://platform-us.phorest.com/third-party-api-server/api";

const BUSINESS_ID = process.env.PHOREST_BUSINESS_ID;

let warnedWhitespace = false;

function buildAuthHeader(): string {
  const user = process.env.PHOREST_USERNAME?.trim();
  const pass = process.env.PHOREST_PASSWORD?.trim();
  
  if (!user || !pass || !BUSINESS_ID) {
    throw new Error("Missing Phorest environment variables (PHOREST_USERNAME, PHOREST_PASSWORD, PHOREST_BUSINESS_ID)");
  }
  
  // Debug: Check for common credential issues (warn once, not on every request)
  const hasWhitespace = user !== process.env.PHOREST_USERNAME || pass !== process.env.PHOREST_PASSWORD;
  if (hasWhitespace && !warnedWhitespace) {
    warnedWhitespace = true;
    console.warn('[Phorest] WARNING: Credentials have leading/trailing whitespace (trimmed)');
  }
  
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return `Basic ${token}`;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: Record<string, any>;
  /** Suppress error logging for expected failures (e.g. optional endpoints that 404) */
  quiet?: boolean;
}

// All Phorest calls are aborted after this timeout so a hanging API can never stall the server
const PHOREST_REQUEST_TIMEOUT_MS = 15000;

// Structured error thrown by phorestRequest so callers can classify failures by
// HTTP status code instead of grepping error message strings.
// - status: the HTTP status Phorest returned (undefined for timeouts/network drops)
// - body: the raw response body text (undefined for timeouts)
// - isTimeout: true when the request was aborted by our timeout
export class PhorestApiError extends Error {
  status?: number;
  body?: string;
  isTimeout: boolean;

  constructor(message: string, opts: { status?: number; body?: string; isTimeout?: boolean } = {}) {
    super(message);
    this.name = 'PhorestApiError';
    this.status = opts.status;
    this.body = opts.body;
    this.isTimeout = opts.isTimeout ?? false;
  }
}

// Detail codes Phorest uses (sometimes with a 400 status) that indicate a true
// slot conflict rather than a validation error.
const CONFLICT_DETAIL_CODES = ['SLOT_UNAVAILABLE', 'STAFF_DOUBLE_BOOKED', 'SLOT_CONFLICT'];

export interface PhorestErrorClassification {
  /** True slot conflict: HTTP 409, or a known conflict detail code in the body */
  isSlotConflict: boolean;
  /** Definite failure (4xx): Phorest certainly did NOT create the booking */
  isDefiniteFailure: boolean;
  /** HTTP status if known (undefined for timeouts/network errors) */
  status?: number;
  /** Human-readable reason parsed from the Phorest error body, if any */
  reason?: string;
}

// Single shared classifier for Phorest booking errors — used by both /api/book
// and the payment finalize path so conflict handling can never drift apart.
export function classifyPhorestError(err: unknown): PhorestErrorClassification {
  if (err instanceof PhorestApiError) {
    const body = err.body || '';
    let reason: string | undefined;
    try {
      const parsed = JSON.parse(body);
      reason = parsed.detail || parsed.message || parsed.error;
    } catch { /* body not JSON */ }
    const hasConflictCode = CONFLICT_DETAIL_CODES.some(code => body.includes(code));
    return {
      isSlotConflict: err.status === 409 || hasConflictCode,
      isDefiniteFailure: err.status !== undefined && err.status >= 400 && err.status < 500,
      status: err.status,
      reason,
    };
  }
  // Fallback for non-structured errors (should be rare): message heuristics only.
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isSlotConflict: msg.includes(' 409 ') || msg.includes(':409 ')
      || CONFLICT_DETAIL_CODES.some(code => msg.includes(code)),
    isDefiniteFailure: /failed:\s*4\d\d/.test(msg),
  };
}

async function phorestRequest<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", query, body, quiet = false } = options;
  
  const baseUrl = (method === "POST" || method === "PUT" || method === "DELETE") ? WRITE_BASE_URL : BASE_URL;
  const url = new URL(`${baseUrl}/business/${BUSINESS_ID}${path}`);
  
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
  }
  
  const headers: Record<string, string> = {
    Authorization: buildAuthHeader(),
    Accept: "application/json",
  };
  
  // Debug: Log the request URL (not auth header for security)
  console.log(`[Phorest] ${method} ${url.toString()}`);
  
  const fetchOptions: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(PHOREST_REQUEST_TIMEOUT_MS),
  };
  
  if (body) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(body);
  }
  
  fetchOptions.headers = headers;
  
  let response: Response;
  let text: string;
  try {
    response = await fetch(url.toString(), fetchOptions);
    text = await response.text();
  } catch (fetchError: any) {
    if (fetchError?.name === 'TimeoutError' || fetchError?.name === 'AbortError') {
      if (!quiet) console.error(`Phorest API timeout: ${method} ${path} exceeded ${PHOREST_REQUEST_TIMEOUT_MS}ms`);
      throw new PhorestApiError(`Phorest ${method} ${path} timed out`, { isTimeout: true });
    }
    throw fetchError;
  }
  
  if (!response.ok) {
    if (!quiet) {
      console.error(`Phorest API error: ${method} ${path} - ${response.status}`, text);
    }
    throw new PhorestApiError(`Phorest ${method} ${path} failed: ${response.status} ${text}`, {
      status: response.status,
      body: text,
    });
  }
  
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

// ============ CLIENT ENDPOINTS ============

export interface PhorestClient {
  clientId: string;
  firstName: string;
  lastName: string;
  email?: string;
  mobile?: string;
  landline?: string;
  gender?: string;
  notes?: string;
  banned?: boolean;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PhorestClientListResponse {
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  content: PhorestClient[];
}

export interface CreateClientPayload {
  firstName: string;
  lastName: string;
  email?: string;
  mobile?: string;
  landline?: string;
  gender?: string;
  notes?: string;
}

export async function listClients(query: {
  page?: number;
  size?: number;
  mobile?: string;
  landLine?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
} = {}): Promise<PhorestClientListResponse> {
  return phorestRequest<PhorestClientListResponse>("/client", { method: "GET", query });
}

export async function getClient(clientId: string): Promise<PhorestClient> {
  return phorestRequest<PhorestClient>(`/client/${clientId}`, { method: "GET" });
}

export async function createClient(payload: CreateClientPayload): Promise<PhorestClient> {
  return phorestRequest<PhorestClient>("/client", { method: "POST", body: payload });
}

export async function updateClient(clientId: string, payload: Partial<CreateClientPayload>): Promise<PhorestClient> {
  return phorestRequest<PhorestClient>(`/client/${clientId}`, { method: "PUT", body: payload });
}

// ============ SERVICE HISTORY ============

export interface PhorestServiceHistory {
  serviceHistoryId: string;
  clientId: string;
  serviceName: string;
  staffName?: string;
  staffId?: string;
  price?: number;
  date: string;
  notes?: string;
}

export interface PhorestServiceHistoryResponse {
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  content: PhorestServiceHistory[];
}

export async function getClientServiceHistories(
  clientId: string, 
  query: { page?: number; size?: number } = {}
): Promise<PhorestServiceHistoryResponse> {
  return phorestRequest<PhorestServiceHistoryResponse>(
    `/client/${clientId}/servicehistory`, 
    { method: "GET", query }
  );
}

// ============ APPOINTMENTS ============

export interface PhorestAppointment {
  appointmentId: string;
  clientId: string;
  branchId: string;
  staffId?: string;
  staffName?: string;
  startTime: string;
  endTime: string;
  status: string;
  services: Array<{
    serviceId: string;
    serviceName: string;
    price?: number;
    duration?: number;
  }>;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PhorestAppointmentListResponse {
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  content: PhorestAppointment[];
}

export async function listAppointments(query: {
  clientId?: string;
  branchId?: string;
  staffId?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  size?: number;
} = {}): Promise<PhorestAppointmentListResponse> {
  const branchId = query.branchId || process.env.PHOREST_BRANCH_ID;
  if (!branchId) {
    throw new Error("Branch ID required to list appointments");
  }
  // Convert camelCase to snake_case for Phorest API
  const phorestQuery: Record<string, string | number> = {};
  if (query.clientId) phorestQuery.client_id = query.clientId;
  if (query.staffId) phorestQuery.staff_id = query.staffId;
  if (query.fromDate) phorestQuery.from_date = query.fromDate;
  if (query.toDate) phorestQuery.to_date = query.toDate;
  if (query.page !== undefined) phorestQuery.page = query.page;
  if (query.size !== undefined) phorestQuery.size = query.size;
  
  return phorestRequest<PhorestAppointmentListResponse>(`/branch/${branchId}/appointment`, { method: "GET", query: phorestQuery });
}

export async function getAppointment(appointmentId: string, branchId?: string): Promise<PhorestAppointment> {
  const branch = branchId || process.env.PHOREST_BRANCH_ID;
  if (!branch) {
    throw new Error("Branch ID required to get appointment");
  }
  return phorestRequest<PhorestAppointment>(`/branch/${branch}/appointment/${appointmentId}`, { method: "GET" });
}

// ============ AVAILABILITY ============
// Uses official Phorest endpoint: POST /branch/{branchId}/appointments/availability

export interface ServiceSelection {
  serviceId: string;
  staffId?: string;
}

export interface ClientServiceSelection {
  clientId?: string;
  serviceSelections: ServiceSelection[];
}

export interface CheckAvailabilityRequest {
  branchId?: string;
  startTime: string;
  endTime: string;
  clientServiceSelections: ClientServiceSelection[];
  clientId?: string;
  isOnlineAvailability?: boolean;
}

export interface ServiceSchedule {
  serviceId: string;
  startTime: string;
  endTime?: string;
  staffId: string;
  roomId?: string;
  staffRequest?: boolean;
  alternativeStaffMember?: boolean;
  price?: number;
}

export interface ClientSchedule {
  clientId?: string;
  serviceSchedules: ServiceSchedule[];
}

export interface AvailabilitySlot {
  startTime: string;
  clientSchedules: ClientSchedule[];
}

export interface PhorestAvailabilityResponse {
  data: AvailabilitySlot[];
}

export async function checkAppointmentAvailability(
  body: CheckAvailabilityRequest
): Promise<PhorestAvailabilityResponse> {
  const branchId = body.branchId || process.env.PHOREST_BRANCH_ID;
  if (!branchId) {
    throw new Error("Branch ID required to check availability");
  }
  const { branchId: _, ...bodyWithoutBranch } = body;
  return phorestRequest<PhorestAvailabilityResponse>(`/branch/${branchId}/appointments/availability`, {
    method: "POST",
    body: bodyWithoutBranch,
  });
}

// ============ BOOKING ============
// Uses official Phorest endpoint: POST /branch/{branchId}/booking
// Correct payload format confirmed from https://developer.phorest.com/reference/createbooking
// Uses `clientAppointmentSchedules` (NOT `clientSchedules`, NOT `appointments`)
// bookingStatus: "ACTIVE" creates a confirmed booking in one step — no separate activate needed.

export interface CreateBookingPayload {
  branchId?: string;
  clientId: string;
  serviceIds: string[];
  staffIds?: string[];
  startDateTime: string;
  endDateTime?: string;
  note?: string;
  depositAmountCents?: number;
  // "ACTIVE" (default) confirms the booking in one step.
  // "RESERVED" creates a temporary hold that must be confirmed via activateBooking()
  // — this is the supported flow for recording an external deposit against the booking.
  bookingStatus?: "ACTIVE" | "RESERVED";
}

// Actual Phorest POST /booking response shape (201 Created)
export interface PhorestBookingRawResponse {
  clientId: string;
  bookingId?: string;
  bookingStatus?: string;
  schedules?: Array<{
    appointmentId?: string;
    serviceId?: string;
    staffId?: string;
    startTime?: string;
    endTime?: string;
  }>;
  clientAppointmentSchedules?: Array<{
    clientId?: string;
    serviceSchedules?: Array<{
      appointmentId?: string;
      serviceId?: string;
      staffId?: string;
      startTime?: string;
      endTime?: string;
    }>;
  }>;
}

// Normalized booking response (used throughout the app)
export interface PhorestBookingResponse {
  bookingId: string;        // appointmentId from schedules[0] or clientAppointmentSchedules[0].serviceSchedules[0]
  appointmentId?: string;
  phorestBookingId?: string; // the real Phorest booking id (needed to call activateBooking)
  clientId: string;
  staffId?: string;
  startDateTime: string;
  endDateTime?: string;
  bookingStatus?: string;
}

export async function createBooking(body: CreateBookingPayload): Promise<PhorestBookingResponse> {
  const branchId = body.branchId || process.env.PHOREST_BRANCH_ID;
  if (!branchId) {
    throw new Error("Branch ID required to create booking");
  }

  const staffId = body.staffIds?.[0];

  // Fallback endTime when caller didn't provide one: use the real cached service
  // duration(s) from Phorest; 1 hour only as a last resort for unknown services.
  let endTime = body.endDateTime;
  if (!endTime) {
    let durationMinutes: number | undefined;
    try {
      const serviceCache = await import('./services/serviceCache');
      durationMinutes = serviceCache.getTotalDurationMinutes(body.serviceIds);
    } catch { /* cache unavailable — use last-resort default */ }
    endTime = new Date(
      new Date(body.startDateTime).getTime() + (durationMinutes || 60) * 60 * 1000
    ).toISOString();
  }

  // Official Phorest booking format (source: developer.phorest.com/reference/createbooking)
  // Field: clientAppointmentSchedules[].serviceSchedules[]
  // note: singular (max 50,000 chars)
  // bookingStatus: "ACTIVE" creates a confirmed booking in one step
  const serviceSchedules = body.serviceIds.map(serviceId => ({
    serviceId,
    startTime: body.startDateTime,
    endTime,
    staffId: staffId || undefined,
    staffRequest: staffId ? false : undefined,
  }));

  const phorestPayload: Record<string, any> = {
    bookingStatus: body.bookingStatus || "ACTIVE",
    clientId: body.clientId,
    clientAppointmentSchedules: [{
      clientId: body.clientId,
      serviceSchedules,
    }],
    ...(body.note ? { note: body.note } : {}),
  };

  console.log('[Phorest] Booking payload:', JSON.stringify(phorestPayload, null, 2));

  const raw = await phorestRequest<PhorestBookingRawResponse>(`/branch/${branchId}/booking`, {
    method: "POST",
    body: phorestPayload,
  });

  console.log('[Phorest] Booking response:', JSON.stringify(raw, null, 2));

  // Normalize: Phorest returns appointmentId inside schedules[] or clientAppointmentSchedules[].serviceSchedules[]
  const firstSchedule = raw.schedules?.[0]
    ?? raw.clientAppointmentSchedules?.[0]?.serviceSchedules?.[0];
  const appointmentId = firstSchedule?.appointmentId;
  const resolvedStaffId = firstSchedule?.staffId || staffId;
  const resolvedStartTime = firstSchedule?.startTime || body.startDateTime;
  const resolvedEndTime = firstSchedule?.endTime || endTime;

  if (!appointmentId) {
    console.warn('[Phorest] Booking created but no appointmentId in response:', JSON.stringify(raw));
  }

  const normalized: PhorestBookingResponse = {
    bookingId: appointmentId || `booking-${Date.now()}`,
    appointmentId,
    phorestBookingId: raw.bookingId,
    clientId: raw.clientId,
    staffId: resolvedStaffId,
    startDateTime: resolvedStartTime,
    endDateTime: resolvedEndTime,
    bookingStatus: raw.bookingStatus || body.bookingStatus || "ACTIVE",
  };

  return normalized;
}

// Confirms a RESERVED booking and, when a deposit is supplied, records it against
// the booking so Phorest reduces the client's remaining balance at checkout.
// THROWS on failure: the caller must treat activation failure as fatal (e.g. refund
// the deposit) — a paid-but-unactivated booking would leave the client without a
// confirmed appointment while the RESERVED hold silently expires.
export async function activateBooking(
  branchId: string,
  bookingId: string,
  depositAmountCents?: number
): Promise<void> {
  const branch = branchId || process.env.PHOREST_BRANCH_ID;
  if (!branch) {
    throw new Error("Branch ID required to activate booking");
  }

  const activateBody: Record<string, any> = {};
  if (depositAmountCents && depositAmountCents > 0) {
    // Phorest expects deposit in dollars (float), not cents
    activateBody.depositAmount = depositAmountCents / 100;
  }

  console.log(`[Phorest] Activating booking ${bookingId}`, Object.keys(activateBody).length ? activateBody : '(no deposit)');

  await phorestRequest(`/branch/${branch}/booking/${bookingId}/activate`, {
    method: "POST",
    body: activateBody,
  });
  console.log(`[Phorest] Booking ${bookingId} activated successfully`);
}

// ============ BRANCHES ============

export interface PhorestBranch {
  branchId: string;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  timezone?: string;
}

export interface PhorestBranchListResponse {
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  content: PhorestBranch[];
}

export async function listBranches(query: {
  page?: number;
  size?: number;
} = {}): Promise<PhorestBranchListResponse> {
  return phorestRequest<PhorestBranchListResponse>("/branch", { method: "GET", query });
}

// ============ SERVICES & STAFF ============

export interface StaffCategoryPrice {
  id: string;  // staffId
  price: number;
}

export interface PhorestService {
  serviceId: string;
  name: string;
  description?: string;
  price?: number;
  duration?: number;
  categoryId?: string;
  categoryName?: string;
  internetEnabled?: boolean;
  internetDescription?: string;
  disqualifiedStaff?: string[];  // Staff IDs who CANNOT perform this service
  staffCategories?: {
    prices?: StaffCategoryPrice[];  // Custom pricing per staff
  };
}

// Raw API response format (Phorest uses _embedded)
export interface PhorestServiceListResponseRaw {
  _embedded?: {
    services: PhorestService[];
  };
  page?: {
    size: number;
    totalElements: number;
    totalPages: number;
    number: number;
  };
}

export interface PhorestServiceListResponse {
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  content: PhorestService[];
}

export async function listBranchServices(query: {
  branchId?: string;
  page?: number;
  size?: number;
} = {}): Promise<PhorestServiceListResponse> {
  const branchId = query.branchId || process.env.PHOREST_BRANCH_ID;
  if (!branchId) {
    throw new Error("Branch ID required to list services");
  }
  const { branchId: _, ...restQuery } = query;
  const raw = await phorestRequest<PhorestServiceListResponseRaw>(`/branch/${branchId}/service`, { method: "GET", query: restQuery });
  
  // Convert from Phorest _embedded format to standard format
  return {
    page: raw.page?.number || 0,
    size: raw.page?.size || 0,
    totalElements: raw.page?.totalElements || 0,
    totalPages: raw.page?.totalPages || 0,
    content: raw._embedded?.services || []
  };
}

// Get a single service by ID with full details including disqualifiedStaff
export async function getServiceById(serviceId: string, branchId?: string): Promise<PhorestService | null> {
  const bid = branchId || process.env.PHOREST_BRANCH_ID;
  if (!bid) {
    throw new Error("Branch ID required");
  }
  
  // Fetch all services and find the matching one (Phorest doesn't have a single service endpoint)
  let page = 0;
  const pageSize = 100;
  
  while (true) {
    const response = await listBranchServices({ branchId: bid, page, size: pageSize });
    const service = response.content.find(s => s.serviceId === serviceId);
    if (service) {
      return service;
    }
    if (page >= response.totalPages - 1) {
      break;
    }
    page++;
  }
  
  return null;
}

export interface PhorestServiceCategory {
  serviceCategoryId: string;
  name: string;
  description?: string;
}

export interface PhorestServiceCategoryResponse {
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  content: PhorestServiceCategory[];
}

export async function listServiceCategories(query: {
  page?: number;
  size?: number;
} = {}): Promise<PhorestServiceCategoryResponse> {
  return phorestRequest<PhorestServiceCategoryResponse>("/servicecategory", { method: "GET", query, quiet: true });
}

export interface PhorestStaff {
  staffId: string;
  firstName: string;
  lastName: string;
  email?: string;
  mobile?: string;
  branchId?: string;
  staffCategoryId?: string;
  staffCategoryName?: string;
}

// Raw API response format for staff (Phorest uses _embedded)
export interface PhorestStaffListResponseRaw {
  _embedded?: {
    staff?: PhorestStaff[];
    staffs?: PhorestStaff[];  // API uses both 'staff' and 'staffs' 
  };
  page?: {
    size: number;
    totalElements: number;
    totalPages: number;
    number: number;
  };
}

export interface PhorestStaffListResponse {
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  content: PhorestStaff[];
}

export async function listStaff(query: {
  branchId?: string;
  page?: number;
  size?: number;
} = {}): Promise<PhorestStaffListResponse> {
  const branchId = query.branchId || process.env.PHOREST_BRANCH_ID;
  if (!branchId) {
    throw new Error("Branch ID required to list staff");
  }
  const { branchId: _, ...restQuery } = query;
  const raw = await phorestRequest<PhorestStaffListResponseRaw>(`/branch/${branchId}/staff`, { method: "GET", query: restQuery });
  
  // Convert from Phorest _embedded format to standard format
  // API returns either 'staff' or 'staffs' in _embedded
  const staffArray = raw._embedded?.staff || raw._embedded?.staffs || [];
  return {
    page: raw.page?.number || 0,
    size: raw.page?.size || 0,
    totalElements: raw.page?.totalElements || staffArray.length,
    totalPages: raw.page?.totalPages || 1,
    content: staffArray
  };
}

// ============ LOYALTY ============
// Note: Loyalty points are also returned on the client object from GET /client
// POST /changeloyaltypoints is used to manually adjust loyalty points

export interface PhorestLoyaltyBalance {
  clientId: string;
  points: number;
  tier?: string;
  expiringPoints?: number;
  expirationDate?: string;
}

export interface ChangeLoyaltyPointsPayload {
  clientId: string;
  points: number;
  reason?: string;
  transactionType?: 'add' | 'remove' | 'set';
}

export interface ChangeLoyaltyPointsResponse {
  clientId: string;
  previousPoints: number;
  newPoints: number;
  pointsChanged: number;
}

export async function getClientLoyalty(clientId: string): Promise<PhorestLoyaltyBalance> {
  return phorestRequest<PhorestLoyaltyBalance>(`/client/${clientId}/loyalty`, { method: "GET" });
}

export async function changeLoyaltyPoints(
  body: ChangeLoyaltyPointsPayload
): Promise<ChangeLoyaltyPointsResponse> {
  return phorestRequest<ChangeLoyaltyPointsResponse>("/changeloyaltypoints", {
    method: "POST",
    body,
  });
}

// ============ PRODUCTS / SALES ============

export interface PhorestProduct {
  productId: string;
  name: string;
  description?: string;
  price?: number;
  sku?: string;
  barcode?: string;
  categoryId?: string;
  categoryName?: string;
  brandId?: string;
  brandName?: string;
  imageUrl?: string;
  stockLevel?: number;
  inStock?: boolean;
  supplierId?: string;
  supplierName?: string;
}

export interface PhorestProductListResponse {
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  content: PhorestProduct[];
}

export async function listProducts(query: {
  page?: number;
  size?: number;
  brandId?: string;
  categoryId?: string;
  branchId?: string;
} = {}): Promise<PhorestProductListResponse> {
  const branchId = query.branchId || process.env.PHOREST_BRANCH_ID;
  if (!branchId) {
    throw new Error("Branch ID required to list products");
  }
  const { branchId: _, ...restQuery } = query;
  return phorestRequest<PhorestProductListResponse>(`/branch/${branchId}/product`, { method: "GET", query: restQuery });
}

export async function getProduct(productId: string, branchId?: string): Promise<PhorestProduct> {
  const branch = branchId || process.env.PHOREST_BRANCH_ID;
  if (!branch) {
    throw new Error("Branch ID required to get product");
  }
  return phorestRequest<PhorestProduct>(`/branch/${branch}/product/${productId}`, { method: "GET" });
}

export interface PhorestPurchaseHistory {
  saleId: string;
  clientId: string;
  date: string;
  items: Array<{
    productId: string;
    productName: string;
    quantity: number;
    price: number;
  }>;
  total: number;
}

export interface PhorestPurchaseHistoryResponse {
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  content: PhorestPurchaseHistory[];
}

export async function getClientPurchaseHistory(
  clientId: string,
  query: { page?: number; size?: number } = {}
): Promise<PhorestPurchaseHistoryResponse> {
  return phorestRequest<PhorestPurchaseHistoryResponse>(
    `/client/${clientId}/purchasehistory`,
    { method: "GET", query }
  );
}

// ============ CREATE PURCHASE ============
// Uses official Phorest endpoint: POST /createpurchase
// Used to reflect external sales (e.g., from Stripe) in Phorest

export interface CreatePurchaseItem {
  productId: string;
  quantity: number;
  price: number;
}

export interface CreatePurchasePayload {
  clientId: string;
  branchId: string;
  items: CreatePurchaseItem[];
  total: number;
  notes?: string;
  externalReference?: string;
}

export interface CreatePurchaseResponse {
  saleId: string;
  clientId: string;
  branchId: string;
  items: Array<{
    productId: string;
    productName?: string;
    quantity: number;
    price: number;
  }>;
  total: number;
  createdAt: string;
}

export async function createPurchase(
  body: CreatePurchasePayload
): Promise<CreatePurchaseResponse> {
  return phorestRequest<CreatePurchaseResponse>("/createpurchase", {
    method: "POST",
    body,
  });
}

// ============ VOUCHERS ============
// Verified live (July 2026): POST /business/{id}/voucher creates a salon
// credit voucher (201) when issueDate/expiryDate are provided. This is the
// only API-supported way to move service-side money back to a client —
// /createpurchase rejects negative totals (404), and DELETE /voucher is
// not supported.

export interface CreateVoucherPayload {
  clientId: string;
  /** Voucher balance in dollars. */
  originalBalance: number;
  creatingBranchId: string;
  issueDate: string; // ISO datetime
  expiryDate: string; // ISO datetime
}

export interface PhorestVoucher {
  voucherId: string;
  serialNumber: string;
  clientId: string;
  creatingBranchId: string;
  originalBalance: number;
  remainingBalance: number;
  issueDate: string;
  expiryDate: string;
}

export async function createVoucher(body: CreateVoucherPayload): Promise<PhorestVoucher> {
  return phorestRequest<PhorestVoucher>("/voucher", { method: "POST", body });
}

// ============ CANCEL APPOINTMENT ============

export async function cancelAppointment(appointmentId: string, branchId?: string): Promise<any> {
  const branch = branchId || process.env.PHOREST_BRANCH_ID;
  if (!branch) {
    throw new Error("Branch ID required to cancel appointment");
  }
  // Phorest cancellation (verified live):
  //  - DELETE on /appointment/{id} is NOT supported (returns 500 "method not supported").
  //  - PUT on /appointment/{id} with state=CANCELLED returns 200 but is silently ignored
  //    (the `state` field is read-only; cancellation is tracked in `activationState`).
  //  - The correct endpoint is POST /branch/{id}/appointment/cancel with the
  //    appointment id(s) passed as the repeatable `appointment_id` QUERY parameter.
  //    On success the appointment's `activationState` becomes CANCELED.
  return phorestRequest(`/branch/${branch}/appointment/cancel`, {
    method: "POST",
    query: { appointment_id: appointmentId },
  });
}

// ============ HELPER FUNCTIONS ============

export function isPhorestConfigured(): boolean {
  return !!(
    process.env.PHOREST_USERNAME &&
    process.env.PHOREST_PASSWORD &&
    process.env.PHOREST_BUSINESS_ID
  );
}

export function getBusinessId(): string {
  if (!BUSINESS_ID) {
    throw new Error("PHOREST_BUSINESS_ID not configured");
  }
  return BUSINESS_ID;
}

const PLACEHOLDER_PATTERNS = [
  'your-',
  'your_',
  'example',
  'placeholder',
  'xxx',
  'test-branch',
  'default-branch',
  '<branch',
  '{branch'
];

function isPlaceholderValue(value: string): boolean {
  const lower = value.toLowerCase().trim();
  return PLACEHOLDER_PATTERNS.some(pattern => lower.includes(pattern)) || lower.length < 5;
}

export function getBranchId(): string | undefined {
  const branchId = process.env.PHOREST_BRANCH_ID;
  
  if (!branchId || branchId.trim() === '') {
    return undefined;
  }
  
  const trimmed = branchId.trim();
  
  if (isPlaceholderValue(trimmed)) {
    throw new Error(
      `Invalid PHOREST_BRANCH_ID: "${trimmed}" appears to be a placeholder value. ` +
      `Please set a valid branch ID from your Phorest account, or remove/clear this environment variable to omit branchId from requests.`
    );
  }
  
  return trimmed;
}

export function validateBranchIdOrThrow(branchId?: string): void {
  if (branchId && isPlaceholderValue(branchId)) {
    throw new Error(
      `Invalid PHOREST_BRANCH_ID: "${branchId}" appears to be a placeholder. ` +
      `Please set a valid branch ID from your Phorest account, or leave it empty to use the default branch.`
    );
  }
}

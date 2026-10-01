import * as phorestApi from '../phorestApi';

interface StaffServiceCache {
  services: Map<string, phorestApi.PhorestService>;  // serviceId -> service
  staff: Map<string, phorestApi.PhorestStaff>;       // staffId -> staff
  qualifiedStaffByService: Map<string, string[]>;   // serviceId -> qualified staffIds
  lastSync: Date | null;
  isWarming: boolean;
}

const cache: StaffServiceCache = {
  services: new Map(),
  staff: new Map(),
  qualifiedStaffByService: new Map(),
  lastSync: null,
  isWarming: false
};

// Canonical display order for online booking (by Phorest staffId)
// Order is maintained exactly — staff not in this list are excluded from online booking
export const STAFF_DISPLAY_ORDER = [
  'uZKb3AncnByhAez0wDBjWA', // 1. KOZETA IZETI
  'sT7ix3bm23VwU1_XB3wGyQ', // 2. ZANA TOMASOVIC
  'cdQ0_XZj4LLlEpWx-DUrAQ', // 3. ROYA MASSAH
  'ougaXPjitvASEWY1VcZHwA', // 4. LAUREN SHOSTAL
  'E-qRBVbV2ZsbrYFSS_VtyQ', // 5. ARMANDO FRASCA
  'L6bM1QjSOPh1CIrlGiBW-g', // 6. AMELA CAPE
  'cz5oLRQINSPMV3220O1JYg', // 7. ASMA YOUSIFI
  'BgJsTWzWCaOMX8SWW0kGBw', // 8. DONI CHERRY
];

// Approved stylists for online booking (derived from display order — single source of truth)
const APPROVED_STYLIST_IDS = new Set(STAFF_DISPLAY_ORDER);

function isServiceProvider(staff: phorestApi.PhorestStaff): boolean {
  return APPROVED_STYLIST_IDS.has(staff.staffId);
}

export async function warmCache(): Promise<void> {
  if (cache.isWarming) {
    console.log('[StaffServiceSync] Already warming, skipping...');
    return;
  }

  cache.isWarming = true;
  console.log('[StaffServiceSync] Starting cache warm-up...');

  try {
    const branchId = process.env.PHOREST_BRANCH_ID;
    if (!branchId) {
      throw new Error('PHOREST_BRANCH_ID not configured');
    }

    // Fetch all staff
    const staffResponse = await phorestApi.listStaff({ branchId, page: 0, size: 100 });
    if (!staffResponse || !staffResponse.content) {
      throw new Error('Failed to fetch staff from Phorest');
    }
    const allStaff = staffResponse.content.filter(isServiceProvider);
    console.log(`[StaffServiceSync] Found ${allStaff.length} service providers (filtered from ${staffResponse.totalElements || 0} total)`);

    // Build new maps first, then swap atomically — a mid-refresh Phorest failure
    // must never leave clients with missing stylists or a partial service list.
    const newStaff = new Map<string, phorestApi.PhorestStaff>();
    for (const staff of allStaff) {
      newStaff.set(staff.staffId, staff);
    }

    // Fetch all services with disqualifiedStaff
    const allServices: phorestApi.PhorestService[] = [];
    let page = 0;
    const pageSize = 100;
    
    while (true) {
      const response = await phorestApi.listBranchServices({ branchId, page, size: pageSize });
      if (!response || !response.content) {
        // Abort the whole refresh — keep the existing complete cache
        throw new Error(`Failed to fetch services page ${page}; keeping existing cache`);
      }
      allServices.push(...response.content);
      console.log(`[StaffServiceSync] Fetched page ${page + 1}/${response.totalPages || 1} of services`);
      
      if (page >= (response.totalPages || 1) - 1) {
        break;
      }
      page++;
    }

    console.log(`[StaffServiceSync] Found ${allServices.length} total services`);

    const newServices = new Map<string, phorestApi.PhorestService>();
    const newQualified = new Map<string, string[]>();

    const allStaffIds = Array.from(newStaff.keys());

    for (const service of allServices) {
      newServices.set(service.serviceId, service);

      // Calculate qualified staff = all staff - disqualified staff
      const disqualified = new Set(service.disqualifiedStaff || []);
      const qualified = allStaffIds.filter(staffId => !disqualified.has(staffId));
      
      newQualified.set(service.serviceId, qualified);
    }

    // Atomic swap: replace all maps together only after a fully successful build
    cache.staff = newStaff;
    cache.services = newServices;
    cache.qualifiedStaffByService = newQualified;
    cache.lastSync = new Date();
    console.log(`[StaffServiceSync] Cache warmed with ${cache.services.size} services, ${cache.staff.size} staff at ${cache.lastSync.toISOString()}`);

  } catch (error) {
    console.error('[StaffServiceSync] Cache warm-up failed:', error);
    // Cold-start recovery: if we have no data at all, retry quickly instead of
    // waiting for the next background refresh interval.
    if (cache.services.size === 0) {
      scheduleColdStartRetry();
    }
  } finally {
    cache.isWarming = false;
  }
}

let coldStartRetryTimer: NodeJS.Timeout | null = null;
function scheduleColdStartRetry(): void {
  if (coldStartRetryTimer) return;
  console.log('[StaffServiceSync] Cache empty after failed warm-up — retrying in 30s');
  coldStartRetryTimer = setTimeout(async () => {
    coldStartRetryTimer = null;
    if (cache.services.size === 0 && !cache.isWarming) {
      await warmCache();
    }
  }, 30_000);
}

export function getQualifiedStaffForService(serviceId: string): string[] {
  const qualified = cache.qualifiedStaffByService.get(serviceId);
  if (qualified) {
    return qualified;
  }
  return [];
}

export function getService(serviceId: string): phorestApi.PhorestService | undefined {
  return cache.services.get(serviceId);
}

export function getStaff(staffId: string): phorestApi.PhorestStaff | undefined {
  return cache.staff.get(staffId);
}

export function getAllStaff(): phorestApi.PhorestStaff[] {
  return Array.from(cache.staff.values());
}

export function getAllServices(): phorestApi.PhorestService[] {
  return Array.from(cache.services.values());
}

export function getQualifiedStaffDetails(serviceId: string): phorestApi.PhorestStaff[] {
  const staffIds = getQualifiedStaffForService(serviceId);
  return staffIds.map(id => cache.staff.get(id)).filter(Boolean) as phorestApi.PhorestStaff[];
}

export function getCacheStatus(): { lastSync: Date | null; serviceCount: number; staffCount: number; isWarming: boolean } {
  return {
    lastSync: cache.lastSync,
    serviceCount: cache.services.size,
    staffCount: cache.staff.size,
    isWarming: cache.isWarming
  };
}

export function isCacheReady(): boolean {
  return cache.lastSync !== null && cache.services.size > 0 && cache.staff.size > 0;
}

// Background refresh
let refreshInterval: NodeJS.Timeout | null = null;

export function startBackgroundRefresh(intervalMs: number = 5 * 60 * 1000): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  
  refreshInterval = setInterval(async () => {
    console.log('[StaffServiceSync] Background refresh triggered');
    await warmCache();
  }, intervalMs);
  
  console.log(`[StaffServiceSync] Background refresh scheduled every ${intervalMs / 1000 / 60} minutes`);
}

export function stopBackgroundRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

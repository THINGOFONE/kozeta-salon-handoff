import { useState, useEffect, useRef, useCallback } from "react";
import { Calendar as CalendarIcon, Clock, User, Loader2, Check, Phone, Users, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { AvailabilitySlot, BookingResponse } from "@shared/schema";

const SALON_PHONE = "(416) 932-3131";
const SALON_CONTACT_MESSAGE = `Please call us at ${SALON_PHONE} to book your appointment.`;
const SYNC_INTERVAL_MS = 45000; // Soft-refresh availability every 45 seconds

interface StaffMember {
  staffId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  photo?: string;
  staffCategoryName?: string;
  imageUrl?: string;
}

// Context for pending booking when auth is required
export interface PendingBookingContext {
  slot: AvailabilitySlot;
  serviceIds: string[];
  staffId?: string;
  branchId?: string;
  serviceName: string;
  servicePrice?: string;
}

// Context for payment required
export interface PaymentBookingContext {
  serviceIds: string[];
  staffIds: string[];
  startDateTime: string;
  endDateTime?: string;
  branchId?: string;
  serviceName: string;
  servicePrice?: string;
}

interface AvailabilityPickerProps {
  serviceIds: string[];
  serviceName: string;
  servicePrice?: string;
  branchId?: string;
  clientId?: string;
  sessionId?: string;
  onBookingComplete?: (booking: BookingResponse) => void;
  onCancel?: () => void;
  onAuthRequired?: (context: PendingBookingContext) => void;
  onPaymentRequired?: (context: PaymentBookingContext) => void;
  /** Increment to signal the chosen slot was taken elsewhere (e.g. during payment) —
   *  the picker clears the selection, shows a gentle notice, and refreshes times. */
  slotConflictNonce?: number;
}

export function AvailabilityPicker({
  serviceIds,
  serviceName,
  servicePrice,
  branchId,
  clientId,
  sessionId,
  onBookingComplete,
  onCancel,
  onAuthRequired,
  onPaymentRequired,
  slotConflictNonce
}: AvailabilityPickerProps) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const [selectedStaff, setSelectedStaff] = useState<StaffMember | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date>(today);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const [unavailableMessage, setUnavailableMessage] = useState<string>("");
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [authTriggered, setAuthTriggered] = useState(false);
  
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const previousSlotsRef = useRef<string>("");
  const lastRefreshErrorToastRef = useRef<number>(0);
  const { toast } = useToast();

  const staffQuery = useQuery<{ _embedded?: { staffs: StaffMember[] }; staff?: StaffMember[] }>({
    queryKey: ['/api/phorest/staff']
  });

  // Get staff who can perform this specific service (includes per-staff pricing)
  const serviceStaffQuery = useQuery<{ 
    staffIds: string[]; 
    serviceId: string; 
    basePrice?: number;
    staffPrices?: Record<string, number>;
    staffDetails?: { staffId: string; name: string; price?: number }[];
  }>({
    queryKey: ['/api/phorest/staff-for-service', serviceIds[0], branchId],
    queryFn: async () => {
      if (!serviceIds[0]) return { staffIds: [], serviceId: '' };
      const params = new URLSearchParams({ serviceId: serviceIds[0] });
      if (branchId) params.append('branchId', branchId);
      const response = await fetch(`/api/phorest/staff-for-service?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch staff for service');
      return response.json();
    },
    enabled: !!serviceIds[0]
  });

  const allStaff = staffQuery.data?._embedded?.staffs || staffQuery.data?.staff || [];
  
  // Filter staff to only show those who can perform this service
  // If query succeeded but returned empty, show the empty state (no fallback to all staff)
  const eligibleStaffIds = serviceStaffQuery.data?.staffIds || [];
  const hasServiceStaffData = serviceStaffQuery.isSuccess && !serviceStaffQuery.isLoading;
  const staff = hasServiceStaffData && eligibleStaffIds.length > 0
    ? allStaff.filter(s => eligibleStaffIds.includes(s.staffId))
    : hasServiceStaffData 
      ? [] // Query succeeded but no eligible staff found - show empty state
      : allStaff; // Still loading or error - show all as fallback during loading

  const availabilityMutation = useMutation({
    mutationFn: async ({ date, staffId, isAutoRefresh = false }: { date: Date; staffId?: string; isAutoRefresh?: boolean }) => {
      if (isAutoRefresh) setIsAutoRefreshing(true);
      
      const from = date.toISOString().split('T')[0];
      const to = from;
      
      const payload: Record<string, unknown> = { serviceIds, from, to };
      if (branchId) payload.branchId = branchId;
      if (staffId) payload.staffIds = [staffId];
      
      try {
        const response = await apiRequest("POST", "/api/availability", payload);
        return response.json();
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        
        // Check for 503 service unavailable
        if (errorMessage.startsWith('503:') || errorMessage.includes('BOOKING_UNAVAILABLE')) {
          setServiceUnavailable(true);
          setUnavailableMessage(SALON_CONTACT_MESSAGE);
          throw new Error('BOOKING_UNAVAILABLE');
        }
        
        throw err;
      }
    },
    onSuccess: (data) => {
      setIsAutoRefreshing(false);
      setLastSyncTime(new Date());
      
      // Check if slots changed and notify user
      const newSlotsKey = JSON.stringify(data.slots?.map((s: AvailabilitySlot) => s.startDateTime) || []);
      if (previousSlotsRef.current && previousSlotsRef.current !== newSlotsKey) {
        // Slots changed - clear selection if selected slot is no longer available
        if (selectedSlot) {
          const stillAvailable = data.slots?.some(
            (s: AvailabilitySlot) => s.startDateTime === selectedSlot.startDateTime
          );
          if (!stillAvailable) {
            setSelectedSlot(null);
            setShowConfirm(false);
            toast({
              title: "That time was just booked",
              description: "The times below are up to date — please pick another one.",
            });
          }
        }
      }
      previousSlotsRef.current = newSlotsKey;
    },
    onError: (_error, variables) => {
      setIsAutoRefreshing(false);
      const isAutoRefresh = (variables as any)?.isAutoRefresh;
      // Always tell the user a manual availability check failed;
      // throttle auto-refresh failure toasts to once per 2 minutes to avoid spam.
      const now = Date.now();
      if (!isAutoRefresh || now - lastRefreshErrorToastRef.current > 2 * 60 * 1000) {
        lastRefreshErrorToastRef.current = now;
        toast({
          title: "Couldn't refresh availability",
          description: "We had trouble checking the latest times. Please try again in a moment.",
          variant: "destructive",
        });
      }
    }
  });

  const bookingMutation = useMutation({
    mutationFn: async (slot: AvailabilitySlot) => {
      const sessionToken = localStorage.getItem('kozeta_session_token') || undefined;
      const payload: Record<string, unknown> = {
        serviceIds,
        staffIds: selectedStaff?.staffId ? [selectedStaff.staffId] : (slot.staffId ? [slot.staffId] : []),
        startDateTime: slot.startDateTime,
        clientId,
        sessionId,
        sessionToken
      };
      if (branchId) payload.branchId = branchId;
      
      try {
        const response = await apiRequest("POST", "/api/book", payload);
        return response.json();
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.log('[Booking] Error caught:', errorMessage);
        
        // Check for 401 auth error
        if (errorMessage.startsWith('401:')) {
          console.log('[Booking] 401 detected - throwing AUTH_REQUIRED');
          const authError = new Error('AUTH_REQUIRED') as Error & { code: string };
          authError.code = 'AUTH_REQUIRED';
          throw authError;
        }
        
        // Check for slot conflict (someone booked this time moments earlier)
        if (errorMessage.includes('SLOT_CONFLICT')) {
          const conflictError = new Error('SLOT_CONFLICT') as Error & { code: string };
          conflictError.code = 'SLOT_CONFLICT';
          throw conflictError;
        }
        
        // Check for 503 service unavailable
        if (errorMessage.startsWith('503:') || errorMessage.includes('BOOKING_UNAVAILABLE')) {
          setServiceUnavailable(true);
          setUnavailableMessage(SALON_CONTACT_MESSAGE);
          throw new Error('BOOKING_UNAVAILABLE');
        }
        
        throw err;
      }
    },
    onSuccess: (data: BookingResponse) => {
      // Refresh availability after successful booking
      if (selectedStaff) {
        availabilityMutation.mutate({ 
          date: selectedDate, 
          staffId: selectedStaff.staffId,
          isAutoRefresh: true 
        });
      }
      onBookingComplete?.(data);
    },
    onError: (error: Error & { code?: string }) => {
      console.log('[Booking] onError called:', { 
        errorCode: error.code, 
        errorMessage: error.message,
        hasSelectedSlot: !!selectedSlot,
        hasOnAuthRequired: !!onAuthRequired 
      });
      
      // Handle auth required - open login modal
      if (error.code === 'AUTH_REQUIRED') {
        console.log('[Booking] AUTH_REQUIRED detected');
        if (selectedSlot && onAuthRequired) {
          console.log('[Booking] Triggering login flow');
          setAuthTriggered(true); // Suppress error message while login modal is showing
          onAuthRequired({
            slot: selectedSlot,
            serviceIds,
            staffId: selectedStaff?.staffId,
            branchId,
            serviceName,
            servicePrice
          });
          return; // Don't show error or refresh - let login flow handle it
        } else {
          console.log('[Booking] Cannot trigger login - missing:', { 
            selectedSlot: !!selectedSlot, 
            onAuthRequired: !!onAuthRequired 
          });
        }
      }
      
      // Tailored message when the slot was just taken by someone else
      if (error.code === 'SLOT_CONFLICT') {
        toast({
          title: "That time was just taken",
          description: "Someone booked it moments ago. Here are the closest available times.",
        });
      }
      
      // Refresh availability after failed booking (slot might have been taken)
      if (selectedStaff) {
        setSelectedSlot(null);
        setShowConfirm(false);
        availabilityMutation.mutate({ 
          date: selectedDate, 
          staffId: selectedStaff.staffId,
          isAutoRefresh: true 
        });
      }
    }
  });

  // Soft-refresh availability every 45 seconds while the picker is open
  const refreshAvailability = useCallback(() => {
    // Guard against overlapping requests
    if (selectedStaff && !showConfirm && !bookingMutation.isPending && !availabilityMutation.isPending) {
      availabilityMutation.mutate({ 
        date: selectedDate, 
        staffId: selectedStaff.staffId,
        isAutoRefresh: true 
      });
    }
  }, [selectedStaff, selectedDate, showConfirm, bookingMutation.isPending, availabilityMutation.isPending]);

  useEffect(() => {
    // Start polling when staff is selected
    if (selectedStaff) {
      intervalRef.current = setInterval(refreshAvailability, SYNC_INTERVAL_MS);
    }
    
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [selectedStaff, refreshAvailability]);

  // Refresh on window focus (user returns to tab)
  useEffect(() => {
    const handleFocus = () => {
      if (selectedStaff && !showConfirm) {
        refreshAvailability();
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [selectedStaff, showConfirm, refreshAvailability]);

  useEffect(() => {
    if (selectedStaff) {
      availabilityMutation.mutate({ date: selectedDate, staffId: selectedStaff.staffId });
    }
  }, [selectedStaff]);

  // A slot conflict happened elsewhere (e.g. during payment finalization):
  // clear the stale selection, show a gentle notice, and refresh the times.
  const prevConflictNonceRef = useRef(slotConflictNonce ?? 0);
  useEffect(() => {
    const nonce = slotConflictNonce ?? 0;
    if (nonce !== prevConflictNonceRef.current) {
      prevConflictNonceRef.current = nonce;
      setSelectedSlot(null);
      setShowConfirm(false);
      toast({
        title: "That time was just taken",
        description: "Your deposit was not kept. Here are the closest available times.",
      });
      if (selectedStaff) {
        availabilityMutation.mutate({
          date: selectedDate,
          staffId: selectedStaff.staffId,
          isAutoRefresh: true
        });
      }
    }
  }, [slotConflictNonce]);

  // Reset auth state when user logs in (clientId becomes available)
  useEffect(() => {
    if (clientId && authTriggered) {
      setAuthTriggered(false);
      bookingMutation.reset(); // Clear any previous error state
    }
  }, [clientId, authTriggered]);

  const handleStaffSelect = (staffMember: StaffMember) => {
    setSelectedStaff(staffMember);
    setSelectedSlot(null);
    setShowConfirm(false);
  };

  const handleDateSelect = (date: Date | undefined) => {
    if (!date) return;
    if (date < today) return;
    
    setSelectedDate(date);
    setSelectedSlot(null);
    setShowConfirm(false);
    availabilityMutation.mutate({ date, staffId: selectedStaff?.staffId });
  };

  const handleSlotSelect = (slot: AvailabilitySlot) => {
    setSelectedSlot(slot);
    setShowConfirm(true);
  };

  const getStaffSpecificPrice = (): string => {
    if (selectedStaff?.staffId && serviceStaffQuery.data?.staffPrices) {
      const staffPrice = serviceStaffQuery.data.staffPrices[selectedStaff.staffId];
      if (staffPrice != null) return `$${Math.round(staffPrice)}`;
    }
    if (serviceStaffQuery.data?.basePrice != null) {
      return `$${Math.round(serviceStaffQuery.data.basePrice)}`;
    }
    return servicePrice || "";
  };

  const handleConfirmBooking = () => {
    if (!selectedSlot) return;
    
    // If user is logged in and payment is enabled, trigger payment flow
    if (clientId && onPaymentRequired) {
      onPaymentRequired({
        serviceIds,
        staffIds: selectedStaff?.staffId ? [selectedStaff.staffId] : (selectedSlot.staffId ? [selectedSlot.staffId] : []),
        startDateTime: selectedSlot.startDateTime,
        endDateTime: selectedSlot.endDateTime,
        branchId,
        serviceName,
        servicePrice: getStaffSpecificPrice()
      });
      return;
    }
    
    // Otherwise, try direct booking (will trigger auth if not logged in)
    bookingMutation.mutate(selectedSlot);
  };

  const handleBackToStaff = () => {
    setSelectedStaff(null);
    setSelectedSlot(null);
    setShowConfirm(false);
  };

  const formatTime = (isoString: string) => {
    return new Date(isoString).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
  };

  const slots = availabilityMutation.data?.slots || [];
  const alternativesAvailable = availabilityMutation.data?.alternativesAvailable || false;
  const alternativeCount = availabilityMutation.data?.alternativeCount || 0;

  if (showConfirm && selectedSlot) {
    return (
      <div className="bg-white dark:bg-card rounded-xl shadow-sm border border-border/50" data-testid="availability-picker">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/30">
          <h3 className="font-semibold text-foreground text-sm uppercase tracking-wide">
            Confirm Booking
          </h3>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => setShowConfirm(false)}
            className="text-xs text-muted-foreground hover:text-foreground"
            data-testid="button-back-to-times"
          >
            Back
          </Button>
        </div>

        <div className="p-5 space-y-4">
          <div className="bg-muted/30 rounded-xl p-4 space-y-3 border border-border/30">
            <div className="flex items-center justify-between gap-2">
              <h4 className="font-semibold text-foreground">{serviceName}</h4>
              <span className="text-sm font-semibold text-foreground" data-testid="text-confirm-price">{getStaffSpecificPrice()}</span>
            </div>
            
            <div className="space-y-2.5 text-sm">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                  <CalendarIcon className="w-4 h-4 text-primary" />
                </div>
                <span className="text-foreground">{formatDate(selectedDate)}</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                  <Clock className="w-4 h-4 text-primary" />
                </div>
                <span className="text-foreground font-medium">{formatTime(selectedSlot.startDateTime)}</span>
              </div>
              {(selectedSlot.staffName || selectedStaff) && (
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <User className="w-4 h-4 text-primary" />
                  </div>
                  <span className="text-foreground">with {selectedSlot.staffName || `${selectedStaff?.firstName} ${selectedStaff?.lastName}`}</span>
                </div>
              )}
            </div>
          </div>

          <Button 
            onClick={handleConfirmBooking}
            disabled={bookingMutation.isPending}
            className="w-full h-12 rounded-full font-semibold text-sm"
            data-testid="button-confirm-booking"
          >
            {bookingMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Booking...
              </>
            ) : (
              <>
                <Check className="w-4 h-4 mr-2" />
                Confirm Booking
              </>
            )}
          </Button>

          {bookingMutation.isError && !authTriggered && (
            <p className="text-sm text-destructive text-center">
              Failed to create booking. Please try again.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (bookingMutation.isSuccess) {
    return (
      <div className="bg-white dark:bg-card rounded-xl shadow-sm border border-border/50 p-6" data-testid="availability-picker">
        <div className="text-center py-4 space-y-3">
          <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
            <Check className="w-8 h-8 text-green-600 dark:text-green-400" />
          </div>
          <h4 className="font-semibold text-lg text-green-600 dark:text-green-400">Booking Confirmed!</h4>
          <p className="text-sm text-muted-foreground">
            {bookingMutation.data?.confirmationNumber && (
              <>Confirmation: <span className="font-medium text-foreground">{bookingMutation.data.confirmationNumber}</span></>
            )}
          </p>
        </div>
      </div>
    );
  }

  if (serviceUnavailable) {
    return (
      <div className="bg-white dark:bg-card rounded-xl shadow-sm border border-border/50" data-testid="availability-picker">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/30">
          <h3 className="font-semibold text-foreground text-sm uppercase tracking-wide">
            Book {serviceName}
          </h3>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground" data-testid="button-cancel-booking">
              Back
            </Button>
          )}
        </div>

        <div className="p-5">
          <div className="text-center py-8 space-y-4">
            <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto">
              <Phone className="w-8 h-8 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="space-y-2">
              <h4 className="font-semibold text-foreground">Online Booking Unavailable</h4>
              <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                {unavailableMessage}
              </p>
            </div>
            <a 
              href="tel:+14169323131" 
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors"
              data-testid="link-call-salon"
            >
              <Phone className="w-4 h-4" />
              {SALON_PHONE}
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (!selectedStaff) {
    return (
      <div className="bg-white dark:bg-card rounded-xl shadow-sm border border-border/50" data-testid="availability-picker">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/30">
          <div>
            <h3 className="font-semibold text-foreground text-sm uppercase tracking-wide">
              Select Your Stylist
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              for {serviceName}
            </p>
          </div>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground" data-testid="button-cancel-booking">
              Cancel
            </Button>
          )}
        </div>

        <div className="p-4">
          {(staffQuery.isLoading || serviceStaffQuery.isLoading) ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
              <span className="ml-2 text-sm text-muted-foreground">Loading stylists...</span>
            </div>
          ) : staffQuery.isError ? (
            <div className="text-center py-8 space-y-4">
              <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto">
                <Phone className="w-8 h-8 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="space-y-2">
                <h4 className="font-semibold text-foreground">Online Booking Unavailable</h4>
                <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                  {SALON_CONTACT_MESSAGE}
                </p>
              </div>
              <a 
                href="tel:+14169323131" 
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors"
                data-testid="link-call-salon"
              >
                <Phone className="w-4 h-4" />
                {SALON_PHONE}
              </a>
            </div>
          ) : staff.length === 0 ? (
            <div className="text-center py-8 space-y-4">
              <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto">
                <Phone className="w-8 h-8 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="space-y-2">
                <h4 className="font-semibold text-foreground">No Staff Available</h4>
                <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                  No stylists are currently available for {serviceName}. Please call us to book this service.
                </p>
              </div>
              <a 
                href="tel:+14169323131" 
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors"
                data-testid="link-call-salon"
              >
                <Phone className="w-4 h-4" />
                {SALON_PHONE}
              </a>
            </div>
          ) : (
            <ScrollArea className="h-72">
              <div className="space-y-2 pr-2">
                <button
                  onClick={() => handleStaffSelect({ staffId: '', firstName: 'Any', lastName: 'Available Stylist' })}
                  className="w-full p-3.5 rounded-xl bg-primary/5 border border-primary/20 hover:border-primary/40 flex items-center gap-3 text-left transition-all"
                  data-testid="button-staff-any"
                >
                  <Avatar className="w-11 h-11 border-2 border-primary/30">
                    <AvatarFallback className="bg-primary text-primary-foreground">
                      <Users className="w-5 h-5" />
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-semibold text-foreground text-sm">Any Available Stylist</p>
                    <p className="text-xs text-muted-foreground">First available appointment</p>
                  </div>
                </button>
                {staff.map((staffMember) => {
                  const staffPrice = serviceStaffQuery.data?.staffPrices?.[staffMember.staffId];
                  const basePrice = serviceStaffQuery.data?.basePrice;
                  const displayPrice = staffPrice ?? basePrice;

                  return (
                    <button
                      key={staffMember.staffId}
                      onClick={() => handleStaffSelect(staffMember)}
                      className="w-full p-3.5 rounded-xl bg-muted/50 border border-border/50 hover:border-primary/30 hover:bg-muted flex items-center gap-3 text-left transition-all"
                      data-testid={`button-staff-${staffMember.staffId}`}
                    >
                      <Avatar className="w-11 h-11 border-2 border-border/50">
                        {(staffMember.imageUrl || staffMember.photo) && (
                          <AvatarImage 
                            src={staffMember.imageUrl || staffMember.photo} 
                            alt={`${staffMember.firstName} ${staffMember.lastName}`} 
                          />
                        )}
                        <AvatarFallback className="bg-primary/10 text-primary text-sm">
                          {staffMember.firstName?.[0]}{staffMember.lastName?.[0]}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-foreground text-sm">
                          {staffMember.firstName} {staffMember.lastName}
                        </p>
                        <p className="text-xs text-muted-foreground uppercase tracking-wide">
                          {staffMember.staffCategoryName || 'Stylist'}
                        </p>
                      </div>
                      {displayPrice != null && (
                        <span className="text-sm font-semibold text-foreground tabular-nums" data-testid={`text-staff-price-${staffMember.staffId}`}>
                          ${Math.round(displayPrice)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-card rounded-xl shadow-sm border border-border/50" data-testid="availability-picker">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/30">
        <div className="flex items-center gap-3">
          <Avatar className="w-10 h-10 border-2 border-primary/20">
            {(selectedStaff.imageUrl || selectedStaff.photo) && (
              <AvatarImage 
                src={selectedStaff.imageUrl || selectedStaff.photo} 
                alt={`${selectedStaff.firstName} ${selectedStaff.lastName}`} 
              />
            )}
            <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
              {selectedStaff.firstName?.[0]}{selectedStaff.lastName?.[0]}
            </AvatarFallback>
          </Avatar>
          <div>
            <p className="font-semibold text-foreground text-sm">with {selectedStaff.firstName.toUpperCase()} {selectedStaff.lastName.toUpperCase()}</p>
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{selectedStaff.staffCategoryName || serviceName}</p>
          </div>
        </div>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={handleBackToStaff} 
          className="text-xs text-muted-foreground hover:text-foreground"
          data-testid="button-back-to-staff"
        >
          Change
        </Button>
      </div>

      {/* Calendar Section */}
      <div className="px-4 py-4">
        <div className="flex justify-center">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={handleDateSelect}
            disabled={(date) => date < today}
            className="rounded-lg border-0 shadow-none [&_.rdp-months]:justify-center [&_.rdp-caption]:text-sm [&_.rdp-caption]:font-semibold [&_.rdp-caption]:text-foreground [&_.rdp-nav]:gap-1 [&_.rdp-head_th]:text-xs [&_.rdp-head_th]:font-medium [&_.rdp-head_th]:text-muted-foreground [&_.rdp-cell]:p-0.5 [&_.rdp-day]:h-9 [&_.rdp-day]:w-9 [&_.rdp-day]:text-sm [&_.rdp-day]:font-medium [&_.rdp-day]:text-foreground [&_.rdp-day_selected]:bg-primary [&_.rdp-day_selected]:text-primary-foreground [&_.rdp-day_today]:bg-primary/20 [&_.rdp-day_today]:text-primary [&_.rdp-day_today]:font-bold dark:[&_.rdp-day_today]:bg-primary/30"
            data-testid="calendar-date-picker"
          />
        </div>
      </div>

      {/* Available Times Section */}
      <div className="px-5 pb-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Available times for <span className="font-semibold text-foreground">{selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {isAutoRefreshing ? (
              <>
                <RefreshCw className="w-3 h-3 animate-spin text-primary" />
                <span>Syncing</span>
              </>
            ) : lastSyncTime && (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                <span>Live</span>
              </>
            )}
          </div>
        </div>

        {availabilityMutation.isPending && !isAutoRefreshing ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
            <span className="ml-2 text-sm text-muted-foreground">Checking availability...</span>
          </div>
        ) : slots.length === 0 ? (
          <div className="text-center py-8 bg-muted/30 rounded-xl">
            <Clock className="w-8 h-8 mx-auto mb-3 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">
              {selectedStaff.firstName} is fully booked
            </p>
            {alternativesAvailable ? (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-muted-foreground">
                  {alternativeCount} time{alternativeCount !== 1 ? 's' : ''} available with other stylists
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStaffSelect({ staffId: '', firstName: 'Any', lastName: 'Available Stylist' })}
                  className="text-xs"
                  data-testid="button-show-alternatives"
                >
                  <Users className="w-3 h-3 mr-1.5" />
                  Show Available Stylists
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">Try selecting a different day</p>
            )}
          </div>
        ) : (
          <ScrollArea className="h-56">
            <div className="grid grid-cols-3 gap-2.5 pr-2">
              {slots.map((slot: AvailabilitySlot, idx: number) => (
                <button
                  key={idx}
                  onClick={() => handleSlotSelect(slot)}
                  className={`
                    py-2.5 px-3 rounded-full text-center transition-all font-medium text-sm
                    border
                    ${selectedSlot?.startDateTime === slot.startDateTime
                      ? 'bg-primary text-primary-foreground border-primary shadow-md'
                      : 'bg-white dark:bg-card border-border/60 text-foreground hover:border-primary/50 hover:bg-primary/5'
                    }
                  `}
                  data-testid={`button-slot-${idx}`}
                >
                  {formatTime(slot.startDateTime)}
                </button>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

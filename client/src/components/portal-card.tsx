import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { X, MessageCircle, Calendar, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, User, LogOut, LogIn, Star, Gift, ShoppingBag, Clock, Check, Search, ArrowLeft, Sparkles, Package, Loader2, Pencil, XCircle, AlertTriangle, History, Copy, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AiChat } from "@/components/ai-chat";
import { FloatingChatDock, type ChatMessageWithExtras } from "@/components/floating-chat-dock";
import { AvailabilityPicker, PendingBookingContext, PaymentBookingContext } from "@/components/availability-picker";
import { PaymentDialog, ProductPaymentDialog } from "@/components/payment-dialog";
import { LoginModal } from "@/components/login-modal";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ClientSession, BookingResponse, ProfileResponse, SalonService } from "@shared/schema";
import { PORTAL_ENABLED, PHOREST_BOOKING_URL } from "@shared/portalConfig";

type ViewMode = "chat" | "book" | "shop" | "profile";

// Product type from API
interface Product {
  productId: string;
  name: string;
  description?: string;
  price?: number;
  brandName?: string;
  categoryName?: string;
  imageUrl?: string;
  inStock: boolean;
  stockLevel?: number;
  sku?: string;
}

interface ProductsResponse {
  products: Product[];
  brands: string[];
  page: number;
  totalPages: number;
  totalElements: number;
}

// Cart item type
interface CartItem {
  product: Product;
  quantity: number;
}

// ServiceCard component for the catalog
function ServiceCard({ service, onBook }: { service: SalonService; onBook: () => void }) {
  return (
    <Card 
      className="p-4 hover-elevate active-elevate-2 cursor-pointer transition-all"
      onClick={onBook}
      data-testid={`service-card-${service.key}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h4 className="font-medium text-sm truncate">{service.name}</h4>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {service.description?.split('.')[0] ?? ''}
          </p>
          <div className="flex items-center gap-3 mt-2">
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {service.duration}
            </span>
            <span className="text-xs font-medium text-primary">
              {service.price}
            </span>
          </div>
        </div>
        <Button 
          size="sm" 
          variant="outline"
          className="shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onBook();
          }}
          data-testid={`button-book-${service.key}`}
        >
          <Calendar className="w-3 h-3 mr-1" />
          Book
        </Button>
      </div>
    </Card>
  );
}

interface PortalCardProps {
  isOpen: boolean;
  onClose: () => void;
  initialMessage?: string;
  initialViewMode?: ViewMode;
  clientSession?: ClientSession | null;
  sessionId?: string;
  isInline?: boolean;
  onLogout?: () => void;
  onLogin?: () => void;
  onLoginSuccess?: (session: ClientSession, sessionId?: string) => void;
}

export function PortalCard({ 
  isOpen, 
  onClose, 
  initialMessage, 
  initialViewMode,
  clientSession: propClientSession, 
  sessionId,
  isInline = false, 
  onLogout, 
  onLogin,
  onLoginSuccess
}: PortalCardProps) {
  // When the portal is off (login-only mode), the profile view is the only
  // available tab — chat/book/shop are hidden and their endpoints 503.
  const defaultViewMode: ViewMode = PORTAL_ENABLED ? "chat" : "profile";
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode || defaultViewMode);

  useEffect(() => {
    setViewMode(initialViewMode ?? defaultViewMode);
  }, [initialViewMode]);

  const [chatMinimized, setChatMinimized] = useState(false);
  const [selectedService, setSelectedService] = useState<{ key: string; name: string; phorestServiceId?: string } | null>(null);
  const [recentBooking, setRecentBooking] = useState<BookingResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [pendingBooking, setPendingBooking] = useState<PendingBookingContext | null>(() => {
    try {
      const stored = localStorage.getItem('kozeta_pending_booking');
      if (stored) {
        const parsed = JSON.parse(stored);
        // Discard stale pending bookings (older than 1 hour) or ones whose slot has passed
        if (parsed?.savedAt && Date.now() - parsed.savedAt < 60 * 60 * 1000 &&
            parsed?.context?.slot?.startDateTime && new Date(parsed.context.slot.startDateTime).getTime() > Date.now()) {
          return parsed.context as PendingBookingContext;
        }
      }
    } catch { /* ignore corrupt storage */ }
    return null;
  });
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [paymentBookingContext, setPaymentBookingContext] = useState<PaymentBookingContext | null>(null);
  
  // Shop state
  const [productSearchQuery, setProductSearchQuery] = useState("");
  const [selectedBrand, setSelectedBrand] = useState("all");
  const [selectedProductCategory, setSelectedProductCategory] = useState("all");
  const [cart, setCart] = useState<CartItem[]>(() => {
    try {
      const stored = localStorage.getItem('kozeta_cart');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return parsed.filter((item: any) => item?.product?.productId && typeof item.quantity === 'number' && item.quantity > 0);
        }
      }
    } catch { /* ignore corrupt storage */ }
    return [];
  });
  const [showCart, setShowCart] = useState(false);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [loyaltyPointsToRedeem, setLoyaltyPointsToRedeem] = useState(0);
  const [productCheckoutContext, setProductCheckoutContext] = useState<{
    clientSecret: string;
    pendingOrderId: string;
    totalAmount: string;
    subtotalAmount?: string;
    loyaltyPointsRedeemed?: number;
    loyaltyDiscountAmount?: string;
  } | null>(null);
  const [showProductPaymentDialog, setShowProductPaymentDialog] = useState(false);
  const [productPurchaseResult, setProductPurchaseResult] = useState<{
    success: boolean;
    code?: string;
    title?: string;
    message?: string;
    itemCount?: number;
    totalPaid?: number;
    loyaltyPointsEarned?: number;
    paymentId?: string;
  } | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);

  // smsPid: pending booking created by the SMS AI companion — client followed a payment link
  const [smsPid, setSmsPid] = useState<string | null>(null);
  const [smsPidToken, setSmsPidToken] = useState<string | null>(null); // one-time ?t= token from SMS link
  const [smsBookingPreview, setSmsBookingPreview] = useState<{
    pendingId: string;
    serviceName: string;
    startDateTime: string;
    depositAmount: number;
    expiresInSeconds: number;
  } | null>(null);
  const [smsPaymentReady, setSmsPaymentReady] = useState<{
    clientSecret: string;
    pendingId: string;
    paymentIntentId: string;
    depositCents: number;
    serviceName: string;
    startDateTime: string;
    serviceIds: string[];
    staffIds: string[];
    branchId: string;
    clientId: string; // from pending booking — available on token path (no login)
  } | null>(null);
  // After SMS-link payment succeeds, offer to save the card for future SMS bookings
  const [smsSaveCardOffer, setSmsSaveCardOffer] = useState<{ paymentIntentId: string } | null>(null);

  const handlePortalLogin = useCallback(() => {
    if (onLoginSuccess) {
      setShowLoginModal(true);
    } else if (onLogin) {
      onLogin();
    }
  }, [onLogin, onLoginSuccess]);

  const handlePortalLoginSuccess = useCallback((session: ClientSession, newSessionId?: string) => {
    setShowLoginModal(false);
    onLoginSuccess?.(session, newSessionId);
  }, [onLoginSuccess]);
  
  // clientSession must be declared before any hook that references it
  const clientSession = propClientSession;

  // Shared chat messages state - persists across book/shop views
  const [sharedChatMessages, setSharedChatMessages] = useState<ChatMessageWithExtras[]>([
    {
      role: "assistant",
      content: "Welcome! I'm here to help with services, products, or booking. What can I help you with?",
      timestamp: Date.now()
    }
  ]);

  // Merge SMS history into in-app chat (once per login session)
  const smsHistoryMergedRef = useRef(false);
  useEffect(() => {
    if (!PORTAL_ENABLED) return; // SMS companion endpoints are blocked in login-only mode
    if (!clientSession || smsHistoryMergedRef.current) return;
    const sid = sessionId ?? localStorage.getItem('kozeta_session_id') ?? '';
    const tok = localStorage.getItem('kozeta_session_token') ?? '';
    if (!sid || !tok) return;
    smsHistoryMergedRef.current = true;
    fetch(`/api/sms/history?sessionId=${encodeURIComponent(sid)}&sessionToken=${encodeURIComponent(tok)}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { messages?: Array<{ role: string; content: string; ts: number }> } | null) => {
        if (!data?.messages?.length) return;
        const smsMessages: ChatMessageWithExtras[] = data.messages.map(m => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: m.ts,
        }));
        setSharedChatMessages(prev => {
          // Avoid duplicates: only prepend messages older than the oldest current message
          const oldestTs = prev[0]?.timestamp ?? Date.now();
          const toMerge = smsMessages.filter(m => m.timestamp < oldestTs);
          if (!toMerge.length) return prev;
          return [...toMerge, ...prev];
        });
      })
      .catch(() => { /* silently ignore */ });
  }, [clientSession, sessionId]);
  
  // Category filter options for products
  const productCategoryFilters = [
    { value: "all", label: "All" },
    { value: "shampoo", label: "Shampoo" },
    { value: "conditioner", label: "Conditioner" },
    { value: "styling", label: "Styling" },
    { value: "treatment", label: "Treatment" },
    { value: "color", label: "Color" },
    { value: "skin care", label: "Skin Care" },
    { value: "tools", label: "Tools" },
  ];
  
  const { toast } = useToast();

  // Persist cart to localStorage so it survives page refreshes
  useEffect(() => {
    try {
      if (cart.length > 0) {
        localStorage.setItem('kozeta_cart', JSON.stringify(cart));
      } else {
        localStorage.removeItem('kozeta_cart');
      }
    } catch { /* storage unavailable */ }
  }, [cart]);

  // Persist in-progress booking intent so it survives page refreshes during login
  useEffect(() => {
    try {
      if (pendingBooking) {
        localStorage.setItem('kozeta_pending_booking', JSON.stringify({ savedAt: Date.now(), context: pendingBooking }));
      } else {
        localStorage.removeItem('kozeta_pending_booking');
      }
    } catch { /* storage unavailable */ }
  }, [pendingBooking]);

  // Detect ?smsPid=...&t=... query params — client tapped a payment link from the SMS companion
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pid = params.get("smsPid");
    const tok = params.get("t");
    if (!pid || !tok) return;
    setSmsPid(pid);
    setSmsPidToken(tok);
    // Fetch booking preview — token-gated, no login needed
    fetch(`/api/sms/booking-preview?pid=${encodeURIComponent(pid)}&t=${encodeURIComponent(tok)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.pendingId) setSmsBookingPreview(data);
      })
      .catch(() => {});
  }, []);

  // Fetch the PaymentIntent when we have a token (no login) or session (logged in).
  // Token path: opens payment dialog immediately without requiring login.
  // Session path: fires after login completes.
  const smsPaymentFetchedRef = useRef(false);
  useEffect(() => {
    if (!smsPid || smsPaymentFetchedRef.current) return;
    // Need either the one-time token OR a logged-in session
    const hasToken = !!smsPidToken;
    const hasSession = !!clientSession?.clientId;
    if (!hasToken && !hasSession) return;
    smsPaymentFetchedRef.current = true;

    const url = new URL("/api/sms/payment-intent", window.location.origin);
    url.searchParams.set("pid", smsPid);
    if (hasToken) {
      url.searchParams.set("t", smsPidToken!);
    } else {
      const sid = localStorage.getItem('kozeta_session_id') || '';
      const stok = localStorage.getItem('kozeta_session_token') || '';
      url.searchParams.set("sessionId", sid);
      url.searchParams.set("sessionToken", stok);
    }

    fetch(url.toString())
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.clientSecret) {
          setSmsPaymentReady({
            clientSecret: data.clientSecret,
            pendingId: data.pendingId,
            paymentIntentId: data.paymentIntentId ?? '',
            depositCents: data.depositAmount,
            serviceName: data.serviceName,
            startDateTime: data.startDateTime,
            serviceIds: data.serviceIds ?? [],
            staffIds: data.staffIds ?? [],
            branchId: data.branchId ?? '',
            clientId: data.clientId ?? '',
          });
          // Show PaymentDialog immediately — no login required on token path
          setPaymentBookingContext({
            serviceIds: data.serviceIds ?? [],
            staffIds: data.staffIds ?? [],
            startDateTime: data.startDateTime,
            endDateTime: data.endDateTime,
            branchId: data.branchId ?? '',
            serviceName: data.serviceName,
            servicePrice: data.servicePrice ? String(data.servicePrice) : undefined,
          });
          setShowPaymentDialog(true);
          setSmsBookingPreview(null); // dismiss banner
        }
      })
      .catch(() => { smsPaymentFetchedRef.current = false; });
  }, [smsPid, smsPidToken, clientSession?.clientId]);

  // Handle auth required from booking - prompt login and store pending booking
  const handleAuthRequired = useCallback((context: PendingBookingContext) => {
    console.log('[Portal] Auth required for booking, storing pending context:', context);
    setPendingBooking(context);
    toast({
      title: "Login required",
      description: "Please log in to complete your booking.",
    });
    handlePortalLogin();
  }, [handlePortalLogin, toast]);

  // Handle payment required - show payment dialog
  const handlePaymentRequired = useCallback((context: PaymentBookingContext) => {
    console.log('[Portal] Payment required for booking:', context);
    setPaymentBookingContext(context);
    setShowPaymentDialog(true);
  }, []);

  // Handle successful payment and booking
  const handlePaymentSuccess = useCallback((bookingResponse: BookingResponse) => {
    console.log('[Portal] Payment and booking successful:', bookingResponse);
    setShowPaymentDialog(false);
    setPaymentBookingContext(null);
    setSelectedService(null);
    setRecentBooking(bookingResponse);
    toast({
      title: "Booking confirmed!",
      description: "Your appointment has been booked and deposit paid.",
    });
  }, [toast]);

  // Handle payment cancellation
  const handlePaymentCancel = useCallback(() => {
    console.log('[Portal] Payment cancelled');
    setShowPaymentDialog(false);
    setPaymentBookingContext(null);
  }, []);

  // Booking failed during payment because the slot was just taken:
  // close the dialog and signal the availability picker to refresh with a notice.
  const [slotConflictNonce, setSlotConflictNonce] = useState(0);
  const handleSlotConflict = useCallback(() => {
    console.log('[Portal] Slot conflict during payment — refreshing availability');
    setShowPaymentDialog(false);
    setPaymentBookingContext(null);
    setSlotConflictNonce(n => n + 1);
  }, []);

  // Auto-show payment dialog when user logs in with a pending booking
  useEffect(() => {
    if (clientSession?.clientId && sessionId && pendingBooking) {
      console.log('[Portal] Session available, showing payment for pending booking...');
      
      // Convert pending booking to payment context and show payment dialog
      const paymentContext: PaymentBookingContext = {
        serviceIds: pendingBooking.serviceIds,
        staffIds: pendingBooking.staffId ? [pendingBooking.staffId] : [],
        startDateTime: pendingBooking.slot.startDateTime,
        endDateTime: pendingBooking.slot.endDateTime,
        branchId: pendingBooking.branchId,
        serviceName: pendingBooking.serviceName,
        servicePrice: pendingBooking.servicePrice || undefined
      };
      
      setPendingBooking(null);
      setPaymentBookingContext(paymentContext);
      setShowPaymentDialog(true);
    }
  }, [clientSession?.clientId, sessionId, pendingBooking]);

  // Prefetch products on mount for instant loading when user visits Shop
  useEffect(() => {
    queryClient.prefetchQuery({
      queryKey: ['/api/products', 'all', ''],
      queryFn: async () => {
        const response = await fetch('/api/products?size=500');
        if (!response.ok) throw new Error('Failed to fetch products');
        return response.json();
      },
      staleTime: 1000 * 60 * 30,
    });
  }, []);

  // Fetch services for the catalog
  const { data: servicesData, isLoading: servicesLoading, isError: servicesError, refetch: refetchServices } = useQuery<{ services: SalonService[] }>({
    queryKey: ['/api/services'],
  });

  const { data: stripeConfig } = useQuery<{ configured: boolean; salonPhone?: string | null }>({
    queryKey: ['/api/stripe/config'],
    staleTime: 10 * 60 * 1000,
  });

  const services = servicesData?.services || [];
  
  // Fetch products for the shop - with aggressive caching for instant load
  const { data: productsData, isLoading: productsLoading } = useQuery<ProductsResponse>({
    queryKey: ['/api/products', selectedBrand, productSearchQuery],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedBrand !== 'all') params.set('brandId', selectedBrand);
      if (productSearchQuery) params.set('search', productSearchQuery);
      params.set('size', '500');
      const response = await fetch(`/api/products?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch products');
      return response.json();
    },
    enabled: viewMode === 'shop',
    staleTime: 1000 * 60 * 30, // 30 minutes - products don't change often
    gcTime: 1000 * 60 * 60, // 1 hour cache retention
    refetchOnWindowFocus: false, // Don't refetch on focus for speed
    refetchOnMount: false, // Use cached data on mount
  });
  
  const products = productsData?.products || [];
  const brands = productsData?.brands || [];
  
  // Cart total
  const cartTotal = useMemo(() => {
    return cart.reduce((sum, item) => sum + (item.product.price || 0) * item.quantity, 0);
  }, [cart]);
  
  const cartItemCount = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.quantity, 0);
  }, [cart]);
  
  // Add to cart handler
  const handleAddToCart = useCallback((product: Product) => {
    setCart(prev => {
      const existing = prev.find(item => item.product.productId === product.productId);
      if (existing) {
        return prev.map(item => 
          item.product.productId === product.productId 
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      }
      return [...prev, { product, quantity: 1 }];
    });
    toast({
      title: "Added to cart",
      description: `${product.name} added to your cart`,
    });
  }, [toast]);
  
  // Remove from cart handler
  const handleRemoveFromCart = useCallback((productId: string) => {
    setCart(prev => prev.filter(item => item.product.productId !== productId));
  }, []);
  
  // Update cart quantity handler
  const handleUpdateQuantity = useCallback((productId: string, quantity: number) => {
    if (quantity <= 0) {
      handleRemoveFromCart(productId);
      return;
    }
    setCart(prev => prev.map(item => 
      item.product.productId === productId 
        ? { ...item, quantity }
        : item
    ));
  }, [handleRemoveFromCart]);

  // Product checkout handler
  const handleProductCheckout = useCallback(async () => {
    if (cart.length === 0) {
      toast({
        title: "Cart empty",
        description: "Add some products before checking out",
        variant: "destructive"
      });
      return;
    }

    if (!clientSession?.clientId || !sessionId) {
      toast({
        title: "Login required",
        description: "Please log in to complete your purchase",
      });
      handlePortalLogin();
      return;
    }

    setIsCheckingOut(true);
    try {
      const items = cart.map(item => ({
        productId: item.product.productId,
        name: item.product.name,
        price: item.product.price || 0,
        quantity: item.quantity
      }));

      const sessionToken = localStorage.getItem('kozeta_session_token') || undefined;
      const response = await apiRequest("POST", "/api/products/create-checkout-intent", {
        items,
        sessionId,
        sessionToken,
        loyaltyPointsToRedeem: loyaltyPointsToRedeem > 0 ? loyaltyPointsToRedeem : undefined
      });
      
      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error);
      }

      setProductCheckoutContext({
        clientSecret: data.clientSecret,
        pendingOrderId: data.pendingOrderId,
        totalAmount: data.totalAmount,
        subtotalAmount: data.subtotalAmount,
        loyaltyPointsRedeemed: data.loyaltyPointsRedeemed,
        loyaltyDiscountAmount: data.loyaltyDiscountAmount
      });
      setShowCart(false);
      setShowProductPaymentDialog(true);
    } catch (error) {
      console.error('[Checkout] Error:', error);
      toast({
        title: "Checkout failed",
        description: error instanceof Error ? error.message : "Please try again",
        variant: "destructive"
      });
    } finally {
      setIsCheckingOut(false);
    }
  }, [cart, clientSession?.clientId, sessionId, loyaltyPointsToRedeem, handlePortalLogin, toast]);

  // Handle product payment success
  const handleProductPaymentSuccess = useCallback(async (paymentIntentId: string) => {
    try {
      const sessionToken = localStorage.getItem('kozeta_session_token') || undefined;
      const response = await apiRequest("POST", "/api/products/finalize-purchase", {
        pendingOrderId: productCheckoutContext?.pendingOrderId,
        sessionId,
        sessionToken
      });
      
      const data = await response.json();
      
      if (data.success) {
        setShowProductPaymentDialog(false);
        setProductCheckoutContext(null);
        setCart([]);
        setLoyaltyPointsToRedeem(0);
        setProductPurchaseResult({
          success: true,
          itemCount: data.itemCount,
          totalPaid: data.totalPaid,
          loyaltyPointsEarned: data.loyaltyPointsEarned
        });
        queryClient.invalidateQueries({ queryKey: ['/api/profile'] });
      } else {
        const code = data.code || 'PURCHASE_FAILED';
        setShowProductPaymentDialog(false);
        setProductPurchaseResult({
          success: false,
          code,
          title: code === 'SESSION_EXPIRED' ? 'Session Expired' : 
                 code === 'ORDER_EXPIRED' ? 'Order Expired' :
                 'Purchase Issue',
          message: data.error || "An unexpected error occurred. Please contact us.",
          paymentId: paymentIntentId
        });
      }
    } catch (error) {
      console.error('[Checkout] Finalize error:', error);
      setShowProductPaymentDialog(false);
      setProductPurchaseResult({
        success: false,
        code: 'PURCHASE_FAILED',
        title: 'Purchase Issue',
        message: 'Payment received. We\'ll contact you about your order.',
        paymentId: paymentIntentId
      });
    }
  }, [productCheckoutContext?.pendingOrderId, sessionId]);

  // Handle product payment cancel
  const handleProductPaymentCancel = useCallback(() => {
    setShowProductPaymentDialog(false);
    setProductCheckoutContext(null);
  }, []);

  const categories = useMemo(() => {
    const catOrderMap = new Map<string, number>();
    services.forEach((s: any) => {
      if (!catOrderMap.has(s.category)) {
        catOrderMap.set(s.category, s.categoryOrder || 50);
      }
    });
    const cats = Array.from(catOrderMap.keys()).sort((a, b) => {
      return (catOrderMap.get(a) || 50) - (catOrderMap.get(b) || 50);
    });
    return ["all", ...cats];
  }, [services]);

  // Filter services by search and category
  const filteredServices = useMemo(() => {
    return services.filter(service => {
      const matchesSearch = searchQuery === "" || 
        service.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        service.description.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesCategory = selectedCategory === "all" || service.category === selectedCategory;
      return matchesSearch && matchesCategory;
    });
  }, [services, searchQuery, selectedCategory]);

  // Group services by category for display (sorted by display order)
  const servicesByCategory = useMemo(() => {
    const grouped: Record<string, SalonService[]> = {};
    filteredServices.forEach(service => {
      if (!grouped[service.category]) {
        grouped[service.category] = [];
      }
      grouped[service.category].push(service);
    });
    return grouped;
  }, [filteredServices]);

  const sortedCategoryKeys = useMemo(() => {
    const catOrderMap = new Map<string, number>();
    services.forEach((s: any) => {
      if (!catOrderMap.has(s.category)) {
        catOrderMap.set(s.category, s.categoryOrder || 50);
      }
    });
    return Object.keys(servicesByCategory).sort((a, b) => {
      return (catOrderMap.get(a) || 50) - (catOrderMap.get(b) || 50);
    });
  }, [servicesByCategory, services]);

  const { data: profileData, isLoading: profileLoading, isError: profileError, refetch: refetchProfile } = useQuery<ProfileResponse>({
    queryKey: ['/api/profile', clientSession?.clientId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (clientSession?.clientId) {
        params.set('clientId', clientSession.clientId);
      }
      if (sessionId) {
        params.set('sessionId', sessionId);
      }
      const response = await fetch(`/api/profile?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch profile');
      return response.json();
    },
    enabled: !!clientSession?.clientId,
  });

  const { data: recommendationsData, isLoading: recommendationsLoading } = useQuery<{ recommendations: Array<{ productId: string; name: string; brandName: string; price: number; imageUrl: string; reason: string }> }>({
    queryKey: ['/api/recommendations', clientSession?.clientId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (sessionId) params.set('sessionId', sessionId);
      const storedToken = localStorage.getItem('kozeta_session_token');
      if (storedToken) params.set('sessionToken', storedToken);
      const response = await fetch(`/api/recommendations?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch recommendations');
      return response.json();
    },
    enabled: PORTAL_ENABLED && !!clientSession?.clientId && viewMode === 'profile',
    staleTime: 5 * 60 * 1000,
  });

  // Reward redemption mutation
  const redeemRewardMutation = useMutation({
    mutationFn: async ({ rewardName, pointsRequired }: { rewardName: string; pointsRequired: number }) => {
      const response = await apiRequest('POST', '/api/loyalty/redeem', {
        clientId: clientSession?.clientId,
        rewardName,
        pointsRequired
      });
      return response.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Reward Redeemed!",
        description: data.message || "Your reward has been successfully redeemed.",
      });
      // Refresh profile data to update points
      queryClient.invalidateQueries({ queryKey: ['/api/profile', clientSession?.clientId] });
    },
    onError: (error) => {
      toast({
        title: "Redemption Failed",
        description: "Unable to redeem reward. Please try again.",
        variant: "destructive"
      });
    }
  });

  const handleRedeemReward = useCallback((rewardName: string, pointsRequired: number) => {
    if (!clientSession?.clientId) {
      toast({
        title: "Login Required",
        description: "Please log in to redeem rewards.",
        variant: "destructive"
      });
      return;
    }
    redeemRewardMutation.mutate({ rewardName, pointsRequired });
  }, [clientSession?.clientId, redeemRewardMutation, toast]);

  const handleServiceRecommendation = useCallback((recommendations: Array<{ serviceKey: string; serviceName: string; phorestServiceId?: string }>) => {
    // Don't auto-navigate - let user click "Book Now" on the recommendation cards in chat
    // This keeps the user in control and allows them to see the AI's full response
  }, []);

  const handleBookSpecificService = useCallback((serviceKey: string, serviceName: string, phorestServiceId?: string) => {
    if (!PORTAL_ENABLED) {
      // In-app booking is off — send the client to Phorest's booking page.
      window.open(PHOREST_BOOKING_URL, '_blank', 'noopener');
      return;
    }
    if (import.meta.env.DEV) {
      console.log('[Booking Flow] Service selected:', { serviceKey, serviceName, phorestServiceId });
    }
    setSelectedService({ key: serviceKey, name: serviceName, phorestServiceId: phorestServiceId || serviceKey });
    setViewMode("book");
    setChatMinimized(true);
  }, []);

  const handleBookingComplete = useCallback((booking: BookingResponse) => {
    setRecentBooking(booking);
    setSelectedService(null);
  }, []);

  const handleCancelBooking = useCallback(() => {
    setSelectedService(null);
    setViewMode("chat");
  }, []);

  // Back to catalog (stay in Book view)
  const handleBackToCatalog = useCallback(() => {
    setSelectedService(null);
  }, []);

  if (!isOpen) return null;

  const toggleViewMode = (mode: ViewMode) => {
    if (!PORTAL_ENABLED && mode !== "profile") return; // login-only mode
    setViewMode(mode);
    if (mode === "book") {
      setChatMinimized(true);
    }
    setRecentBooking(null);
  };

  const renderHeader = () => (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0 bg-gradient-to-r from-background to-muted/30">
      <Button
        data-testid="button-close-portal"
        variant="ghost"
        size="icon"
        onClick={onClose}
        className="rounded-full"
      >
        <X className="w-5 h-5" />
      </Button>

      <div className="flex items-center gap-2">
        <div className="flex bg-muted rounded-full p-1">
          {PORTAL_ENABLED && (<>
          <button
            onClick={() => toggleViewMode("chat")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
              viewMode === "chat"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            data-testid="button-mode-chat"
          >
            <MessageCircle className="w-3.5 h-3.5" />
            Chat
          </button>
          <button
            onClick={() => toggleViewMode("book")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
              viewMode === "book"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            data-testid="button-mode-book"
          >
            <Calendar className="w-3.5 h-3.5" />
            Book
          </button>
          <button
            onClick={() => toggleViewMode("shop")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
              viewMode === "shop"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            data-testid="button-mode-shop"
          >
            <ShoppingBag className="w-3.5 h-3.5" />
            Shop
            {cartItemCount > 0 && (
              <span className="ml-1 w-4 h-4 bg-primary text-primary-foreground text-[10px] font-bold rounded-full flex items-center justify-center">
                {cartItemCount}
              </span>
            )}
          </button>
          </>)}
          {clientSession && (
            <button
              onClick={() => toggleViewMode("profile")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                viewMode === "profile"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid="button-mode-profile"
            >
              <User className="w-3.5 h-3.5" />
              Profile
            </button>
          )}
        </div>

        {clientSession && onLogout ? (
          <Button
            data-testid="button-portal-logout"
            variant="ghost"
            size="sm"
            onClick={onLogout}
            className="rounded-full gap-1.5"
          >
            <LogOut className="w-4 h-4" />
            <span className="text-xs hidden sm:inline">Logout</span>
          </Button>
        ) : (onLogin || onLoginSuccess) ? (
          <Button
            data-testid="button-portal-login"
            variant="ghost"
            size="sm"
            onClick={handlePortalLogin}
            className="rounded-full gap-1.5"
          >
            <LogIn className="w-4 h-4" />
            <span className="text-xs hidden sm:inline">Login</span>
          </Button>
        ) : null}
      </div>

      {clientSession ? (
        <Button
          data-testid="button-user-profile"
          variant="ghost"
          size="sm"
          className="rounded-full gap-2"
          onClick={() => toggleViewMode("profile")}
        >
          <User className="w-4 h-4" />
          <span className="text-xs font-medium">{clientSession.profile.firstName}</span>
        </Button>
      ) : (
        <div className="w-20" />
      )}
    </div>
  );

  const [isEditingName, setIsEditingName] = useState(false);
  const [editFirstName, setEditFirstName] = useState("");
  const [editLastName, setEditLastName] = useState("");
  const [profileTab, setProfileTab] = useState<"overview" | "appointments" | "purchases">("overview");
  const [cancellingAppointmentId, setCancellingAppointmentId] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState<{ appointmentId: string; isWithin24h: boolean } | null>(null);
  // Appointments whose cancellation was sent but not confirmed by Phorest —
  // re-sending a cancel for these is disabled to avoid conflicting requests.
  const [unconfirmedCancelIds, setUnconfirmedCancelIds] = useState<Set<string>>(new Set());

  const updateNameMutation = useMutation({
    mutationFn: async ({ firstName, lastName }: { firstName: string; lastName: string }) => {
      const response = await apiRequest("POST", "/api/client/update-name", {
        sessionId,
        firstName,
        lastName,
      });
      return response.json();
    },
    onSuccess: () => {
      setIsEditingName(false);
      queryClient.invalidateQueries({ queryKey: ['/api/profile', clientSession?.clientId] });
      toast({ title: "Name updated", description: "Your name has been updated." });
    },
    onError: () => {
      toast({ title: "Update failed", description: "Couldn't update your name. Please try again.", variant: "destructive" });
    },
  });

  const cancelAppointmentMutation = useMutation({
    mutationFn: async (appointmentId: string) => {
      setCancellingAppointmentId(appointmentId);
      const res = await fetch("/api/appointments/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId, appointmentId }),
      });
      const data = await res.json();
      if (!res.ok && data?.code !== 'CANCEL_UNCONFIRMED') {
        throw new Error(data?.error || "Failed to cancel appointment");
      }
      return { ...data, appointmentId };
    },
    onSuccess: (data: any) => {
      setCancellingAppointmentId(null);
      setShowCancelConfirm(null);
      if (data?.code === 'CANCEL_UNCONFIRMED') {
        if (data.appointmentId) {
          setUnconfirmedCancelIds(prev => new Set(prev).add(data.appointmentId));
        }
        toast({
          title: "Cancellation not confirmed",
          description: `We sent your cancellation request but couldn't confirm it went through. Please call us at (416) 932-3131 to make sure your appointment is cancelled.`,
          variant: "destructive",
          duration: 10000,
        });
      } else {
        queryClient.invalidateQueries({ queryKey: ['/api/profile', clientSession?.clientId] });
        toast({
          title: "Appointment cancelled",
          description: data.message || "Your appointment has been cancelled.",
        });
      }
    },
    onError: () => {
      setCancellingAppointmentId(null);
      setShowCancelConfirm(null);
      toast({
        title: "Cancellation failed",
        description: "Couldn't cancel the appointment. Please contact the salon.",
        variant: "destructive",
      });
    },
  });

  const renderProfileView = () => {
    const profile = profileData?.profile || clientSession?.profile;
    const loyalty = profileData?.loyalty;
    const lastVisit = profileData?.lastVisit || clientSession?.lastVisit;
    const products = profileData?.products || clientSession?.products || [];
    const upcomingAppointments = profileData?.upcomingAppointments || [];
    const pastAppointments = profileData?.pastAppointments || [];

    const handleStartEditName = () => {
      setEditFirstName(profile?.firstName || "");
      setEditLastName(profile?.lastName || "");
      setIsEditingName(true);
    };

    const handleSaveName = () => {
      if (!editFirstName.trim() || !editLastName.trim()) return;
      updateNameMutation.mutate({ firstName: editFirstName.trim(), lastName: editLastName.trim() });
    };

    const handleCancelClick = (appointmentId: string, startTime: string) => {
      const hoursUntil = (new Date(startTime).getTime() - Date.now()) / (1000 * 60 * 60);
      setShowCancelConfirm({ appointmentId, isWithin24h: hoursUntil < 24 });
    };

    return (
      <div className="h-full overflow-y-auto scroll-smooth p-4 space-y-4 pb-16">
        {profileError && (
          <Card className="p-4 text-center" data-testid="card-profile-error">
            <p className="text-sm text-muted-foreground mb-3">
              We couldn't load your latest profile details. Some information may be out of date.
            </p>
            <Button variant="outline" size="sm" onClick={() => refetchProfile()} data-testid="button-retry-profile">
              Try Again
            </Button>
          </Card>
        )}
        <div className="text-center py-4">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
            <User className="w-8 h-8 text-primary" />
          </div>
          {isEditingName ? (
            <div className="space-y-2 max-w-[250px] mx-auto">
              <Input
                value={editFirstName}
                onChange={(e) => setEditFirstName(e.target.value)}
                placeholder="First name"
                className="text-center"
                autoFocus
                data-testid="input-edit-first-name"
              />
              <Input
                value={editLastName}
                onChange={(e) => setEditLastName(e.target.value)}
                placeholder="Last name"
                className="text-center"
                data-testid="input-edit-last-name"
              />
              <div className="flex gap-2 justify-center">
                <Button size="sm" onClick={handleSaveName} disabled={updateNameMutation.isPending} data-testid="button-save-name">
                  {updateNameMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setIsEditingName(false)} data-testid="button-cancel-edit-name">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2">
              <h2 className="font-semibold text-lg">
                {profile?.firstName} {profile?.lastName}
              </h2>
              <Button
                size="icon"
                variant="ghost"
                className="rounded-full"
                onClick={handleStartEditName}
                data-testid="button-edit-name"
              >
                <Pencil className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
          <p className="text-sm text-muted-foreground">{profile?.phone || profile?.email}</p>
        </div>

        <div className="flex bg-muted rounded-full p-1">
          <button
            onClick={() => setProfileTab("overview")}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
              profileTab === "overview"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            data-testid="button-profile-overview"
          >
            <User className="w-3 h-3" />
            Overview
          </button>
          <button
            onClick={() => setProfileTab("appointments")}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
              profileTab === "appointments"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            data-testid="button-profile-appointments"
          >
            <Calendar className="w-3 h-3" />
            Appointments
          </button>
          <button
            onClick={() => setProfileTab("purchases")}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
              profileTab === "purchases"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            data-testid="button-profile-purchases"
          >
            <ShoppingBag className="w-3 h-3" />
            Purchases
          </button>
        </div>

        {profileTab === "overview" && (
          <>
        <div className="grid grid-cols-2 gap-3">
          <Card className="p-4 hover-elevate cursor-pointer" data-testid="card-loyalty">
            <div className="flex items-center gap-2 mb-2">
              <Star className="w-4 h-4 text-amber-500" />
              <span className="text-sm font-medium">Loyalty Points</span>
            </div>
            {profileLoading ? (
              <Skeleton className="h-8 w-16 mb-1" />
            ) : (
              <p className="text-2xl font-bold">{loyalty?.points ?? profile?.loyaltyPoints ?? 0}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Earn 1 point per $1 spent
            </p>
          </Card>

          <Card className="p-4 hover-elevate cursor-pointer" data-testid="card-rewards">
            <div className="flex items-center gap-2 mb-2">
              <Gift className="w-4 h-4 text-pink-500" />
              <span className="text-sm font-medium">Redeem Points</span>
            </div>
            <p className="text-sm font-medium mt-1">300 pts = $5 off products</p>
            <p className="text-sm font-medium">300 pts = $8 off massage</p>
          </Card>
        </div>

        {loyalty?.rewards && loyalty.rewards.length > 0 && (
          <Card className="p-4" data-testid="card-rewards-list">
            <div className="flex items-center gap-2 mb-3">
              <Gift className="w-4 h-4 text-pink-500" />
              <span className="font-medium">Available Rewards</span>
            </div>
            <div className="space-y-2">
              {loyalty.rewards.map((reward, idx) => (
                <div 
                  key={idx} 
                  className={`flex items-center justify-between gap-2 py-2 px-3 rounded-lg ${
                    reward.available 
                      ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800' 
                      : 'bg-muted/50'
                  }`}
                >
                  <div>
                    <p className={`font-medium text-sm ${reward.available ? 'text-green-700 dark:text-green-300' : ''}`}>
                      {reward.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {reward.pointsRequired} points required
                    </p>
                  </div>
                  {reward.available && PORTAL_ENABLED ? (
                    <Button 
                      size="sm" 
                      variant="outline" 
                      className="text-xs"
                      onClick={() => handleRedeemReward(reward.name, reward.pointsRequired)}
                      disabled={redeemRewardMutation.isPending}
                      data-testid={`button-redeem-${idx}`}
                    >
                      {redeemRewardMutation.isPending ? "..." : "Redeem"}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {reward.pointsRequired - (loyalty.points || 0)} more pts
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

            {PORTAL_ENABLED && (
            <Card className="p-4" data-testid="card-ai-recommendations">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-4 h-4 text-purple-500" />
                <span className="font-medium">Recommended For You</span>
              </div>
              {recommendationsLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">Finding products for you...</span>
                </div>
              ) : recommendationsData?.recommendations && recommendationsData.recommendations.length > 0 ? (
                <div className="space-y-3">
                  {recommendationsData.recommendations.map((rec, idx) => (
                    <div
                      key={rec.productId}
                      className="flex items-start gap-3 py-2 border-b border-border last:border-0 cursor-pointer hover-elevate rounded-lg px-1"
                      onClick={() => toggleViewMode("shop")}
                      data-testid={`card-recommendation-${idx}`}
                    >
                      <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center overflow-hidden shrink-0">
                        <img
                          src={rec.imageUrl || '/kozeta-product-logo.svg'}
                          alt={rec.name}
                          className="w-full h-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).src = '/kozeta-product-logo.svg'; }}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{rec.name}</p>
                        <p className="text-xs text-muted-foreground">{rec.brandName} &middot; ${rec.price.toFixed(2)}</p>
                        <p className="text-xs text-muted-foreground/80 mt-0.5 line-clamp-2">{rec.reason}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-2">Visit us and we'll personalize product picks for you.</p>
              )}
            </Card>
            )}
          </>
        )}

        {profileTab === "appointments" && (
          <div className="space-y-4">
            <Card className="p-4" data-testid="card-upcoming-appointments">
              <div className="flex items-center gap-2 mb-3">
                <Calendar className="w-4 h-4 text-primary" />
                <span className="font-medium">Upcoming</span>
              </div>
              {upcomingAppointments.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No upcoming appointments</p>
              ) : (
                <div className="space-y-3">
                  {upcomingAppointments.map((apt, idx) => {
                    const hoursUntil = (new Date(apt.startTime).getTime() - Date.now()) / (1000 * 60 * 60);
                    const isWithin24h = hoursUntil < 24 && hoursUntil > 0;
                    return (
                      <div key={idx} className="py-2 border-b border-border last:border-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{apt.services?.[0]?.serviceName || 'Appointment'}</p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(apt.startTime).toLocaleDateString('en-US', { 
                                weekday: 'short',
                                month: 'short', 
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit'
                              })}
                            </p>
                            {apt.staffName && (
                              <p className="text-xs text-muted-foreground">with {apt.staffName}</p>
                            )}
                          </div>
                          <Badge variant="secondary" className="text-[10px] shrink-0">Confirmed</Badge>
                        </div>
                        {PORTAL_ENABLED ? (
                        <div className="flex gap-2 mt-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs flex-1"
                            disabled={unconfirmedCancelIds.has(apt.appointmentId)}
                            onClick={() => {
                              const service = apt.services?.[0];
                              if (service) {
                                handleCancelClick(apt.appointmentId, apt.startTime);
                              }
                            }}
                            data-testid={`button-cancel-apt-${idx}`}
                          >
                            <XCircle className="w-3 h-3 mr-1" />
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs flex-1"
                            disabled={unconfirmedCancelIds.has(apt.appointmentId)}
                            onClick={() => {
                              handleCancelClick(apt.appointmentId, apt.startTime);
                            }}
                            data-testid={`button-reschedule-apt-${idx}`}
                          >
                            <Calendar className="w-3 h-3 mr-1" />
                            Reschedule
                          </Button>
                        </div>
                        ) : (
                          <p className="text-[10px] text-muted-foreground mt-2" data-testid={`text-cancel-info-${idx}`}>
                            To cancel or reschedule, call us at (416) 932-3131
                          </p>
                        )}
                        {unconfirmedCancelIds.has(apt.appointmentId) && (
                          <div className="flex items-start gap-1.5 mt-2 text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                            <p className="text-[10px]" data-testid={`text-cancel-unconfirmed-${idx}`}>Cancellation request sent — call us at (416) 932-3131 to confirm it went through</p>
                          </div>
                        )}
                        {isWithin24h && (
                          <div className="flex items-start gap-1.5 mt-2 text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                            <p className="text-[10px]">Within 24 hours — deposit is non-refundable if cancelled</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card className="p-4" data-testid="card-past-appointments">
              <div className="flex items-center gap-2 mb-3">
                <History className="w-4 h-4 text-muted-foreground" />
                <span className="font-medium">Past Appointments</span>
              </div>
              {pastAppointments.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No past appointments</p>
              ) : (
                <div className="space-y-3">
                  {pastAppointments.slice(0, 10).map((apt, idx) => (
                    <div key={idx} className="flex items-center justify-between gap-2 py-2 border-b border-border last:border-0">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{apt.services?.[0]?.serviceName || 'Service'}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(apt.startTime).toLocaleDateString('en-US', { 
                            month: 'short', 
                            day: 'numeric',
                            year: 'numeric'
                          })}
                          {apt.staffName && ` • ${apt.staffName}`}
                        </p>
                      </div>
                      <Button 
                        size="sm" 
                        variant="ghost" 
                        className="text-xs shrink-0"
                        onClick={() => {
                          const service = apt.services?.[0];
                          if (service) {
                            handleBookSpecificService(service.serviceId, service.serviceName);
                          }
                        }}
                        data-testid={`button-rebook-${idx}`}
                      >
                        Book Again
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {profileTab === "purchases" && (
          <Card className="p-4" data-testid="card-purchase-history">
            <div className="flex items-center gap-2 mb-3">
              <ShoppingBag className="w-4 h-4 text-primary" />
              <span className="font-medium">Purchase History</span>
            </div>
            {products.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No purchase history</p>
            ) : (
              <div className="space-y-3">
                {products.map((product, idx) => (
                  <div key={idx} className="flex items-center justify-between gap-2 py-2 border-b border-border last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{product.productName}</p>
                      <p className="text-xs text-muted-foreground">{product.lastPurchased}</p>
                    </div>
                    {product.status === 'running-low' ? (
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        Running Low
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        In Stock
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {showCancelConfirm && (
          <>
            <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[80]" onClick={() => setShowCancelConfirm(null)} />
            <div className="fixed z-[90] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(350px,calc(100%-32px))]">
              <Card className="p-5 shadow-2xl">
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
                    <AlertTriangle className="w-6 h-6 text-destructive" />
                  </div>
                  <h3 className="font-semibold">Cancel Appointment?</h3>
                  {showCancelConfirm.isWithin24h ? (
                    <p className="text-sm text-muted-foreground">
                      This appointment is within 24 hours. Your deposit is <span className="font-semibold text-destructive">non-refundable</span>. 
                      If rescheduling, a new deposit will be required.
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Your deposit will be refunded since the appointment is more than 24 hours away.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button 
                      variant="outline" 
                      className="flex-1" 
                      onClick={() => setShowCancelConfirm(null)}
                      data-testid="button-cancel-confirm-no"
                    >
                      Keep It
                    </Button>
                    <Button 
                      variant="destructive" 
                      className="flex-1"
                      disabled={cancelAppointmentMutation.isPending}
                      onClick={() => cancelAppointmentMutation.mutate(showCancelConfirm.appointmentId)}
                      data-testid="button-cancel-confirm-yes"
                    >
                      {cancelAppointmentMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Cancel"}
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          </>
        )}
      </div>
    );
  };

  const renderShopView = () => {
    // Filter products by search, brand, and category
    const filteredProducts = products.filter(product => {
      const matchesSearch = productSearchQuery === "" || 
        product.name?.toLowerCase().includes(productSearchQuery.toLowerCase()) ||
        product.brandName?.toLowerCase().includes(productSearchQuery.toLowerCase());
      const matchesBrand = selectedBrand === "all" || product.brandName === selectedBrand;
      const matchesCategory = selectedProductCategory === "all" || 
        product.categoryName?.toLowerCase().includes(selectedProductCategory.toLowerCase()) ||
        product.name?.toLowerCase().includes(selectedProductCategory.toLowerCase());
      return matchesSearch && matchesBrand && matchesCategory;
    });
    
    return (
      <div className="h-full flex flex-col">
        {/* Cart Summary Bar */}
        {cartItemCount > 0 && (
          <div className="px-4 py-2 bg-primary/5 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShoppingBag className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">{cartItemCount} items</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold">${cartTotal.toFixed(2)}</span>
              <Button 
                size="sm" 
                onClick={() => setShowCart(true)}
                data-testid="button-view-cart"
              >
                View Cart
              </Button>
            </div>
          </div>
        )}
        
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Search Bar */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search products..."
              value={productSearchQuery}
              onChange={(e) => setProductSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-products"
            />
          </div>
          
          {/* Category Filters - wrap on desktop, scroll on mobile */}
          <div className="overflow-x-auto md:overflow-visible pb-2">
            <div className="flex gap-2 md:flex-wrap">
              {productCategoryFilters.map(category => (
                <button
                  key={category.value}
                  onClick={() => setSelectedProductCategory(category.value)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                    selectedProductCategory === category.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid={`filter-category-${category.value}`}
                >
                  {category.label}
                </button>
              ))}
            </div>
          </div>
          
          {/* Brand Filters - wrap on desktop, scroll on mobile */}
          <div className="overflow-x-auto md:overflow-visible pb-2">
            <div className="flex gap-2 md:flex-wrap">
              <button
                onClick={() => setSelectedBrand("all")}
                className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                  selectedBrand === "all"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
                data-testid="filter-brand-all"
              >
                All Brands
              </button>
              {brands.map(brand => (
                <button
                  key={brand}
                  onClick={() => setSelectedBrand(brand)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                    selectedBrand === brand
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid={`filter-brand-${brand}`}
                >
                  {brand}
                </button>
              ))}
            </div>
          </div>
          
          {/* Products Grid */}
          {productsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <span className="ml-2 text-sm text-muted-foreground">Loading products...</span>
            </div>
          ) : filteredProducts.length === 0 ? (
            <Card className="p-6 text-center">
              <Package className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No products found. Try a different search or brand.
              </p>
            </Card>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {filteredProducts.map(product => (
                <Card 
                  key={product.productId}
                  className="p-3 hover-elevate cursor-pointer transition-all"
                  data-testid={`product-card-${product.productId}`}
                >
                  {/* Product Image */}
                  <div className="aspect-square bg-muted rounded-lg mb-2 flex items-center justify-center overflow-hidden">
                    <img 
                      src={product.imageUrl || '/kozeta-product-logo.svg'} 
                      alt={product.name}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = '/kozeta-product-logo.svg';
                      }}
                    />
                  </div>
                  
                  {/* Product Info */}
                  <div className="space-y-1">
                    {product.brandName && (
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                        {product.brandName}
                      </p>
                    )}
                    <h4 className="font-medium text-xs line-clamp-2 leading-tight">
                      {product.name}
                    </h4>
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-sm font-semibold text-primary">
                        ${product.price?.toFixed(2) || '—'}
                      </span>
                      {product.inStock ? (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                          In Stock
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                          Out of Stock
                        </Badge>
                      )}
                    </div>
                  </div>
                  
                  {/* Add to Cart Button */}
                  <Button 
                    size="sm"
                    className="w-full mt-2 text-xs"
                    disabled={!product.inStock || !product.price}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddToCart(product);
                    }}
                    data-testid={`button-add-${product.productId}`}
                  >
                    {!product.inStock ? 'Sold Out' : !product.price ? 'Call for Pricing' : 'Add to Cart'}
                  </Button>
                </Card>
              ))}
            </div>
          )}
        </div>
        
        {/* Cart Drawer */}
        {showCart && (
          <>
            <div 
              className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40"
              onClick={() => setShowCart(false)}
            />
            <div className="fixed bottom-0 left-0 right-0 md:right-auto md:left-1/2 md:-translate-x-1/2 md:w-[min(500px,calc(100%-64px))] bg-background border-t border-border rounded-t-2xl shadow-2xl z-50 max-h-[70vh] flex flex-col">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <h3 className="font-semibold">Your Cart ({cartItemCount})</h3>
                <Button variant="ghost" size="icon" onClick={() => setShowCart(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
              
              <ScrollArea className="flex-1 p-4">
                {cart.length === 0 ? (
                  <div className="text-center py-8">
                    <ShoppingBag className="w-12 h-12 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">Your cart is empty</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {cart.map(item => (
                      <div key={item.product.productId} className="flex gap-3 py-2 border-b border-border last:border-0">
                        <div className="w-16 h-16 bg-muted rounded-lg flex items-center justify-center flex-shrink-0">
                          <img 
                            src={item.product.imageUrl || '/kozeta-product-logo.svg'} 
                            alt={item.product.name} 
                            className="w-full h-full object-cover rounded-lg"
                            onError={(e) => {
                              (e.target as HTMLImageElement).src = '/kozeta-product-logo.svg';
                            }}
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{item.product.name}</p>
                          <p className="text-xs text-muted-foreground">${item.product.price?.toFixed(2)}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <button 
                              onClick={() => handleUpdateQuantity(item.product.productId, item.quantity - 1)}
                              className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-sm"
                            >
                              -
                            </button>
                            <span className="text-sm font-medium">{item.quantity}</span>
                            <button 
                              onClick={() => handleUpdateQuantity(item.product.productId, item.quantity + 1)}
                              className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-sm"
                            >
                              +
                            </button>
                          </div>
                        </div>
                        <button 
                          onClick={() => handleRemoveFromCart(item.product.productId)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
              
              {cart.length > 0 && (
                <div className="p-4 border-t border-border space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">Subtotal</span>
                    <span className="text-sm font-semibold">${cartTotal.toFixed(2)}</span>
                  </div>
                  
                  {/* Loyalty Points Redemption */}
                  {clientSession?.clientId && (profileData?.loyalty?.points || 0) >= 300 && (
                    <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <Star className="w-4 h-4 text-amber-500" />
                        <span className="text-sm font-medium">Use Loyalty Points</span>
                        <span className="text-xs text-muted-foreground ml-auto">
                          {profileData?.loyalty?.points || 0} pts available
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">300 points = $5 off (stack multiple)</p>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 w-7 p-0"
                          onClick={() => setLoyaltyPointsToRedeem(Math.max(0, loyaltyPointsToRedeem - 1))}
                          disabled={loyaltyPointsToRedeem <= 0}
                          data-testid="button-loyalty-minus"
                        >
                          -
                        </Button>
                        <span className="text-sm font-bold w-8 text-center" data-testid="text-loyalty-points">{loyaltyPointsToRedeem}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 w-7 p-0"
                          onClick={() => {
                            const maxRedemptions = Math.floor((profileData?.loyalty?.points || 0) / 300);
                            const maxDiscountDollars = maxRedemptions * 5;
                            const maxByPrice = Math.floor((cartTotal - 0.50) / 5);
                            setLoyaltyPointsToRedeem(Math.min(loyaltyPointsToRedeem + 1, maxRedemptions, Math.max(0, maxByPrice)));
                          }}
                          disabled={loyaltyPointsToRedeem >= Math.floor((profileData?.loyalty?.points || 0) / 300) || (cartTotal - loyaltyPointsToRedeem * 5) <= 0.50}
                          data-testid="button-loyalty-plus"
                        >
                          +
                        </Button>
                        {loyaltyPointsToRedeem > 0 && (
                          <span className="text-sm text-green-600 dark:text-green-400 font-medium ml-auto">
                            -{loyaltyPointsToRedeem * 300} pts / -${(loyaltyPointsToRedeem * 5).toFixed(2)}
                          </span>
                        )}
                      </div>
                      {loyaltyPointsToRedeem > 0 && (cartTotal - loyaltyPointsToRedeem * 5) <= 0.50 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">Maximum discount reached for this order</p>
                      )}
                    </div>
                  )}
                  
                  {loyaltyPointsToRedeem > 0 && (
                    <div className="flex items-center justify-between text-green-600 dark:text-green-400">
                      <span className="text-sm">Loyalty Discount ({loyaltyPointsToRedeem * 300} pts)</span>
                      <span className="text-sm font-medium">-${(loyaltyPointsToRedeem * 5).toFixed(2)}</span>
                    </div>
                  )}
                  
                  <div className="flex items-center justify-between border-t border-border pt-2">
                    <span className="font-semibold">Total</span>
                    <span className="text-lg font-bold">
                      ${Math.max(0.50, cartTotal - loyaltyPointsToRedeem * 5).toFixed(2)}
                    </span>
                  </div>
                  
                  <Button 
                    className="w-full" 
                    size="lg" 
                    onClick={handleProductCheckout}
                    disabled={isCheckingOut}
                    data-testid="button-checkout"
                  >
                    {isCheckingOut ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Processing...
                      </>
                    ) : (
                      "Proceed to Checkout"
                    )}
                  </Button>
                  <p className="text-xs text-center text-muted-foreground">
                    Payment powered by Stripe
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  const renderBookingView = () => (
    <div className="h-full relative" style={{ minHeight: '500px' }}>
      <div className="absolute inset-0 overflow-y-auto p-4">
        {recentBooking ? (
          <Card className="p-6 text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center mx-auto">
              <Check className="w-8 h-8 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <h3 className="font-semibold text-lg text-green-600 dark:text-green-400">Booking Confirmed!</h3>
              {recentBooking.confirmationNumber && (
                <p className="text-sm text-muted-foreground mt-1">
                  Confirmation: {recentBooking.confirmationNumber}
                </p>
              )}
            </div>
            <div className="text-left bg-muted rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-primary" />
                <span className="text-sm">
                  {new Date(recentBooking.startDateTime).toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric'
                  })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary" />
                <span className="text-sm">
                  {new Date(recentBooking.startDateTime).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit'
                  })}
                </span>
              </div>
              {recentBooking.services?.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Star className="w-4 h-4 text-primary" />
                  <span className="text-sm">{s.serviceName}</span>
                </div>
              ))}
            </div>
            <Button onClick={() => toggleViewMode("chat")} className="w-full">
              Back to Chat
            </Button>
          </Card>
        ) : selectedService ? (
          <div className="space-y-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBackToCatalog}
              className="mb-2"
              data-testid="button-back-to-catalog"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Services
            </Button>
            <AvailabilityPicker
              serviceIds={selectedService.phorestServiceId ? [selectedService.phorestServiceId] : [selectedService.key]}
              serviceName={selectedService.name}
              servicePrice={services.find(s => s.name === selectedService.name)?.price}
              clientId={clientSession?.clientId}
              sessionId={sessionId}
              onBookingComplete={handleBookingComplete}
              onCancel={handleBackToCatalog}
              onAuthRequired={handleAuthRequired}
              onPaymentRequired={handlePaymentRequired}
              slotConflictNonce={slotConflictNonce}
            />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Search Bar */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search services..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
                data-testid="input-search-services"
              />
            </div>

            {/* Category Tabs - wrapping on desktop, scrolling on mobile */}
            <Tabs value={selectedCategory} onValueChange={setSelectedCategory} className="w-full">
              <div className="relative">
                {/* Mobile: horizontal scroll */}
                <div className="md:hidden overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-muted scrollbar-track-transparent">
                  <TabsList className="inline-flex w-max gap-1 bg-muted/50 p-1">
                    {categories.map((cat) => (
                      <TabsTrigger
                        key={cat}
                        value={cat}
                        className="text-xs capitalize whitespace-nowrap"
                        data-testid={`tab-category-${cat}`}
                      >
                        {cat === "all" ? "All Services" : cat}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
                {/* Desktop: wrap tabs for visibility */}
                <div className="hidden md:block">
                  <TabsList className="flex flex-wrap gap-1 bg-muted/50 p-1 h-auto">
                    {categories.map((cat) => (
                      <TabsTrigger
                        key={cat}
                        value={cat}
                        className="text-xs capitalize whitespace-nowrap"
                        data-testid={`tab-category-desktop-${cat}`}
                      >
                        {cat === "all" ? "All Services" : cat}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
                {/* Scroll indicator - mobile only */}
                <div className="flex justify-center mt-2 md:hidden">
                  <div className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground">
                    <ChevronRight className="w-4 h-4 animate-pulse" />
                    <span>side scroll for more service types</span>
                  </div>
                </div>
              </div>

              {/* Services Grid */}
              <TabsContent value={selectedCategory} className="mt-4">
                {servicesLoading ? (
                  <div className="space-y-3">
                    {[1, 2, 3].map((i) => (
                      <Card key={i} className="p-4 animate-pulse">
                        <div className="h-4 bg-muted rounded w-3/4 mb-2" />
                        <div className="h-3 bg-muted rounded w-1/2" />
                      </Card>
                    ))}
                  </div>
                ) : servicesError ? (
                  <Card className="p-6 text-center" data-testid="card-services-error">
                    <Sparkles className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground mb-3">
                      We couldn't load our services right now. Please try again.
                    </p>
                    <Button variant="outline" size="sm" onClick={() => refetchServices()} data-testid="button-retry-services">
                      Try Again
                    </Button>
                  </Card>
                ) : filteredServices.length === 0 ? (
                  <Card className="p-6 text-center">
                    <Sparkles className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">
                      No services found. Try a different search or category.
                    </p>
                  </Card>
                ) : selectedCategory === "all" ? (
                  <div className="space-y-6">
                    {sortedCategoryKeys.map((category) => (
                      <div key={category}>
                        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                          {category}
                        </h3>
                        <div className="space-y-2">
                          {servicesByCategory[category].map((service) => (
                            <ServiceCard
                              key={service.key}
                              service={service}
                              onBook={() => handleBookSpecificService(service.key, service.name, service.phorestServiceId)}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredServices.map((service) => (
                      <ServiceCard
                        key={service.key}
                        service={service}
                        onBook={() => handleBookSpecificService(service.key, service.name, service.phorestServiceId)}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>

    </div>
  );

  const handleNavigateToShop = useCallback(() => {
    setViewMode('shop');
  }, []);

  const handleNavigateToBook = useCallback(() => {
    setViewMode('book');
  }, []);

  const renderContent = () => {
    if (!PORTAL_ENABLED) {
      // Login-only mode: profile is the only view.
      return renderProfileView();
    }
    switch (viewMode) {
      case "chat":
        return (
          <div className="h-full overflow-y-auto">
            <AiChat 
              initialMessage={initialMessage} 
              onServiceRecommendation={handleServiceRecommendation}
              onBookSpecificService={handleBookSpecificService}
              context="chat"
            />
          </div>
        );
      case "book":
        return (
          <div className="h-full relative pb-16">
            {renderBookingView()}
            <FloatingChatDock
              context="book"
              onBookService={handleBookSpecificService}
              onNavigateToShop={handleNavigateToShop}
              onNavigateToBook={handleNavigateToBook}
              isInline={true}
              externalMessages={sharedChatMessages}
              onMessagesChange={setSharedChatMessages}
            />
          </div>
        );
      case "shop":
        return (
          <div className="h-full relative pb-16">
            {renderShopView()}
            <FloatingChatDock
              context="shop"
              onAddToCart={handleAddToCart}
              onNavigateToShop={handleNavigateToShop}
              onNavigateToBook={handleNavigateToBook}
              isInline={true}
              externalMessages={sharedChatMessages}
              onMessagesChange={setSharedChatMessages}
            />
          </div>
        );
      case "profile":
        return renderProfileView();
      default:
        return null;
    }
  };

  if (isInline) {
    return (
      <>
        <div className="w-full h-full flex flex-col min-h-[600px]">
          {renderHeader()}
          <div className="flex-1 relative overflow-y-auto">
            {renderContent()}
          </div>
        </div>

        {/* SMS Booking Banner — visible when client tapped a payment link from SMS */}
        {smsBookingPreview && !showPaymentDialog && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[min(420px,calc(100%-32px))]">
            <div className="rounded-xl border border-border bg-background/95 backdrop-blur-sm shadow-lg p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-sm">{smsBookingPreview.serviceName}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {new Date(smsBookingPreview.startDateTime).toLocaleDateString("en-CA", {
                      timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric"
                    })}&nbsp;·&nbsp;
                    {new Date(smsBookingPreview.startDateTime).toLocaleTimeString("en-CA", {
                      timeZone: "America/Toronto", hour: "numeric", minute: "2-digit", hour12: true
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Deposit: ${(smsBookingPreview.depositAmount / 100).toFixed(2)}
                  </p>
                </div>
                <button
                  className="text-muted-foreground hover:text-foreground transition-colors mt-0.5"
                  onClick={() => setSmsBookingPreview(null)}
                  aria-label="Dismiss"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <Button
                size="sm"
                className="w-full"
                onClick={() => {
                  if (smsPidToken) {
                    // Token path: fetch payment intent directly, no login needed
                    smsPaymentFetchedRef.current = false;
                  } else if (!clientSession) {
                    setShowLoginModal(true);
                  } else {
                    smsPaymentFetchedRef.current = false;
                  }
                }}
              >
                Complete Payment
              </Button>
            </div>
          </div>
        )}

        {/* Payment Dialog — token path (no login) OR normal session path */}
        {showPaymentDialog && paymentBookingContext && (clientSession || smsPaymentReady?.clientId) && (
          <PaymentDialog
            isOpen={showPaymentDialog}
            bookingDetails={paymentBookingContext}
            clientId={clientSession?.clientId ?? smsPaymentReady?.clientId ?? ''}
            sessionId={sessionId}
            loyaltyPoints={profileData?.loyalty?.points || 0}
            isMassageService={/massage/i.test(paymentBookingContext.serviceName || '')}
            initialClientSecret={smsPaymentReady?.clientSecret}
            initialPendingId={smsPaymentReady?.pendingId}
            initialDepositCents={smsPaymentReady?.depositCents}
            onSuccess={(r) => {
              const piId = smsPaymentReady?.paymentIntentId;
              setSmsPaymentReady(null); setSmsPid(null); handlePaymentSuccess(r);
              if (piId) setSmsSaveCardOffer({ paymentIntentId: piId });
            }}
            onCancel={() => { setSmsPaymentReady(null); handlePaymentCancel(); }}
            onSlotConflict={handleSlotConflict}
          />
        )}

        {/* Product Payment Dialog */}
        {showProductPaymentDialog && productCheckoutContext && (
          <ProductPaymentDialog
            isOpen={showProductPaymentDialog}
            clientSecret={productCheckoutContext.clientSecret}
            totalAmount={productCheckoutContext.totalAmount}
            subtotalAmount={productCheckoutContext.subtotalAmount}
            loyaltyPointsRedeemed={productCheckoutContext.loyaltyPointsRedeemed}
            loyaltyDiscountAmount={productCheckoutContext.loyaltyDiscountAmount}
            onSuccess={handleProductPaymentSuccess}
            onCancel={handleProductPaymentCancel}
          />
        )}

        {/* In-Portal Login Modal */}
        <LoginModal
          isOpen={showLoginModal}
          onClose={() => setShowLoginModal(false)}
          onLoginSuccess={handlePortalLoginSuccess}
        />
      </>
    );
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm transition-all duration-300"
        onClick={onClose}
        data-testid="button-portal-backdrop"
      />

      <div className="fixed z-50 inset-x-4 bottom-4 top-16 md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-[min(800px,calc(100%-64px))] md:h-[min(700px,calc(100vh-128px))] transition-all duration-400 ease-out">
        <Card className="w-full h-full flex flex-col shadow-2xl border-border overflow-hidden rounded-3xl">
          {renderHeader()}
          <div className="flex-1 relative overflow-y-auto">
            {renderContent()}
          </div>
        </Card>
      </div>

      {/* SMS Booking Banner — for full modal render */}
      {smsBookingPreview && !showPaymentDialog && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] w-[min(420px,calc(100%-32px))]">
          <div className="rounded-xl border border-border bg-background/95 backdrop-blur-sm shadow-lg p-4 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-sm">{smsBookingPreview.serviceName}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(smsBookingPreview.startDateTime).toLocaleDateString("en-CA", {
                    timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric"
                  })}&nbsp;·&nbsp;
                  {new Date(smsBookingPreview.startDateTime).toLocaleTimeString("en-CA", {
                    timeZone: "America/Toronto", hour: "numeric", minute: "2-digit", hour12: true
                  })}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Deposit: ${(smsBookingPreview.depositAmount / 100).toFixed(2)}
                </p>
              </div>
              <button
                className="text-muted-foreground hover:text-foreground transition-colors mt-0.5"
                onClick={() => setSmsBookingPreview(null)}
                aria-label="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <Button
              size="sm"
              className="w-full"
              onClick={() => {
                if (!clientSession) {
                  setShowLoginModal(true);
                } else {
                  smsPaymentFetchedRef.current = false;
                }
              }}
            >
              {clientSession ? "Complete Payment" : "Log in to Pay Deposit"}
            </Button>
          </div>
        </div>
      )}

      {/* Payment Dialog */}
      {showPaymentDialog && paymentBookingContext && clientSession && (
        <PaymentDialog
          isOpen={showPaymentDialog}
          bookingDetails={paymentBookingContext}
          clientId={clientSession.clientId}
          sessionId={sessionId}
          loyaltyPoints={profileData?.loyalty?.points || 0}
          isMassageService={/massage/i.test(paymentBookingContext.serviceName || '')}
          initialClientSecret={smsPaymentReady?.clientSecret}
          initialPendingId={smsPaymentReady?.pendingId}
          initialDepositCents={smsPaymentReady?.depositCents}
          onSuccess={(r) => {
            const piId = smsPaymentReady?.paymentIntentId;
            setSmsPaymentReady(null); setSmsPid(null); handlePaymentSuccess(r);
            if (piId) setSmsSaveCardOffer({ paymentIntentId: piId });
          }}
          onCancel={() => { setSmsPaymentReady(null); handlePaymentCancel(); }}
          onSlotConflict={handleSlotConflict}
        />
      )}

      {/* Product Payment Dialog */}
      {showProductPaymentDialog && productCheckoutContext && (
        <ProductPaymentDialog
          isOpen={showProductPaymentDialog}
          clientSecret={productCheckoutContext.clientSecret}
          totalAmount={productCheckoutContext.totalAmount}
          subtotalAmount={productCheckoutContext.subtotalAmount}
          loyaltyPointsRedeemed={productCheckoutContext.loyaltyPointsRedeemed}
          loyaltyDiscountAmount={productCheckoutContext.loyaltyDiscountAmount}
          onSuccess={handleProductPaymentSuccess}
          onCancel={handleProductPaymentCancel}
        />
      )}

      {/* Product Purchase Result Dialog */}
      {productPurchaseResult && (
        <>
          <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm" onClick={() => setProductPurchaseResult(null)} />
          <div className="fixed z-[70] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(380px,calc(100%-32px))]">
            <Card className="shadow-2xl rounded-2xl overflow-hidden p-5">
              <div className="text-center space-y-3">
                {productPurchaseResult.success ? (
                  <>
                    <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
                      <Check className="w-6 h-6 text-green-600 dark:text-green-400" />
                    </div>
                    <div>
                      <p className="font-semibold text-lg">Purchase complete!</p>
                      {productPurchaseResult.itemCount !== undefined && (
                        <p className="text-sm text-muted-foreground mt-1">
                          {productPurchaseResult.itemCount} item{productPurchaseResult.itemCount !== 1 ? 's' : ''} ordered
                          {productPurchaseResult.totalPaid !== undefined && ` · $${productPurchaseResult.totalPaid.toFixed(2)} paid`}
                        </p>
                      )}
                      {productPurchaseResult.loyaltyPointsEarned ? (
                        <p className="text-sm text-amber-600 dark:text-amber-400 mt-1 flex items-center justify-center gap-1">
                          <Star className="w-3.5 h-3.5" />
                          +{productPurchaseResult.loyaltyPointsEarned} loyalty points earned
                        </p>
                      ) : null}
                    </div>
                    <Button className="w-full mt-1" onClick={() => setProductPurchaseResult(null)} data-testid="button-product-result-done">
                      Done
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
                      <AlertTriangle className="w-6 h-6 text-destructive" />
                    </div>
                    <div>
                      <p className="font-semibold text-lg">{productPurchaseResult.title || 'Purchase Issue'}</p>
                      <p className="text-sm text-muted-foreground mt-1">{productPurchaseResult.message}</p>
                    </div>
                    {productPurchaseResult.paymentId && (
                      <div className="bg-muted rounded-md p-2 flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground font-mono truncate">{productPurchaseResult.paymentId}</span>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            navigator.clipboard.writeText(productPurchaseResult.paymentId!);
                            toast({ description: "Payment ID copied" });
                          }}
                          data-testid="button-copy-product-payment-id"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    )}
                    {stripeConfig?.salonPhone && (
                      <a href={`tel:${stripeConfig.salonPhone}`} className="flex items-center justify-center w-full">
                        <Button variant="outline" className="w-full gap-2" data-testid="button-call-salon-product">
                          <Phone className="w-4 h-4" />
                          Call Kozeta Salon
                        </Button>
                      </a>
                    )}
                    <Button
                      className="w-full mt-1"
                      onClick={() => setProductPurchaseResult(null)}
                      data-testid="button-product-result-close"
                    >
                      Close
                    </Button>
                  </>
                )}
              </div>
            </Card>
          </div>
        </>
      )}

      {/* Save-card prompt — appears after SMS-link deposit when client is logged in */}
      {smsSaveCardOffer && clientSession && (
        <div className="fixed inset-0 z-[9900] flex items-end justify-center p-4 pb-8 pointer-events-none">
          <Card className="pointer-events-auto w-full max-w-sm shadow-xl border border-border/60 bg-background/95 backdrop-blur-sm">
            <div className="p-5">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <p className="text-sm font-medium leading-snug">Save card for faster text bookings?</p>
                </div>
                <button
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  onClick={() => setSmsSaveCardOffer(null)}
                  data-testid="button-save-card-dismiss"
                  aria-label="Dismiss"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
                Next time you book via text, we can charge this card automatically — no portal login needed.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1 gap-1.5"
                  data-testid="button-save-card-confirm"
                  onClick={async () => {
                    try {
                      const sid = sessionId ?? localStorage.getItem('kozeta_session_id') ?? '';
                      const stok = localStorage.getItem('kozeta_session_token') ?? '';
                      const res = await fetch('/api/payments/save-card', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          paymentIntentId: smsSaveCardOffer.paymentIntentId,
                          sessionId: sid,
                          sessionToken: stok,
                        }),
                      });
                      setSmsSaveCardOffer(null);
                      if (res.ok) {
                        toast({ title: "Card saved!", description: "We'll use it for your next text booking." });
                      } else {
                        toast({ title: "Could not save card", description: "Please try again later.", variant: "destructive" });
                      }
                    } catch {
                      setSmsSaveCardOffer(null);
                      toast({ title: "Could not save card", description: "Please try again later.", variant: "destructive" });
                    }
                  }}
                >
                  <Check className="w-3.5 h-3.5" />
                  Save card
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  data-testid="button-save-card-skip"
                  onClick={() => setSmsSaveCardOffer(null)}
                >
                  No thanks
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* In-Portal Login Modal */}
      <LoginModal
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onLoginSuccess={handlePortalLoginSuccess}
      />
    </>
  );
}

import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Search, RefreshCw, Eye, EyeOff, Package, ArrowLeft, Check } from "lucide-react";

interface AdminProduct {
  productId: string;
  name: string;
  brandName: string;
  categoryName: string;
  price: number;
  inStock: boolean;
  stockLevel?: number;
  imageUrl: string;
  visible: boolean;
}

interface AdminProductsResponse {
  products: AdminProduct[];
  brands: string[];
  totalProducts: number;
  visibleCount: number;
}

export default function AdminProducts() {
  const [search, setSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState("all");
  const [visibilityFilter, setVisibilityFilter] = useState<"all" | "visible" | "hidden">("all");
  const [pendingChanges, setPendingChanges] = useState<Map<string, boolean>>(new Map());
  const { toast } = useToast();

  const { data, isLoading, refetch } = useQuery<AdminProductsResponse>({
    queryKey: ["/api/admin/products"],
    staleTime: 30000,
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ productId, visible }: { productId: string; visible: boolean }) => {
      const res = await apiRequest("POST", "/api/admin/products/visibility", { productId, visible });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const bulkMutation = useMutation({
    mutationFn: async (updates: { productId: string; visible: boolean }[]) => {
      const res = await apiRequest("POST", "/api/admin/products/visibility/bulk", { updates });
      return res.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      setPendingChanges(new Map());
      toast({
        title: "Saved",
        description: `Updated visibility for ${variables.length} products`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/products/refresh");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/products"] });
      toast({ title: "Refreshed", description: "Product cache refreshed from Phorest" });
    },
  });

  const handleToggle = useCallback((productId: string, currentVisible: boolean) => {
    const newVisible = !currentVisible;
    const newPending = new Map(pendingChanges);
    const originalVisible = data?.products.find(p => p.productId === productId)?.visible;

    if (originalVisible === newVisible) {
      newPending.delete(productId);
    } else {
      newPending.set(productId, newVisible);
    }
    setPendingChanges(newPending);
  }, [pendingChanges, data]);

  const savePendingChanges = useCallback(() => {
    const updates = Array.from(pendingChanges.entries()).map(([productId, visible]) => ({
      productId,
      visible,
    }));
    if (updates.length > 0) {
      bulkMutation.mutate(updates);
    }
  }, [pendingChanges, bulkMutation]);

  const filteredProducts = useMemo(() => {
    if (!data?.products) return [];

    let products = data.products;

    if (search) {
      const searchLower = search.toLowerCase();
      products = products.filter(p =>
        p.name?.toLowerCase().includes(searchLower) ||
        p.brandName?.toLowerCase().includes(searchLower) ||
        p.categoryName?.toLowerCase().includes(searchLower)
      );
    }

    if (brandFilter && brandFilter !== "all") {
      products = products.filter(p => p.brandName === brandFilter);
    }

    if (visibilityFilter !== "all") {
      products = products.filter(p => {
        const effectiveVisible = pendingChanges.has(p.productId)
          ? pendingChanges.get(p.productId)
          : p.visible;
        return visibilityFilter === "visible" ? effectiveVisible : !effectiveVisible;
      });
    }

    return products;
  }, [data, search, brandFilter, visibilityFilter, pendingChanges]);

  const stats = useMemo(() => {
    if (!data) return { total: 0, visible: 0, hidden: 0 };
    const pendingVisible = new Set(
      Array.from(pendingChanges.entries())
        .filter(([, v]) => v)
        .map(([id]) => id)
    );
    const pendingHidden = new Set(
      Array.from(pendingChanges.entries())
        .filter(([, v]) => !v)
        .map(([id]) => id)
    );

    let visibleCount = 0;
    data.products.forEach(p => {
      if (pendingVisible.has(p.productId)) {
        visibleCount++;
      } else if (pendingHidden.has(p.productId)) {
      } else if (p.visible) {
        visibleCount++;
      }
    });

    return {
      total: data.totalProducts,
      visible: visibleCount,
      hidden: data.totalProducts - visibleCount,
    };
  }, [data, pendingChanges]);

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <a href="/" data-testid="link-back-home">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft />
              </Button>
            </a>
            <div>
              <h1 className="text-lg font-semibold" data-testid="text-page-title">Product Visibility</h1>
              <p className="text-sm text-muted-foreground">Manage which products appear in the storefront</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {pendingChanges.size > 0 && (
              <Button
                onClick={savePendingChanges}
                disabled={bulkMutation.isPending}
                data-testid="button-save-changes"
              >
                <Check className="mr-1 h-4 w-4" />
                Save {pendingChanges.size} change{pendingChanges.size !== 1 ? "s" : ""}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
              data-testid="button-refresh-cache"
            >
              <RefreshCw className={`mr-1 h-4 w-4 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-4 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Card data-testid="card-stat-total">
            <CardContent className="pt-4 pb-3 px-4">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Total RETAIL</span>
              </div>
              <p className="text-2xl font-semibold mt-1" data-testid="text-stat-total">{stats.total}</p>
            </CardContent>
          </Card>
          <Card data-testid="card-stat-visible">
            <CardContent className="pt-4 pb-3 px-4">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Visible</span>
              </div>
              <p className="text-2xl font-semibold mt-1" data-testid="text-stat-visible">{stats.visible}</p>
            </CardContent>
          </Card>
          <Card data-testid="card-stat-hidden">
            <CardContent className="pt-4 pb-3 px-4">
              <div className="flex items-center gap-2">
                <EyeOff className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Hidden</span>
              </div>
              <p className="text-2xl font-semibold mt-1" data-testid="text-stat-hidden">{stats.hidden}</p>
            </CardContent>
          </Card>
        </div>

        <div className="flex gap-3 flex-wrap items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search products..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              data-testid="input-search"
            />
          </div>
          <Select value={brandFilter} onValueChange={setBrandFilter}>
            <SelectTrigger className="w-[180px]" data-testid="select-brand">
              <SelectValue placeholder="All Brands" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Brands</SelectItem>
              {data?.brands?.map(brand => (
                <SelectItem key={brand} value={brand}>{brand}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={visibilityFilter} onValueChange={(v) => setVisibilityFilter(v as "all" | "visible" | "hidden")}>
            <SelectTrigger className="w-[140px]" data-testid="select-visibility">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="visible">Visible</SelectItem>
              <SelectItem value="hidden">Hidden</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p className="text-sm text-muted-foreground" data-testid="text-result-count">
          Showing {filteredProducts.length} product{filteredProducts.length !== 1 ? "s" : ""}
        </p>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredProducts.map(product => {
              const effectiveVisible = pendingChanges.has(product.productId)
                ? pendingChanges.get(product.productId)!
                : product.visible;
              const hasPendingChange = pendingChanges.has(product.productId);

              return (
                <div
                  key={product.productId}
                  className={`flex items-center gap-3 px-3 py-2 rounded-md border ${
                    hasPendingChange ? "border-primary/30 bg-primary/5" : "border-transparent"
                  }`}
                  data-testid={`row-product-${product.productId}`}
                >
                  <img
                    src={product.imageUrl}
                    alt={product.name}
                    className="h-10 w-10 rounded-md object-cover flex-shrink-0"
                    data-testid={`img-product-${product.productId}`}
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = '/kozeta-product-logo.svg';
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" data-testid={`text-name-${product.productId}`}>
                      {product.name}
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-muted-foreground">{product.brandName}</span>
                      {product.categoryName && (
                        <Badge variant="secondary" className="text-xs">
                          {product.categoryName}
                        </Badge>
                      )}
                      {!product.inStock && (
                        <Badge variant="destructive" className="text-xs">Out of stock</Badge>
                      )}
                    </div>
                  </div>
                  <span className="text-sm font-medium tabular-nums text-muted-foreground" data-testid={`text-price-${product.productId}`}>
                    ${product.price?.toFixed(2)}
                  </span>
                  <Switch
                    checked={effectiveVisible}
                    onCheckedChange={() => handleToggle(product.productId, effectiveVisible)}
                    data-testid={`switch-visibility-${product.productId}`}
                  />
                </div>
              );
            })}
            {filteredProducts.length === 0 && (
              <div className="py-12 text-center text-muted-foreground">
                <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No products found</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

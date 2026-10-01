import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/home";
import AdminProducts from "@/pages/admin-products";
import AdminDeposits from "@/pages/admin-deposits";
import NotFound from "@/pages/not-found";
import { useEffect } from "react";

function VisibilityRefresh() {
  const qc = useQueryClient();
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") {
        qc.invalidateQueries({ queryKey: ["/api/profile"] });
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [qc]);
  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/admin/products" component={AdminProducts} />
      <Route path="/admin/deposits" component={AdminDeposits} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <VisibilityRefresh />
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

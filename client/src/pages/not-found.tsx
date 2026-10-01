import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[hsl(40,32%,95%)]">
      <div className="text-center px-6 py-12 max-w-md">
        <h1 className="font-serif text-4xl font-light tracking-widest text-stone-700 mb-4">
          404
        </h1>
        <p className="text-stone-500 mb-2 tracking-wide uppercase text-sm">Page Not Found</p>
        <p className="text-stone-400 text-sm mb-8">
          The page you're looking for doesn't exist or may have moved.
        </p>
        <Button
          variant="outline"
          onClick={() => setLocation("/")}
          className="tracking-widest uppercase text-xs"
        >
          Return to Kozeta Salon
        </Button>
      </div>
    </div>
  );
}

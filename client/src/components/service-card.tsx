import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { SalonService } from "@shared/schema";

interface ServiceCardProps {
  service: SalonService;
  onBook: () => void;
}

export function ServiceCard({ service, onBook }: ServiceCardProps) {
  return (
    <Card
      className="rounded-2xl overflow-hidden hover-elevate transition-all duration-300 hover:-translate-y-1 group"
      data-testid={`card-service-${service.key}`}
    >
      {/* Service Image */}
      <div className="aspect-square overflow-hidden bg-muted">
        {service.imageUrl ? (
          <img
            src={service.imageUrl}
            alt={service.name}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/10 to-accent/10">
            <Sparkles className="w-12 h-12 text-primary" />
          </div>
        )}
      </div>

      <CardContent className="p-6 space-y-3">
        {/* Category Badge */}
        <Badge variant="secondary" className="rounded-full text-xs">
          {service.category}
        </Badge>

        {/* Service Name */}
        <h3
          className="text-xl md:text-2xl font-serif font-normal text-foreground"
          data-testid={`text-service-name-${service.key}`}
        >
          {service.name}
        </h3>

        {/* Duration & Price */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span data-testid={`text-duration-${service.key}`}>{service.duration}</span>
          <span>•</span>
          <span
            className="font-medium text-foreground"
            data-testid={`text-price-${service.key}`}
          >
            {service.price}
          </span>
        </div>

        {/* Description */}
        <p className="text-sm md:text-base text-muted-foreground font-light leading-relaxed">
          {service.description}
        </p>
      </CardContent>

      <CardFooter className="p-6 pt-0">
        <Button
          data-testid={`button-book-service-${service.key}`}
          onClick={onBook}
          className="w-full rounded-full"
          variant="default"
        >
          Book This Service
        </Button>
      </CardFooter>
    </Card>
  );
}

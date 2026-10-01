import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";

interface StylistCardProps {
  stylist: {
    name: string;
    specialty: string;
    bio: string;
    imageUrl?: string;
  };
}

export function StylistCard({ stylist }: StylistCardProps) {
  const initials = stylist.name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase();

  return (
    <Card
      className="rounded-2xl hover-elevate transition-all duration-300 hover:-translate-y-1"
      data-testid={`card-stylist-${stylist.name.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <CardContent className="p-8 md:p-10 text-center space-y-4">
        {/* Stylist Photo */}
        <div className="flex justify-center">
          <Avatar className="w-32 h-32 border-4 border-primary/10">
            {stylist.imageUrl && (
              <AvatarImage
                src={stylist.imageUrl}
                alt={stylist.name}
                className="object-cover"
              />
            )}
            <AvatarFallback className="text-2xl font-serif bg-gradient-to-br from-primary/20 to-accent/20 text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
        </div>

        {/* Name */}
        <div className="space-y-1">
          <h3
            className="text-xl md:text-2xl font-serif font-normal text-foreground"
            data-testid={`text-stylist-name-${stylist.name.toLowerCase().replace(/\s+/g, '-')}`}
          >
            {stylist.name}
          </h3>
          <p className="text-sm text-primary font-medium">{stylist.specialty}</p>
        </div>

        {/* Bio */}
        <p className="text-sm md:text-base text-muted-foreground font-light leading-relaxed">
          {stylist.bio}
        </p>
      </CardContent>
    </Card>
  );
}

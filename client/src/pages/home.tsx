import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Sparkles, Calendar, MapPin, Phone, Mail, Clock, Instagram, LogIn, User, X, MessageCircle, Send, ChevronUp, ChevronDown, Star, Gift, History, ChevronLeft, ChevronRight, ShoppingBag } from "lucide-react";
import useEmblaCarousel from "embla-carousel-react";
import Autoplay from "embla-carousel-autoplay";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PortalCard } from "@/components/portal-card";
import { AuthPanel } from "@/components/auth-panel";
import { LoginModal } from "@/components/login-modal";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ClientSession, ProfileResponse } from "@shared/schema";
import kozetaImg from "@assets/team/kozeta-izeti.jpg";
import royaImg from "@assets/team/roya-massah.jpg";
import zanaImg from "@assets/team/zana-tomasovic.jpg";
import laurenImg from "@assets/team/lauren-shostal.jpg";
import armandoImg from "@assets/team/armando.jpg";
import asmaImg from "@assets/team/asma-yousifi.jpg";
import jaclynImg from "@assets/team/jaclyn-mendoza.jpg";
import lindsayImg from "@assets/team/lindsay-orlans.jpg";
import francescaImg from "@assets/team/francesca-bruni.jpg";
import nazImg from "@assets/team/naz-nargesian.jpg";
import { HeroPattern } from "@/components/hero-pattern";
import { PORTAL_ENABLED, LOGIN_ENABLED, PHOREST_BOOKING_URL } from "@shared/portalConfig";

// Open Phorest's own online booking page. Works inside the Wix iframe:
// window.open with a plain URL opens a NEW top-level tab, never blocked by
// the iframe sandbox in this configuration.
function openPhorestBooking() {
  window.open(PHOREST_BOOKING_URL, "_blank", "noopener,noreferrer");
}

const TEAM_MEMBERS: Array<{
  name: string;
  title: string;
  image: string | null;
  bio: string;
  instagram: string | null;
  bookingUrl?: string;
  bookingLabel?: string;
}> = [
  {
    name: "Kozeta Izeti",
    title: "Founder & Master Stylist",
    image: kozetaImg,
    bio: "Kozeta began her journey in beauty at just 17, when hair became more than a hobby — it became her passion. After earning a teaching degree, she moved to Canada 25 years ago and followed her heart into hairstyling, completing her training and spending seven years perfecting her craft in Yorkville. For the past 16 years, she has proudly owned and led Kozeta Salon & Spa, specializing in luxury colour, precision highlighting, seamless extensions, and modern styling. Kozeta has won multiple awards, including a prestigious North American accolade, and continues to innovate and inspire in the industry she loves. Her clients have become her family — the foundation of her success and the heart of her salon.",
    instagram: "kozetasalonspa"
  },
  {
    name: "Zana Tomasovic",
    title: "Master Stylist",
    image: zanaImg,
    bio: "Zana brings over 25 years of experience to the beauty industry and has always been inspired and passionate about hair. Her credentials include advanced training at the esteemed Vidal Sassoon, where she strengthened her technical foundation and creative vision. She is highly skilled in colour correction, dimensional highlights, creative colour, and medium-to-long haircuts. Her years of experience working in Los Angeles have refined her eye for style, allowing her to blend current trends with looks that complement each client's unique individuality. Zana's expertise, artistry, and dedication make her a trusted stylist for clients seeking both precision and creativity.",
    instagram: null
  },
  {
    name: "Roya Massah",
    title: "Master Stylist & Professional Colorist",
    image: royaImg,
    bio: "Roya is a master stylist with over 2 decades of experience, known for her artistic eye and passion for creating beautiful, natural-looking color. She began her training at one of Iran's top beauty institutes and continued her education in Canada, where she earned her professional license. Always committed to growth, Roya has completed advanced color and highlight courses with L'Oréal Professionnel, Schwarzkopf Professional, and Goldwell, mastering modern techniques and global color trends. She believes in educating her clients on proper maintenance and product care, ensuring they enjoy lasting, salon-quality results at home.",
    instagram: "royamassah2020"
  },
  {
    name: "Lauren Shostal",
    title: "Blonde Specialist & Senior Colourist",
    image: laurenImg,
    bio: "Known for her exceptional blonde work, Lauren has been in the hair industry for over 17 years, spending the majority of her career at one of Toronto's leading salons. She holds extensive training and is a proud graduate of the Aveda Academy, where she refined her technical skill and artistic vision. Lauren's meticulous attention to detail allows her to create rich, beautiful tones and natural, seamless highlighting. Her expertise includes dimensional brunettes, radiant reds, glowing coppers, and natural highlights ranging from soft sun-kissed hues to bright honey blondes. Her commitment to customized colour and her eye for tone make Lauren a trusted choice for clients seeking elevated, natural-looking results.",
    instagram: "herprettybird"
  },
  {
    name: "Armando",
    title: "Senior Stylist",
    image: armandoImg,
    bio: "With over 20 years of experience, Armando specializes in both women's and men's haircuts. He previously owned his own salon before joining our team, bringing with him a wealth of expertise and a strong commitment to his craft. Known for his kind and caring nature, Armando is a highly skilled stylist who takes pride in delivering precise cuts and personalized experiences for every client.",
    instagram: null
  },
  {
    name: "Asma Yousifi",
    title: "Intermediate Stylist",
    image: asmaImg,
    bio: "Asma has always been passionate about pursuing a career in the beauty industry. She graduated from Marca College for Hair & Esthetics in 2020 and has continuously expanded her skills and artistry since. Beginning her journey as an assistant and junior stylist, Asma has grown into her role as an intermediate stylist through dedication, talent, and hands-on experience on the salon floor. She loves creating beautiful haircuts, hairstyles, hair treatments, and colour services, and she is also highly skilled in threading and specializes in keratin treatments — adding to her versatile and in-demand skill set. Asma's warm personality, growing expertise, and commitment to her craft make her a valued member of the team and a stylist clients love to trust.",
    instagram: "hairbyassma"
  },
  {
    name: "Doni",
    title: "Senior Stylist & Makeup Artist",
    image: null,
    bio: "Doni began his career at a very young age working in television in Albania, where he perfected the art of hair and makeup under fast-paced, high-pressure environments. His expertise shines in long-hair styling, dimensional colour, precision highlights, flawless makeup artistry, and he is also a curly-hair and keratin specialist known for enhancing natural texture and delivering smooth, polished results. With a strong creative eye and an international background, Doni brings elevated beauty and confidence to every client he works with.",
    instagram: null
  },
  {
    name: "Jaclyn Mendoza",
    title: "Senior Esthetician",
    image: jaclynImg,
    bio: "With over a decade of hands-on experience in the beauty and wellness industry, Jaclyn brings both expertise and warmth to every client experience. Known for her loyal, compassionate, and attentive nature, she creates a welcoming environment where clients feel truly cared for. Jaclyn has held leadership roles as a Lead Waxologist and Esthetician at top clinics across the GTA, including Aroma Waxing Clinic, Nabi Spa, and The Ten Spot. Her advanced esthetics training from George Brown College, paired with extensive product knowledge across leading skincare lines, makes her a trusted professional for precision waxing, lash lifts, customized facials, and makeup services. Thriving in fast-paced environments, Jaclyn believes self-care is a powerful form of self-expression. Her mission is to help clients feel confident, refreshed, and their absolute best.",
    instagram: null
  },
  {
    name: "Kana",
    title: "Shiatsu Massage Therapist",
    image: null,
    bio: "Kana is an exceptional Shiatsu massage therapist trained in Japan, bringing over 20 years of experience to her practice. With her intuitive touch and deep understanding of the body, she helps melt away stress and restore balance. Shiatsu is known for reducing stress and anxiety, relieving pain, improving circulation, and moving stagnant energy — and Kana's expertise makes every treatment both healing and transformative.",
    instagram: null
  },
  {
    name: "Lindsay Orlans, RPN",
    title: "Aesthetic Nurse",
    image: lindsayImg,
    bio: "Specializing in Botox, fillers, and advanced facial rejuvenation, Lindsay is a skilled aesthetic nurse dedicated to helping clients look and feel their absolute best. With a gentle approach and a strong clinical foundation, she delivers natural, refined results tailored to each client's unique features and goals. Lindsay practices under the supervision of a licensed medical doctor, ensuring the highest standards of safety, professionalism, and medical oversight in every treatment she performs. Her commitment to continuous education and evidence-based practice makes her a trusted provider for injectable and non-surgical cosmetic enhancements.",
    instagram: "nurselindsayto",
    bookingUrl: "https://www.instagram.com/nurselindsayto",
    bookingLabel: "Book with Lindsay"
  },
  {
    name: "Francesca Bruni",
    title: "Microblading Eyebrow Specialist",
    image: francescaImg,
    bio: "Francesca is a skilled Microblading Eyebrow Specialist known for her precision and natural, beautifully shaped brows. With advanced training and an eye for detail, she customizes each brow to enhance every client's unique features. Her gentle approach and commitment to soft, realistic results have earned her a loyal clientele. Consultations are available and recommended before booking.",
    instagram: "bladeandink",
    bookingUrl: "https://www.instagram.com/bladeandink",
    bookingLabel: "Book with Francesca"
  },
  {
    name: "Naz Nargesian",
    title: "Certified Permanent Makeup Artist",
    image: nazImg,
    bio: "Naz Nargesian is a certified Permanent Makeup (PMU) artist specializing in natural-looking brows and advanced brow techniques including Microblading, Nano Brows, and Combination Brows. With a strong focus on precision, facial harmony, and personalized design, she is dedicated to enhancing each client's natural beauty while maintaining the highest standards of safety and hygiene. She holds a Master Assistant certification from Phi Academy Europe and a Master certification from Beauty Angels Academy USA. In addition to providing professional PMU services, Naz is also an experienced trainer, offering specialized education in permanent makeup techniques. Naz studied at a Medical Science University, giving her a strong foundation in health, sanitation, and clinical hygiene standards. This medical-based background allows her to combine beauty expertise with strict safety and hygiene protocols, ensuring safe, precise, and high-quality results for every client.",
    instagram: null
  }
];

const TESTIMONIALS = [
  {
    name: "Elana Nayvelt",
    text: "Kozeta Salon is by far the best hair salon in Toronto. Kozeta and her staff are not only wonderful people to be around but they are magicians with hair. She literally brought my hair back from the dead. Kozeta also did my wedding and was spectacular. Her skills and integrity make her worth every penny you spend here and more. Love this place!!"
  },
  {
    name: "Michelle D",
    text: "Kozeta salon is the absolute best. I've been getting my hair done by Kozeta for years and each time I love everything about it. She really listens to you and is also amazing at giving you a cut that suits you and brings out your features. She's the best - and so is the rest of the team! I've done spa services too and all are excellent. Highly recommend this salon!!!"
  },
  {
    name: "Liliana Mor",
    text: "Visited Kozeta Salon for Spa services with Kayla before my wedding. I treated myself to the signature facial, full set of lash extensions and brow shaping. Amazing experience from beginning to end, Kayla is very experienced, and professional and ensures she explains every step of the process for each service. I left feeling fantastic and ready for my wedding day, will definitely return very soon, highly recommended!"
  },
  {
    name: "Sarah Thompson",
    text: "I have been coming to Kozeta for over 5 years and I wouldn't trust anyone else with my hair. Roya is absolutely incredible - she understands exactly what I want and always delivers perfect results. The salon has such a welcoming atmosphere and the entire team makes you feel like family."
  },
  {
    name: "Jessica Martinez",
    text: "Found Kozeta Salon through a friend's recommendation and I'm so glad I did! Sonia gave me the best balayage I've ever had. The color is so natural and the blend is flawless. The attention to detail here is unmatched. This is now my go-to salon!"
  },
  {
    name: "Amanda Chen",
    text: "I was nervous about trying a new salon but Kozeta herself put me at ease immediately. She listened to what I wanted and gave me the most beautiful highlights. The salon is elegant, clean, and everyone is so professional. Five stars across the board!"
  },
  {
    name: "Rachel Kim",
    text: "Amber did my bridal hair and makeup trial and it was absolutely perfect! She's so talented and patient. She made sure I was 100% happy with the look before my big day. I felt like a princess. Thank you Kozeta Salon for making my wedding day so special!"
  },
  {
    name: "Nicole Brooks",
    text: "I've tried so many salons in Toronto and Kozeta is hands down the best. Lauren is a blonde specialist and she truly lives up to the title. My platinum blonde has never looked better - healthy, shiny, and exactly the tone I wanted. Worth every penny!"
  },
  {
    name: "Emily Watson",
    text: "The spa services here are incredible. I had the signature facial and it was the most relaxing experience. My skin has never looked better. The estheticians are so knowledgeable and use amazing products. I'm already booked for my next appointment!"
  },
  {
    name: "Stephanie Lee",
    text: "I've been going to Kozeta Salon for my keratin treatments for 3 years now. Asma is amazing - she takes such care with my hair and the results last for months. The salon is beautiful and everyone is so friendly. Highly recommend!"
  },
  {
    name: "Megan Roberts",
    text: "Just had the best haircut of my life! Zana understood exactly what I was going for and delivered beyond my expectations. She's so experienced and gives great advice. The whole experience from booking to checkout was seamless."
  },
  {
    name: "Daniela Rossi",
    text: "Kozeta Salon is my happy place! The ambiance is so relaxing and every visit feels like a mini spa day. Roya always makes my hair look like I just stepped out of a magazine. I wouldn't go anywhere else. Love this salon!"
  },
  {
    name: "Christina Patel",
    text: "I came in for a color correction after a bad experience at another salon. Kozeta fixed everything and made my hair look even better than before! She's a true artist. The team here really cares about their clients and it shows."
  },
  {
    name: "Victoria Adams",
    text: "Five stars isn't enough! Kayla did my lash extensions and they look so natural and beautiful. She's incredibly skilled and takes her time to make sure everything is perfect. I get compliments everywhere I go now!"
  },
  {
    name: "Alexandra Moore",
    text: "I've been to many high-end salons but Kozeta Salon is in a league of its own. The level of expertise and customer service is exceptional. Lauren did my highlights and they are absolutely stunning. This salon is worth the drive from anywhere!"
  },
  {
    name: "Natalie Wong",
    text: "The brow lamination I got here changed my life! My brows have never looked so full and defined. The esthetician was so professional and explained everything she was doing. I'm obsessed with my new look. Thank you Kozeta Salon!"
  },
  {
    name: "Jennifer Taylor",
    text: "Kozeta did my hair for my daughter's wedding and I received so many compliments! She's an artist who truly cares about making you look and feel beautiful. The entire team is wonderful and the salon has such a luxurious feel."
  },
  {
    name: "Samantha Green",
    text: "First time here and I'm already a loyal customer! Armando gave me the best haircut I've ever had. He really listened to what I wanted and gave excellent styling tips. The atmosphere is so welcoming and chic. Love it!"
  },
  {
    name: "Diana Hoffman",
    text: "I was looking for a salon that could handle my curly hair and found Kozeta. Doni is a curly hair specialist and he did an amazing job! My curls have never looked so defined and healthy. Finally found my forever salon!"
  },
  {
    name: "Lauren Mitchell",
    text: "The Shiatsu massage with Kana was absolutely incredible! She has such healing hands and I left feeling completely relaxed and rejuvenated. Combined with the beautiful salon atmosphere, it was the perfect self-care day. Highly recommend!"
  },
  {
    name: "Olivia Carter",
    text: "Francesca did my microblading and the results are stunning! She took her time during the consultation to understand exactly what I wanted. The whole process was comfortable and the results look so natural. Best decision I ever made!"
  }
];

function TestimonialsCarousel() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [snapCount, setSnapCount] = useState(0);
  
  const [emblaRef, emblaApi] = useEmblaCarousel(
    { 
      loop: true,
      align: "start",
      slidesToScroll: 1,
      containScroll: "trimSnaps",
      dragFree: true
    },
    [Autoplay({ delay: 3500, stopOnInteraction: false, stopOnMouseEnter: true })]
  );

  const onSelect = useCallback(() => {
    if (!emblaApi) return;
    setSelectedIndex(emblaApi.selectedScrollSnap());
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    const snaps = emblaApi.scrollSnapList();
    setSnapCount(snaps.length);
    emblaApi.on('select', onSelect);
    emblaApi.on('reInit', () => setSnapCount(emblaApi.scrollSnapList().length));
    onSelect();
    return () => {
      emblaApi.off('select', onSelect);
      emblaApi.off('reInit', () => {});
    };
  }, [emblaApi, onSelect]);

  const scrollTo = useCallback((index: number) => {
    if (emblaApi) emblaApi.scrollTo(index);
  }, [emblaApi]);

  return (
    <section id="testimonials" className="mb-16">
      <div className="text-center mb-10">
        <div className="flex items-center justify-center gap-2 mb-3">
          <div className="flex gap-0.5">
            {[1, 2, 3, 4, 5].map((star) => (
              <Star key={star} className="w-5 h-5 fill-primary text-primary" />
            ))}
          </div>
          <span className="text-sm text-muted-foreground">4.8 stars on Google</span>
        </div>
        <h2 className="font-serif text-3xl md:text-4xl font-light text-foreground mb-2">
          What Our Clients Say
        </h2>
        <p className="text-muted-foreground">114+ reviews from happy clients</p>
      </div>

      <div className="relative">
        <div 
          className="overflow-hidden" 
          ref={emblaRef}
          style={{ cursor: 'grab' }}
        >
          <div 
            className="flex gap-4 transition-transform duration-500 ease-out"
          >
            {TESTIMONIALS.map((testimonial, index) => (
              <div 
                key={index} 
                className="flex-shrink-0 w-full sm:w-1/2 lg:w-1/3 min-w-0"
              >
                <Card className="p-6 h-full" data-testid={`testimonial-card-${index}`}>
                  <div className="flex gap-1 mb-3">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star key={star} className="w-4 h-4 fill-primary text-primary" />
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">
                    "{testimonial.text}"
                  </p>
                  <p className="text-sm font-medium text-foreground">
                    - {testimonial.name}
                  </p>
                </Card>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 mt-6" data-testid="testimonials-dots">
          {snapCount > 0 && Array.from({ length: snapCount }).map((_, index) => (
            <button
              key={index}
              onClick={() => scrollTo(index)}
              className={`h-2 rounded-full transition-all duration-300 ${
                selectedIndex === index
                  ? 'bg-primary w-6'
                  : 'bg-muted-foreground/30 hover:bg-muted-foreground/50 w-2'
              }`}
              data-testid={`testimonials-dot-${index}`}
              aria-label={`Go to testimonial ${index + 1}`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

type ViewState = "home" | "auth" | "portal";


const ROTATING_PHRASES = [
  "Where Beauty Meets Artistry",
  "Your Style, Elevated",
  "Earn Points With Every Visit",
  "Luxury Hair & Spa Experience",
  "Personalized Just For You",
  "Award-Winning Stylists",
];

function RotatingPhrases() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsVisible(false);
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % ROTATING_PHRASES.length);
        setIsVisible(true);
      }, 400);
    }, 3500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="h-6 flex items-center overflow-hidden">
      <span
        className={`font-serif text-sm italic text-muted-foreground transition-all duration-500 ${
          isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
        }`}
      >
        {ROTATING_PHRASES[currentIndex]}
      </span>
    </div>
  );
}

export default function Home() {
  const [viewState, setViewState] = useState<ViewState>("home");
  const [clientSession, setClientSession] = useState<ClientSession | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [portalInitialMessage, setPortalInitialMessage] = useState<string | undefined>(undefined);
  const [chatInputValue, setChatInputValue] = useState("");
  const [isChatBarExpanded, setIsChatBarExpanded] = useState(false);
  const [expandedTeamCards, setExpandedTeamCards] = useState<Set<string>>(new Set());

  const heroVideoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = heroVideoRef.current;
    if (!video) return;
    video.muted = true;
    video.play().catch(() => {});
  }, []);

  const HAIR_QUOTES = [
    "Great hair doesn't happen by chance — it happens by appointment.",
    "Your hair is the crown you never take off.",
    "Life is too short for ordinary hair.",
    "Beautiful hair begins at a world-class salon.",
    "Confidence starts with hair that turns heads.",
  ];
  const [quoteIndex, setQuoteIndex] = useState(0);
  const [quoteVisible, setQuoteVisible] = useState(true);

  useEffect(() => {
    const cycle = setInterval(() => {
      setQuoteVisible(false);
      setTimeout(() => {
        setQuoteIndex(i => (i + 1) % HAIR_QUOTES.length);
        setQuoteVisible(true);
      }, 700);
    }, 4500);
    return () => clearInterval(cycle);
  }, []);

  const toggleTeamCard = (name: string) => {
    setExpandedTeamCards(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const { data: servicesData, isLoading: servicesLoading } = useQuery<any>({
    queryKey: ['/api/services']
  });

  const services = servicesData?.services || [];
  
  // Service category state and filtering
  const [selectedServiceCategory, setSelectedServiceCategory] = useState("all");
  
  const serviceCategories = useMemo((): string[] => {
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
  
  // Filter services by selected category
  const filteredServices = useMemo(() => {
    if (selectedServiceCategory === "all") return services;
    return services.filter((s: any) => s.category === selectedServiceCategory);
  }, [services, selectedServiceCategory]);

  // Fetch profile data for quick actions
  const { data: profileData } = useQuery<ProfileResponse>({
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

  // Restore session from localStorage on mount
  useEffect(() => {
    if (!PORTAL_ENABLED && !LOGIN_ENABLED) return; // login off — nothing to restore
    const storedSessionId = localStorage.getItem('kozeta_session_id');
    const storedClientId = localStorage.getItem('kozeta_client_id');
    const storedSessionToken = localStorage.getItem('kozeta_session_token');
    
    if (storedSessionId && storedClientId) {
      setSessionId(storedSessionId);
      const params = new URLSearchParams({ sessionId: storedSessionId, clientId: storedClientId });
      if (storedSessionToken) params.set('sessionToken', storedSessionToken);
      fetch(`/api/profile?${params.toString()}`)
        .then(res => {
          if (res.ok) return res.json();
          // Only discard the stored session when the server says it's invalid
          // (401/404). Transient failures (503, network) keep the session.
          return Promise.reject(res.status === 401 || res.status === 404 ? 'invalid' : 'transient');
        })
        .then(data => {
          if (data.profile) {
            setClientSession({
              clientId: storedClientId,
              profile: data.profile,
              lastVisit: data.lastVisit,
              products: data.products,
              isLoggedIn: true
            });
          }
        })
        .catch((reason) => {
          if (reason === 'invalid') {
            localStorage.removeItem('kozeta_session_id');
            localStorage.removeItem('kozeta_client_id');
            localStorage.removeItem('kozeta_session_token');
          }
        });
    }
  }, []);

  const [showLoginModal, setShowLoginModal] = useState(false);

  const handleLoginClick = () => {
    setShowLoginModal(true);
  };

  const handleLoginSuccess = (session: ClientSession, newSessionId?: string) => {
    setClientSession(session);
    if (newSessionId) {
      setSessionId(newSessionId);
    }
    setShowLoginModal(false);
    if (!PORTAL_ENABLED) {
      // Portal off but login on — open straight to the read-only profile view.
      setInitialViewMode('profile');
    }
    setViewState("portal");
  };

  const handleCancelAuth = () => {
    setViewState("home");
  };

  const [initialViewMode, setInitialViewMode] = useState<'chat' | 'book' | 'shop' | 'profile' | undefined>(undefined);

  const handleOpenPortal = (messageOrView?: string) => {
    if (messageOrView === 'shop') {
      setInitialViewMode('shop');
      setPortalInitialMessage(undefined);
    } else if (messageOrView === 'book') {
      setInitialViewMode('book');
      setPortalInitialMessage(undefined);
    } else {
      setInitialViewMode(undefined);
      setPortalInitialMessage(messageOrView || undefined);
    }
    setViewState("portal");
  };

  const handleClosePortal = () => {
    setViewState("home");
    setPortalInitialMessage(undefined);
  };

  const handleLogout = async () => {
    const sid = sessionId || localStorage.getItem('kozeta_session_id');
    const token = localStorage.getItem('kozeta_session_token');
    if (sid && token) {
      try {
        await fetch('/api/auth/session', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, sessionToken: token }),
        });
      } catch {
        // Best-effort server logout — proceed regardless
      }
    }
    localStorage.removeItem('kozeta_session_id');
    localStorage.removeItem('kozeta_client_id');
    localStorage.removeItem('kozeta_session_token');
    setClientSession(null);
    setSessionId(undefined);
    setViewState("home");
  };

  const handleChatSubmit = () => {
    if (chatInputValue.trim()) {
      setInitialViewMode(undefined);
      setPortalInitialMessage(chatInputValue.trim());
      setChatInputValue("");
      setViewState("portal");
    }
  };

  // Full-screen portal overlay with animated pattern background
  if (viewState !== "home") {
    return (
      <div className="fixed inset-0 z-50 bg-background">
        {/* Background pattern */}
        <div className="absolute inset-0 opacity-10 pointer-events-none">
          <HeroPattern />
          <div className="absolute inset-0 bg-gradient-to-b from-background via-background/95 to-background" />
        </div>

        {/* Header */}
        <header className="relative z-10 flex items-center justify-between px-4 py-3 border-b border-border bg-background/80 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="text-left">
              <span className="font-serif text-sm font-semibold text-foreground block">
                KOZETA SALON
              </span>
              <span className="font-serif text-[10px] text-muted-foreground tracking-wider">
                AI STYLIST PORTAL
              </span>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {clientSession ? (
              <>
                <span className="text-sm text-foreground font-medium hidden sm:inline">
                  {clientSession.profile.firstName}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleLogout}
                  className="rounded-full"
                  data-testid="button-portal-logout"
                >
                  <X className="w-4 h-4" />
                </Button>
              </>
            ) : viewState === "portal" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLoginClick}
                className="rounded-full gap-2"
                data-testid="button-portal-login"
              >
                <LogIn className="w-4 h-4" />
                <span className="text-sm">Login</span>
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={handleClosePortal}
              className="rounded-full"
              data-testid="button-close-portal"
            >
              <X className="w-4 h-4 mr-1" />
              <span className="hidden sm:inline">Exit</span>
            </Button>
          </div>
        </header>

        {/* Content */}
        <div className="relative z-10 flex-1 overflow-hidden" style={{ height: 'calc(100vh - 57px)' }}>
          {viewState === "auth" ? (
            <div className="h-full overflow-auto">
              <AuthPanel 
                onLoginSuccess={handleLoginSuccess}
                onCancel={handleCancelAuth}
              />
            </div>
          ) : (
            <div className="h-full">
              <PortalCard 
                isOpen={true}
                onClose={handleClosePortal}
                initialMessage={portalInitialMessage}
                initialViewMode={initialViewMode}
                clientSession={clientSession}
                sessionId={sessionId}
                isInline={true}
                onLogout={handleLogout}
                onLogin={handleLoginClick}
                onLoginSuccess={handleLoginSuccess}
              />
            </div>
          )}
        </div>

        <LoginModal
          isOpen={showLoginModal}
          onClose={() => setShowLoginModal(false)}
          onLoginSuccess={handleLoginSuccess}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24">
      {/* Fixed Header */}
      <header className="sticky top-0 z-30 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <RotatingPhrases />
          </div>

          {!PORTAL_ENABLED ? (
            <div className="flex items-center gap-2">
              {LOGIN_ENABLED && (clientSession ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-full gap-2"
                    onClick={() => { setInitialViewMode('profile'); setViewState("portal"); }}
                    data-testid="button-header-profile"
                  >
                    <User className="w-4 h-4" />
                    <span className="text-sm">{clientSession.profile.firstName}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="rounded-full"
                    onClick={handleLogout}
                    data-testid="button-header-logout"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleLoginClick}
                  className="rounded-full gap-2"
                  data-testid="button-header-login"
                >
                  <LogIn className="w-4 h-4" />
                  <span>Login</span>
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={openPhorestBooking}
                className="rounded-full gap-2"
                data-testid="button-header-book"
              >
                <Calendar className="w-4 h-4" />
                <span>Book Now</span>
              </Button>
            </div>
          ) : clientSession ? (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full gap-2"
                onClick={() => setViewState("portal")}
                data-testid="button-header-profile"
              >
                <User className="w-4 h-4" />
                <span className="text-sm">{clientSession.profile.firstName}</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                onClick={handleLogout}
                data-testid="button-header-logout"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleLoginClick}
              className="rounded-full gap-2"
              data-testid="button-header-login"
            >
              <LogIn className="w-4 h-4" />
              <span>Login</span>
            </Button>
          )}
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-8">
        
        {/* Hero Section */}
        <section className="text-center mb-12">
          <div className="inline-block mb-6" data-testid="logo-container">
            <div 
              className="w-32 h-32 mx-auto rounded-full flex items-center justify-center shadow-lg"
              style={{ background: '#000000' }}
            >
              <div className="text-center">
                <span 
                  data-testid="text-logo-title"
                  className="font-serif text-2xl font-bold tracking-wider"
                  style={{ color: '#ffffff' }}
                >
                  KOZETA
                </span>
                <p 
                  className="font-serif text-xs tracking-widest"
                  style={{ color: '#ffffff' }}
                >
                  SALON & SPA
                </p>
              </div>
            </div>
          </div>

          <h1
            data-testid="text-hero-title"
            className="font-serif text-4xl md:text-5xl font-light text-foreground mb-2"
          >
            Luxury Hair Salon & Spa in Toronto
          </h1>
          <h2
            className="font-serif text-xl md:text-2xl font-light text-muted-foreground mb-4"
          >
            16+ Years in the Neighbourhood
          </h2>
          <p 
            data-testid="text-hero-subtitle"
            className="text-lg text-muted-foreground max-w-3xl mx-auto mb-8 leading-relaxed"
          >
            Welcome to Kozeta Salon, your neighborhood's trusted haven for over 16 years, where beauty meets expertise! 
            Led by Kozeta, our passionate owner with over 24 years of mastery in the art of hair.
          </p>

          <div className="flex flex-wrap gap-4 justify-center">
            {!PORTAL_ENABLED ? (
              <Button
                data-testid="button-book-now"
                onClick={openPhorestBooking}
                size="lg"
                className="rounded-full shadow-lg"
              >
                <Calendar className="w-4 h-4 mr-2" />
                Book Now
              </Button>
            ) : (
              <>
                <Button
                  data-testid="button-enter-portal"
                  onClick={() => handleOpenPortal()}
                  size="lg"
                  className="rounded-full shadow-lg"
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  Chat with AI Stylist
                </Button>
                <Button
                  data-testid="button-quick-book"
                  variant="outline"
                  size="lg"
                  onClick={() => handleOpenPortal('book')}
                  className="rounded-full"
                >
                  <Calendar className="w-4 h-4 mr-2" />
                  Book Online
                </Button>
                <Button
                  data-testid="button-shop-now"
                  variant="outline"
                  size="lg"
                  onClick={() => handleOpenPortal('shop')}
                  className="rounded-full"
                >
                  <ShoppingBag className="w-4 h-4 mr-2" />
                  Shop Now
                </Button>
              </>
            )}
          </div>
        </section>

        {/* Hero Pattern — animated scissors & hair strands */}
        <section className="mb-12">
          <div 
            className="rounded-3xl overflow-hidden shadow-2xl relative cursor-pointer group"
            style={{ height: '400px' }}
            onClick={() => PORTAL_ENABLED ? handleOpenPortal('book') : openPhorestBooking()}
          >
            <video
              ref={heroVideoRef}
              data-testid="hero-video"
              autoPlay
              muted
              loop
              playsInline
              disablePictureInPicture
              preload="metadata"
              tabIndex={-1}
              className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105 pointer-events-none select-none"
              src="/hero-bg.mp4"
            />
            
            <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-black/35 to-black/55 group-hover:from-black/35 group-hover:via-black/45 group-hover:to-black/65 transition-all duration-500" />
            
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center text-white px-8 max-w-xl">
                <h3 className="font-serif text-3xl md:text-5xl font-light mb-5 tracking-wide drop-shadow-lg">
                  Experience Luxury
                </h3>
                <div
                  className="mb-5 min-h-[3rem] flex items-center justify-center transition-opacity duration-700"
                  style={{ opacity: quoteVisible ? 1 : 0 }}
                >
                  <p className="font-serif text-base md:text-lg italic text-amber-200 leading-relaxed drop-shadow">
                    &ldquo;{HAIR_QUOTES[quoteIndex]}&rdquo;
                  </p>
                </div>
                <div className="w-16 h-px bg-amber-300/50 mx-auto mb-5" />
                <Button 
                  size="lg" 
                  className="rounded-full bg-amber-500/25 backdrop-blur-sm border border-amber-300/40 text-white hover:bg-amber-500/40"
                >
                  {PORTAL_ENABLED ? (
                    <>
                      <Sparkles className="w-4 h-4 mr-2" />
                      Enter Portal
                    </>
                  ) : (
                    <>
                      <Calendar className="w-4 h-4 mr-2" />
                      Book Now
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* Quick Action Cards for Logged-in Users */}
        {clientSession && profileData && (
          <section className="mb-12">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Loyalty Points */}
              <Card 
                className="hover-elevate cursor-pointer"
                onClick={() => handleOpenPortal()}
                data-testid="card-loyalty"
              >
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                    <Star className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Loyalty Points</p>
                    <p className="text-2xl font-bold text-foreground">
                      {profileData.loyalty?.points || 0}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {profileData.loyalty?.pointsToReward || 300} to next reward
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Last Visit */}
              {profileData.lastVisit && (
                <Card 
                  className="hover-elevate cursor-pointer"
                  onClick={() => handleOpenPortal()}
                  data-testid="card-last-visit"
                >
                  <CardContent className="p-4 flex items-center gap-4">
                    <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center">
                      <History className="w-6 h-6 text-accent-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-muted-foreground">Last Visit</p>
                      <p className="text-sm font-medium text-foreground truncate">
                        {profileData.lastVisit.serviceName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {profileData.lastVisit.date}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Book Now */}
              <Card 
                className="hover-elevate cursor-pointer bg-primary text-primary-foreground"
                onClick={() => handleOpenPortal()}
                data-testid="card-book-now"
              >
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center">
                    <Calendar className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-lg font-semibold">Book Now</p>
                    <p className="text-sm opacity-90">
                      Schedule your next appointment
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </section>
        )}

        {/* Services Section */}
        <section id="services" className="mb-16">
          <div className="text-center mb-10">
            <h2 
              data-testid="heading-services"
              className="font-serif text-3xl md:text-4xl font-light text-foreground mb-3"
            >
              Our Complete Services
            </h2>
            <p 
              data-testid="text-services-subtitle"
              className="text-muted-foreground"
            >
              Hair, Spa, Medical Esthetics & Advanced Venus Treatments - {services.length} services available
            </p>
          </div>

          {/* Category Filter Tabs */}
          <Tabs value={selectedServiceCategory} onValueChange={setSelectedServiceCategory} className="w-full mb-6">
            {/* Mobile: horizontal scroll */}
            <div className="md:hidden overflow-x-auto pb-2">
              <TabsList className="inline-flex w-max gap-1 bg-muted/50 p-1 mx-auto">
                {serviceCategories.map((cat: string) => (
                  <TabsTrigger
                    key={cat}
                    value={cat}
                    className="text-xs capitalize whitespace-nowrap px-3"
                    data-testid={`tab-service-category-${cat}`}
                  >
                    {cat === "all" ? "All Services" : cat}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            {/* Mobile scroll indicator */}
            <div className="flex justify-center mt-2 mb-2 md:hidden">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <ChevronRight className="w-4 h-4 animate-pulse" />
                <span>swipe for more categories</span>
              </div>
            </div>
            {/* Desktop: wrap tabs */}
            <div className="hidden md:flex justify-center pb-2">
              <TabsList className="flex flex-wrap gap-1 bg-muted/50 p-1 h-auto">
                {serviceCategories.map((cat: string) => (
                  <TabsTrigger
                    key={cat}
                    value={cat}
                    className="text-sm capitalize whitespace-nowrap px-4"
                    data-testid={`tab-service-category-desktop-${cat}`}
                  >
                    {cat === "all" ? "All Services" : cat}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </Tabs>

          <div className="relative">
            <div className="overflow-y-auto border rounded-3xl p-6 shadow-inner bg-gradient-to-br from-primary/5 to-accent/10" style={{ maxHeight: '500px' }}>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {servicesLoading ? (
                  Array.from({ length: 9 }).map((_, i) => (
                    <Card key={i} className="animate-pulse rounded-xl">
                      <CardContent className="p-4">
                        <div className="h-4 bg-muted/30 rounded w-2/3 mb-2" />
                        <div className="h-5 bg-muted/30 rounded w-full mb-2" />
                        <div className="h-3 bg-muted/30 rounded w-full" />
                      </CardContent>
                    </Card>
                  ))
                ) : filteredServices.length === 0 ? (
                  <div className="col-span-full text-center py-8 text-muted-foreground">
                    No services available
                  </div>
                ) : (
                  filteredServices.map((service: any) => (
                    <Card
                      key={service.key}
                      data-testid={`card-service-${service.key}`}
                      className="hover-elevate transition-all rounded-xl shadow-sm bg-card/80 backdrop-blur-sm cursor-pointer"
                      onClick={() => PORTAL_ENABLED ? handleOpenPortal('book') : openPhorestBooking()}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between mb-2">
                          <h3 className="font-serif text-lg font-semibold text-foreground flex-1">
                            {service.name}
                          </h3>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium inline-block mb-2">
                          {service.category}
                        </span>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                          <span>{service.duration}</span>
                          <span>-</span>
                          <span className="font-semibold text-foreground">{service.price}</span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                          {service.description}
                        </p>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            </div>
            {/* Scroll indicator */}
            {filteredServices.length > 6 && (
              <div className="flex justify-center mt-3">
                <div className="flex flex-col items-center gap-0.5 text-xs text-muted-foreground">
                  <ChevronDown className="w-4 h-4 animate-bounce" />
                  <span>scroll for more services</span>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Team Section */}
        <section id="team" className="mb-16">
          <div className="text-center mb-10">
            <h2 className="font-serif text-3xl md:text-4xl font-light text-foreground mb-3">
              Meet The Team
            </h2>
            <p className="text-muted-foreground">
              Our talented stylists and spa professionals
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {TEAM_MEMBERS.map((member, index) => {
              const needsPositionAdjustment = index === 0 || index === 6 || index === 8;
              const initials = member.name.split(' ').map(n => n[0]).join('').slice(0, 2);
              
              return (
                <Card key={member.name} className="overflow-hidden hover-elevate transition-all">
                  <div className="h-64 relative">
                    {member.image ? (
                      <img
                        src={member.image}
                        alt={`${member.name}, ${member.title} at Kozeta Salon & Spa`}
                        className="h-full w-full object-cover"
                        style={{ objectPosition: needsPositionAdjustment ? 'center 30%' : 'center' }}
                      />
                    ) : (
                      <div className="absolute inset-0 flex flex-col items-center justify-center px-4 bg-black">
                        <span className="text-xl font-serif font-light text-white tracking-widest text-center">KOZETA</span>
                        <span className="text-sm font-sans font-light text-white/80 tracking-[0.3em] mt-1">SALON & SPA</span>
                      </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                    <div className="absolute bottom-4 left-4 right-4 text-white">
                      <h3 className="font-serif text-xl font-semibold">{member.name}</h3>
                      <p className="text-sm text-white/80">{member.title}</p>
                    </div>
                  </div>
                  <CardContent className="p-4">
                    <p className={`text-sm text-muted-foreground ${expandedTeamCards.has(member.name) ? '' : 'line-clamp-3'}`}>
                      {member.bio}
                    </p>
                    <button 
                      onClick={() => toggleTeamCard(member.name)}
                      className="text-sm text-primary hover:underline mt-2 focus:outline-none"
                      data-testid={`button-expand-bio-${member.name.toLowerCase().replace(/\s+/g, '-')}`}
                    >
                      {expandedTeamCards.has(member.name) ? 'Read less' : 'Read more'}
                    </button>
                    {(member.instagram || member.bookingUrl) && (
                      <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-border/50">
                        {member.instagram && (
                          <a 
                            href={`https://instagram.com/${member.instagram}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors"
                            data-testid={`link-instagram-${member.name.toLowerCase().replace(/\s+/g, '-')}`}
                          >
                            <Instagram className="w-4 h-4" />
                            <span className="font-medium">@{member.instagram}</span>
                          </a>
                        )}
                        {member.bookingUrl && (
                          <a 
                            href={member.bookingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid={`link-book-${member.name.toLowerCase().replace(/\s+/g, '-')}`}
                          >
                            <Button size="sm" variant="default" className="rounded-full">
                              <Calendar className="w-3.5 h-3.5 mr-1.5" />
                              {member.bookingLabel || 'Book Now'}
                            </Button>
                          </a>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>

        {/* Testimonials Carousel */}
        <TestimonialsCarousel />

        {/* Contact Section */}
        <section id="contact" className="mb-16">
          <Card className="p-8 bg-gradient-to-br from-primary/5 to-accent/10">
            <div className="text-center mb-8">
              <h2 className="font-serif text-3xl font-light text-foreground mb-3">
                Visit Us
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
              <div>
                <MapPin className="w-8 h-8 mx-auto mb-3 text-primary" />
                <h3 className="font-semibold mb-2">Address</h3>
                <p className="text-sm text-muted-foreground">
                  573 Eglinton Ave W<br />
                  Toronto, ON M5N 1B5
                </p>
              </div>
              
              <div>
                <Phone className="w-8 h-8 mx-auto mb-3 text-primary" />
                <h3 className="font-semibold mb-2">Phone</h3>
                <a href="tel:4169323131" className="text-sm text-primary hover:underline">
                  (416) 932-3131
                </a>
              </div>
              
              <div>
                <Clock className="w-8 h-8 mx-auto mb-3 text-primary" />
                <h3 className="font-semibold mb-2">Hours</h3>
                <p className="text-sm text-muted-foreground">
                  Tue-Fri: 10am-7pm<br />
                  Sat: 9am-5pm
                </p>
              </div>
            </div>
          </Card>
        </section>
      </div>

      {/* Floating AI Chat Bar - Fixed at bottom */}
      {PORTAL_ENABLED && (
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur-md border-t border-border p-3 safe-area-bottom">
        <div className="max-w-2xl mx-auto">
          {isChatBarExpanded ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <span className="text-sm font-medium">AI Stylist</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsChatBarExpanded(false)}
                  className="rounded-full h-7 w-7"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Ask me about services, styling, or book an appointment..."
                  value={chatInputValue}
                  onChange={(e) => setChatInputValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleChatSubmit()}
                  className="flex-1 rounded-full"
                  data-testid="input-chat-bar"
                />
                <Button
                  onClick={handleChatSubmit}
                  className="rounded-full"
                  size="icon"
                  data-testid="button-send-chat"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full text-xs"
                  onClick={() => handleOpenPortal("I want to book a haircut")}
                >
                  Book a haircut
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full text-xs"
                  onClick={() => handleOpenPortal("Tell me about balayage")}
                >
                  Learn about balayage
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full text-xs"
                  onClick={() => handleOpenPortal("What facials do you offer?")}
                >
                  Spa services
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setIsChatBarExpanded(true)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-card border border-border rounded-full hover-elevate active-elevate-2 transition-all"
              data-testid="button-expand-chat-bar"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                  <MessageCircle className="w-4 h-4 text-primary" />
                </div>
                <span className="text-sm text-muted-foreground">
                  Chat with AI Stylist...
                </span>
              </div>
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>
      )}

      {/* Footer */}
      <footer className="border-t border-border bg-muted/30 mt-8">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div 
                className="w-8 h-8 rounded-full flex items-center justify-center"
                style={{ background: '#000000' }}
              >
                <span className="font-serif text-xs font-bold text-white">K</span>
              </div>
              <span className="font-serif text-sm text-foreground">Kozeta Salon & Spa</span>
            </div>
            
            <div className="flex items-center gap-4">
              <a 
                href="https://instagram.com/kozetasalonspa"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Instagram className="w-5 h-5" />
              </a>
              <a href="tel:4169323131" className="text-muted-foreground hover:text-foreground transition-colors">
                <Phone className="w-5 h-5" />
              </a>
              <a href="mailto:info@kozetasalon.com" className="text-muted-foreground hover:text-foreground transition-colors">
                <Mail className="w-5 h-5" />
              </a>
            </div>
            
            <p className="text-xs text-muted-foreground">
              © 2024 Kozeta Salon & Spa. All rights reserved.
            </p>
          </div>
        </div>
      </footer>

      {(PORTAL_ENABLED || LOGIN_ENABLED) && (
        <LoginModal
          isOpen={showLoginModal}
          onClose={() => setShowLoginModal(false)}
          onLoginSuccess={handleLoginSuccess}
        />
      )}
    </div>
  );
}

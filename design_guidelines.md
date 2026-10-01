# Kozeta Salon Portal - Design Guidelines

## Design Approach

**Reference-Based Luxury Spa/Salon Aesthetic**
- Primary inspiration: High-end salon booking platforms (Glossier, Drybar, luxury spa websites)
- Sophisticated, calming, and elegant visual language
- Circular design motifs throughout (logo container, buttons, gradients)
- Seamless single-page experience with no jarring transitions

## Typography

**Font Stack:**
- Primary: 'Cormorant Garamond' (serif) - elegant headers and feature text
- Secondary: 'Montserrat' (sans-serif) - body text, UI elements, chat interface
- Import via Google Fonts CDN

**Type Scale:**
- Hero Title: text-5xl md:text-7xl, font-light, tracking-wide
- Section Headers: text-3xl md:text-4xl, font-light
- Card Titles: text-xl md:text-2xl, font-normal
- Body Text: text-base md:text-lg, font-light leading-relaxed
- Chat Messages: text-sm md:text-base
- Button Text: text-base md:text-lg, font-medium, letter-spacing wider

## Layout System

**Spacing Primitives:**
- Core units: 4, 8, 12, 16, 24, 32 (p-4, p-8, p-12, p-16, p-24, p-32)
- Section padding: py-16 md:py-24 lg:py-32
- Card padding: p-6 md:p-8
- Chat interface: p-4 md:p-6

**Container Widths:**
- Full hero: w-full min-h-screen
- Portal card: max-w-4xl mx-auto
- Content sections: max-w-6xl mx-auto
- Info cards: grid-cols-1 md:grid-cols-2 lg:grid-cols-3

## Component Library

### Hero Section
- Full viewport height (min-h-screen) with centered content
- Layered circular gradient backgrounds (3-4 overlapping soft circles using radial gradients)
- Kozeta logo in centered circular container (w-32 h-32 md:w-40 md:h-40)
- Hero title and subtitle stacked vertically with generous spacing (space-y-6)
- Large circular primary button (w-64 h-64 rounded-full) with subtle glow effect
- Two secondary action buttons below in horizontal row (space-x-4)

### Portal Card (Sliding Interface)
- Fixed/absolute positioning that slides up from bottom on trigger
- Rounded top corners (rounded-t-3xl), full width on mobile, max-w-4xl on desktop
- Tab bar with two segments: "AI Stylist" and "Book Now"
- Smooth slide-up animation (transform translateY)
- Close button (X) in top-right corner
- Card shadow: large, soft drop shadow

### AI Stylist Tab
- Chat message container: max-height with scroll (max-h-[60vh] overflow-y-auto)
- User messages: aligned right, rounded-2xl, with subtle background
- Assistant messages: aligned left, rounded-2xl, with subtle background
- Message spacing: space-y-4
- Suggested question chips: horizontal scroll row, pill-shaped buttons (rounded-full px-4 py-2)
- Input area: sticky bottom, rounded-full input field with send button integrated

### Phorest Booking Tab
- Embedded iframe container with rounded corners (rounded-lg overflow-hidden)
- Minimum height: min-h-[700px]
- Loading state placeholder with animated shimmer
- Seamless integration styled to match portal aesthetic

### Below-Fold Information Cards
- Three main sections in grid layout
- Each card: rounded-2xl, with generous padding (p-8 md:p-10)
- Section header with decorative icon
- **Popular Services**: Grid of service cards (3 columns on desktop, stack on mobile)
  - Each service card: image placeholder, service name, duration, price, brief description
  - "Book This" button per service
- **Meet the Stylists**: Profile cards with circular headshot placeholders, name, specialty, bio snippet
- **Location & Hours**: Map placeholder, address, hours table, contact button

### Buttons
- Primary Circular (Hero): Large circle (w-64 h-64), centered icon/text, radial gradient
- Primary Standard: rounded-full, px-8 py-4, medium shadow
- Secondary: rounded-full, px-6 py-3, border with subtle fill
- Tab Buttons: Segmented control style, rounded-full on active state
- Chat Send: Circular icon button, positioned absolute right in input

### Cards
- All cards: rounded-2xl with consistent shadow (shadow-lg)
- Hover states: slight lift (transform translateY(-2px)) with shadow increase
- Spacing between cards: gap-6 md:gap-8

## Images

### Hero Section
- **No large hero image** - instead use layered circular gradient backgrounds
- Gradient circles: soft radial gradients in salon color palette, overlapping with blur effects
- Logo: SVG or high-res PNG in circular container

### Below-Fold Sections
- **Service Cards**: Square aspect ratio images (1:1) showing styled hair results, treatments
- **Stylist Profiles**: Circular headshots (1:1 aspect ratio)
- **No location map image** - use Google Maps embed or styled div placeholder

## Animations

**Minimal, Purposeful Motion:**
- Portal card slide-up: 400ms ease-out transform
- Tab switching: 300ms cross-fade opacity transition
- Message appearance: 200ms fade-in with slight slide-up
- Button hover: 200ms subtle scale (1.02) and shadow growth
- NO scroll-triggered animations, NO parallax effects

## Accessibility

- All interactive elements have minimum 44x44px touch targets
- Tab navigation fully keyboard accessible
- Chat interface has proper ARIA labels
- High contrast maintained in all text/background combinations
- Focus states clearly visible with outline rings (ring-2 ring-offset-2)

## Mobile Optimization

- Portal card becomes full-screen on mobile (rounded corners only at top)
- Hero button scales down appropriately (w-48 h-48 on mobile)
- Service grid collapses to single column
- Tab bar remains sticky on mobile
- Chat input area sticky at bottom with safe area insets

## Technical Notes

- Use Heroicons for all UI icons (via CDN)
- Phorest widget loaded via official script/iframe method
- Gradient backgrounds implemented with CSS (multiple radial-gradient layers)
- Portal card state managed with simple show/hide class toggles
- All transitions use CSS for performance
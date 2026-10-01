const TEAM_MEMBERS = [
  {
    name: "Kozeta Izeti",
    title: "Founder & Master Stylist",
    bio: "Kozeta began her journey in beauty at just 17, when hair became more than a hobby — it became her passion. After earning a teaching degree, she moved to Canada 25 years ago and followed her heart into hairstyling. For the past 16 years, she has proudly owned and led Kozeta Salon & Spa, specializing in luxury colour, precision highlighting, seamless extensions, and modern styling. Kozeta has won multiple awards, including a prestigious North American accolade.",
  },
  {
    name: "Zana Tomasovic",
    title: "Master Stylist",
    bio: "Zana brings over 25 years of experience to the beauty industry. Her credentials include advanced training at the esteemed Vidal Sassoon. She is highly skilled in colour correction, dimensional highlights, creative colour, and medium-to-long haircuts. Her years of experience working in Los Angeles have refined her eye for style.",
  },
  {
    name: "Roya Massah",
    title: "Master Stylist & Professional Colorist",
    bio: "Roya is a master stylist with over 2 decades of experience, known for her artistic eye and passion for creating beautiful, natural-looking color. She has completed advanced color and highlight courses with L'Oréal Professionnel, Schwarzkopf Professional, and Goldwell, mastering modern techniques and global color trends.",
  },
  {
    name: "Lauren Shostal",
    title: "Blonde Specialist & Senior Colourist",
    bio: "Known for her exceptional blonde work, Lauren has been in the hair industry for over 17 years. A proud graduate of the Aveda Academy, her expertise includes dimensional brunettes, radiant reds, glowing coppers, and natural highlights ranging from soft sun-kissed hues to bright honey blondes.",
  },
  {
    name: "Armando",
    title: "Senior Stylist",
    bio: "With over 20 years of experience, Armando specializes in both women's and men's haircuts. He previously owned his own salon before joining the team, bringing with him a wealth of expertise and a strong commitment to his craft.",
  },
  {
    name: "Asma Yousifi",
    title: "Intermediate Stylist",
    bio: "Asma graduated from Marca College for Hair & Esthetics in 2020 and has continuously expanded her skills since. She specializes in haircuts, hairstyles, hair treatments, colour services, threading, and keratin treatments.",
  },
  {
    name: "Doni",
    title: "Senior Stylist & Makeup Artist",
    bio: "Doni began his career in television in Albania, perfecting hair and makeup under fast-paced environments. His expertise shines in long-hair styling, dimensional colour, precision highlights, makeup artistry, and curly-hair and keratin treatments.",
  },
  {
    name: "Jaclyn Mendoza",
    title: "Senior Esthetician",
    bio: "With over a decade of hands-on experience, Jaclyn is trusted for precision waxing, lash lifts, customized facials, and makeup services. Her advanced esthetics training from George Brown College and leadership experience at top GTA clinics makes her an exceptional esthetician.",
  },
  {
    name: "Kana",
    title: "Shiatsu Massage Therapist",
    bio: "Kana is an exceptional Shiatsu massage therapist trained in Japan, bringing over 20 years of experience. With her intuitive touch and deep understanding of the body, she helps melt away stress and restore balance.",
  },
  {
    name: "Lindsay Orlans, RPN",
    title: "Aesthetic Nurse",
    bio: "Specializing in Botox, fillers, and advanced facial rejuvenation, Lindsay is a skilled aesthetic nurse. She practices under the supervision of a licensed medical doctor, ensuring the highest standards of safety, professionalism, and medical oversight.",
  },
  {
    name: "Francesca Bruni",
    title: "Microblading Eyebrow Specialist",
    bio: "Francesca is a skilled Microblading Eyebrow Specialist known for her precision and natural, beautifully shaped brows. With advanced training and an eye for detail, she customizes each brow to enhance every client's unique features.",
  },
  {
    name: "Naz Nargesian",
    title: "Certified Permanent Makeup Artist",
    bio: "Naz specializes in natural-looking brows with Microblading, Nano Brows, and Combination Brows. She holds a Master Assistant certification from Phi Academy Europe and a Master certification from Beauty Angels Academy USA, with a medical science university background ensuring the highest safety standards.",
  },
];

const TESTIMONIALS = [
  {
    name: "Elana Nayvelt",
    text: "Kozeta Salon is by far the best hair salon in Toronto. Kozeta and her staff are not only wonderful people to be around but they are magicians with hair. She literally brought my hair back from the dead. Kozeta also did my wedding and was spectacular.",
  },
  {
    name: "Michelle D",
    text: "Kozeta salon is the absolute best. I've been getting my hair done by Kozeta for years and each time I love everything about it. She really listens to you and is also amazing at giving you a cut that suits you and brings out your features. Highly recommend!",
  },
  {
    name: "Sarah Thompson",
    text: "I have been coming to Kozeta for over 5 years and I wouldn't trust anyone else with my hair. Roya is absolutely incredible — she understands exactly what I want and always delivers perfect results.",
  },
  {
    name: "Nicole Brooks",
    text: "Lauren is a blonde specialist and she truly lives up to the title. My platinum blonde has never looked better — healthy, shiny, and exactly the tone I wanted.",
  },
  {
    name: "Stephanie Lee",
    text: "I've been going to Kozeta Salon for my keratin treatments for 3 years now. Asma is amazing — she takes such care with my hair and the results last for months.",
  },
  {
    name: "Megan Roberts",
    text: "Just had the best haircut of my life! Zana understood exactly what I was going for and delivered beyond my expectations. The whole experience from booking to checkout was seamless.",
  },
];

const SERVICE_CATEGORIES = [
  { name: "Hair Colour Services", description: "Balayage, highlights, colour correction, full colour, and toning by Toronto's most skilled colourists." },
  { name: "Haircuts & Styling", description: "Precision cuts for women and men, blowouts, special occasion styling, and updos." },
  { name: "Hair Treatments", description: "Keratin smoothing treatments, deep conditioning, Olaplex, and scalp treatments." },
  { name: "Extensions", description: "Seamless tape-in, micro-bead, and clip-in extensions for added length and volume." },
  { name: "Brows & Lashes", description: "Brow lamination, lash lifts, lash tints, brow shaping, and threading." },
  { name: "Waxing & Threading", description: "Full body waxing and precision threading for smooth, lasting results." },
  { name: "Facials & Skin Care", description: "Customized facials, peels, and advanced skin treatments tailored to your skin type." },
  { name: "Massage Therapy", description: "Relaxing and therapeutic Shiatsu massage by a trained Japanese practitioner." },
  { name: "Permanent Makeup", description: "Microblading, Nano Brows, Combination Brows, and other PMU services." },
  { name: "Injectables", description: "Botox and dermal filler services performed by a Registered Practical Nurse under medical supervision." },
  { name: "Makeup", description: "Professional makeup for everyday glam, weddings, and special occasions." },
];

export function buildStaticHomeHtml(): string {
  const teamHtml = TEAM_MEMBERS.map(
    (m) => `<article class="team-member">
  <h3>${m.name}</h3>
  <p class="title">${m.title}</p>
  <p>${m.bio}</p>
</article>`
  ).join("\n");

  const testimonialsHtml = TESTIMONIALS.map(
    (t) => `<blockquote class="testimonial">
  <p>${t.text}</p>
  <footer><cite>${t.name}</cite></footer>
</blockquote>`
  ).join("\n");

  const servicesHtml = SERVICE_CATEGORIES.map(
    (s) => `<div class="service-category">
  <h3>${s.name}</h3>
  <p>${s.description}</p>
</div>`
  ).join("\n");

  return `<div id="ssr-content" aria-hidden="true" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;">
<main>
  <h1>Kozeta Salon &amp; Spa — Luxury Hair &amp; Beauty in Toronto</h1>
  <p>Toronto's destination for luxury hair colour, precision cuts, spa treatments, and AI-powered style recommendations. Located at 573 Eglinton Ave W, Toronto, ON M5N 1B5. Book online or call +1-416-932-3131.</p>

  <section>
    <h2>Our Services</h2>
    ${servicesHtml}
  </section>

  <section>
    <h2>Meet Our Team</h2>
    ${teamHtml}
  </section>

  <section>
    <h2>Client Testimonials</h2>
    ${testimonialsHtml}
  </section>

  <section>
    <h2>Visit Us</h2>
    <address>
      <p>Kozeta Salon &amp; Spa</p>
      <p>573 Eglinton Ave W, Toronto, ON M5N 1B5, Canada</p>
      <p>Phone: <a href="tel:+14169323131">+1-416-932-3131</a></p>
      <p>Email: <a href="mailto:info@kozetasalon.com">info@kozetasalon.com</a></p>
      <p>Hours: Tuesday–Friday 10:00 AM–7:00 PM | Saturday 9:00 AM–5:00 PM</p>
    </address>
    <p><a href="https://phorest.com/book/salons/kozetasalonandspa">Book an appointment online</a></p>
  </section>
</main>
</div>`;
}

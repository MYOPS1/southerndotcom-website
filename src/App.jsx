import PropTypes from 'prop-types';
import { useEffect, useState } from 'react';
import {
  AcceptableUsePage,
  CookiePolicyPage,
  PrivacyPolicyPage,
  RefundCancellationPage,
  TermsOfServicePage,
} from './legalPages';

const companyDetails = {
  brand: 'MYOPS',
  legalEntity: 'Southern Dotcom Enterprise',
  registration: '202303050959 (003472425-X)',
  phone: '012-271 9377',
  phoneHref: 'tel:+60122719377',
  website: 'https://myops.com.my',
  supportEmail: 'southerndotcom8@gmail.com',
};

const products = [
  {
    slug: 'opsp',
    name: 'OpsPS',
    tag: ['Personal Shopper', 'Operations'],
    icon: 'PS',
    accent: 'pink',
    art: 'opsps',
    href: '/solutions/opsp',
    summary: 'Support product, trip, order and customer operations with a streamlined, data-rich workflow.',
  },
  {
    slug: 'opshub',
    name: 'OpsHub',
    tag: ['Business Marketplace', '& Operations'],
    icon: 'HB',
    accent: 'orange',
    art: 'opshub',
    href: 'https://opshub.myops.com.my/',
    summary: 'Grow a digital marketplace and operational network with one connected business layer.',
  },
  {
    slug: 'opsfinance',
    name: 'OpsFinance',
    tag: ['Accounting &', 'Financial Management'],
    icon: 'FX',
    accent: 'purple',
    art: 'opsfinance',
    href: '/solutions/opsfinance',
    summary: 'Keep financial data, cash flow and accountability aligned across your operations.',
  },
  {
    slug: 'opsflow',
    name: 'OpsFlow',
    tag: ['Workflow &', 'Business Automation'],
    icon: 'FL',
    accent: 'blue',
    art: 'opsflow',
    href: '/solutions/opsflow',
    summary: 'Automate processes and handoffs so teams can move faster with less operational noise.',
  },
];

const topNavItems = [
  { label: 'Solutions', href: '/solutions' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'About', href: '/about' },
  { label: 'Resources', href: '/resources' },
  { label: 'FAQ', href: '/faq' },
  { label: 'Contact', href: '/contact' },
];

const digitalDevelopmentScope = [
  'Company Website Development',
  'E-commerce Website',
  'Business Web Application',
  'Customer Portal',
  'Internal Management System',
  'Booking & Appointment System',
  'Business Dashboard',
  'Database & Business Automation',
  'Mobile-Responsive Applications',
  'Custom API & System Integration',
  'Custom Business Software',
];

const faqItems = [
  {
    q: 'What is MYOPS?',
    a: 'MYOPS is a connected business operations ecosystem that helps teams coordinate products, services, workflows and business operations from one operating layer.',
  },
  {
    q: 'Can I explore each solution separately?',
    a: 'Yes. Each MYOPS solution has its own product page and can be explored independently while remaining connected through the wider ecosystem.',
  },
  {
    q: 'Does MYOPS support operating teams in Malaysia?',
    a: 'MYOPS is positioned for businesses operating in the Malaysian market and supports workflow, marketplace and financial operations in a single platform ecosystem.',
  },
  {
    q: 'How do I contact the team?',
    a: 'Use the contact page, email southerndotcom8@gmail.com or call 012-271 9377 for direct support and business enquiries.',
  },
];

const resources = [
  { title: 'Website privacy overview', href: '/privacy', type: 'Policy' },
  { title: 'Terms of service', href: '/terms', type: 'Policy' },
  { title: 'Cookie notice', href: '/cookies', type: 'Policy' },
  { title: 'Refund and cancellation', href: '/refund-cancellation', type: 'Policy' },
  { title: 'Acceptable use policy', href: '/acceptable-use', type: 'Policy' },
  { title: 'PDPA notice', href: '/pdpa', type: 'Policy' },
];

const routes = {
  '/': LandingPage,
  '/solutions': SolutionsPage,
  '/solutions/opsp': SolutionPage,
  '/solutions/opshub': SolutionPage,
  '/solutions/opsfinance': SolutionPage,
  '/solutions/opsflow': SolutionPage,
  '/solutions/business-website-application-development': BusinessWebsiteDevelopmentPage,
  '/services/web-and-business-applications': BusinessWebsiteDevelopmentPage,
  '/pricing': PricingPage,
  '/about': AboutPage,
  '/contact': ContactPage,
  '/faq': FaqPage,
  '/resources': ResourcesPage,
  '/privacy': PrivacyPolicyPage,
  '/terms': TermsOfServicePage,
  '/cookies': CookiePolicyPage,
  '/refund-cancellation': RefundCancellationPage,
  '/acceptable-use': AcceptableUsePage,
  '/pdpa': PDPAPage,
};

const siteBaseUrl = 'https://myops.com.my';

const pageMeta = {
  '/': {
    title: 'MYOPS | Business Operations Software Malaysia',
    description: 'MYOPS brings together business operations software, workflow coordination, and service management tools for modern businesses in Malaysia.',
    ogTitle: 'MYOPS | Business Operations Software Malaysia',
    ogDescription: 'Connected business operations software, service coordination, and management tools for growing businesses in Malaysia.',
  },
  '/solutions': {
    title: 'Solutions | MYOPS',
    description: 'Explore the MYOPS ecosystem of operations, commerce, finance and workflow tools.',
    ogTitle: 'MYOPS Solutions',
    ogDescription: 'Connected operational solutions for commerce, service workflows, finance and business automation.',
  },
  '/solutions/opsp': {
    title: 'OpsPS | MYOPS',
    description: 'OpsPS supports product, trip, order and customer operations in one streamlined operational workflow.',
    ogTitle: 'OpsPS | MYOPS',
    ogDescription: 'Operations support for trips, products, orders and customer coordination.',
  },
  '/solutions/opshub': {
    title: 'OpsHub | MYOPS',
    description: 'OpsHub connects marketplace and business operations so teams can manage growth and transactions effectively.',
    ogTitle: 'OpsHub | MYOPS',
    ogDescription: 'Marketplace and operations management for growing businesses.',
  },
  '/solutions/opsfinance': {
    title: 'OpsFinance | MYOPS',
    description: 'OpsFinance helps organisations bring accounting and financial visibility into their operating workflows.',
    ogTitle: 'OpsFinance | MYOPS',
    ogDescription: 'Financial management and accountability across the operations ecosystem.',
  },
  '/solutions/opsflow': {
    title: 'OpsFlow | MYOPS',
    description: 'OpsFlow automates workflow execution so teams can reduce operational friction and improve speed.',
    ogTitle: 'OpsFlow | MYOPS',
    ogDescription: 'Workflow automation and operational coordination for modern teams.',
  },
  '/solutions/business-website-application-development': {
    title: 'Business Website & Application Development | MYOPS',
    description: 'Southern Dotcom builds professional websites and custom business applications for businesses, including company websites, customer portals, dashboards, internal systems and business automation.',
    ogTitle: 'Business Website & Application Development | MYOPS',
    ogDescription: 'Professional websites and custom business applications from Southern Dotcom.',
  },
  '/services/web-and-business-applications': {
    title: 'Website & Business Application Development | Southern Dotcom',
    description: 'Southern Dotcom builds professional websites and custom business applications for businesses, including company websites, customer portals, dashboards, internal systems and business automation.',
    ogTitle: 'Website & Business Application Development | Southern Dotcom',
    ogDescription: 'Southern Dotcom helps businesses build websites, customer portals, dashboards and integrated digital systems.',
  },
  '/pricing': {
    title: 'Pricing | MYOPS',
    description: 'Review MYOPS product options and operational pricing for growing business ecosystems.',
    ogTitle: 'MYOPS Pricing',
    ogDescription: 'Flexible product choices for business operations, marketplace and workflow management.',
  },
  '/about': {
    title: 'About MYOPS | Southern Dotcom Enterprise',
    description: 'Learn about MYOPS and Southern Dotcom Enterprise, the company behind the MYOPS ecosystem.',
    ogTitle: 'About MYOPS',
    ogDescription: 'MYOPS by Southern Dotcom Enterprise: business operations ecosystem for modern teams.',
  },
  '/contact': {
    title: 'Contact MYOPS',
    description: 'Contact MYOPS for product enquiries, support, and business discussions.',
    ogTitle: 'Contact MYOPS',
    ogDescription: 'Speak with MYOPS for support, product enquiries, and business discussions.',
  },
  '/faq': {
    title: 'FAQ | MYOPS',
    description: 'Find answers to common MYOPS questions about solutions, support and operations.',
    ogTitle: 'MYOPS FAQ',
    ogDescription: 'Frequently asked questions about MYOPS business operations solutions.',
  },
  '/resources': {
    title: 'Resources | MYOPS',
    description: 'Explore MYOPS policies, resources and operational information for businesses and users.',
    ogTitle: 'MYOPS Resources',
    ogDescription: 'Policies, resources and operational information from MYOPS.',
  },
  '/privacy': {
    title: 'MYOPS Privacy Policy',
    description: 'Read the MYOPS privacy policy covering website use, data handling and operational services.',
    ogTitle: 'MYOPS Privacy Policy',
    ogDescription: 'Privacy policy for MYOPS and the business operations ecosystem.',
  },
  '/terms': {
    title: 'MYOPS Terms of Service',
    description: 'Review the MYOPS terms of service for business operations and operational services.',
    ogTitle: 'MYOPS Terms of Service',
    ogDescription: 'Terms of service for MYOPS and the ecosystem of operational solutions.',
  },
  '/cookies': {
    title: 'MYOPS Cookie Policy',
    description: 'Learn how MYOPS uses cookies on its website and related operational systems.',
    ogTitle: 'MYOPS Cookie Policy',
    ogDescription: 'Cookie policy for the MYOPS website and operational ecosystem.',
  },
  '/refund-cancellation': {
    title: 'MYOPS Refund & Cancellation Policy',
    description: 'Review the MYOPS refund and cancellation policy for service requests and support.',
    ogTitle: 'MYOPS Refund & Cancellation Policy',
    ogDescription: 'Refund and cancellation policy for operational services and support arrangements.',
  },
  '/acceptable-use': {
    title: 'MYOPS Acceptable Use Policy',
    description: 'Read the MYOPS acceptable use policy covering responsible use of the platform ecosystem.',
    ogTitle: 'MYOPS Acceptable Use Policy',
    ogDescription: 'MYOPS acceptable use policy for operational platforms and services.',
  },
  '/pdpa': {
    title: 'MYOPS PDPA Notice',
    description: 'Read the MYOPS PDPA notice covering personal data handling for the website and ecosystem.',
    ogTitle: 'MYOPS PDPA Notice',
    ogDescription: 'Personal Data Protection Act notice for MYOPS business operations ecosystem.',
  },
};

function normalizePath(pathname) {
  const filtered = pathname.split('?')[0].split('#')[0];
  const cleaned = filtered === '' ? '/' : filtered.replace(/\/+$/, '') || '/';
  return cleaned;
}

function LogoMark({ compact = false }) {
  return (
    <svg
      viewBox="0 0 120 120"
      className={compact ? 'brand-mark-svg compact' : 'brand-mark-svg'}
      role="img"
      aria-label="MYOPS logo"
    >
      <defs>
        <linearGradient id="myopsBrandGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#EC167A" />
          <stop offset="45%" stopColor="#F0187A" />
          <stop offset="78%" stopColor="#FF8A00" />
          <stop offset="100%" stopColor="#8B3DFF" />
        </linearGradient>
      </defs>
      <path d="M25 92L60 22L95 92H82L60 52L38 92H25Z" fill="url(#myopsBrandGradient)" opacity="0.96" />
      <path d="M18 96L60 15L102 96H86L60 46L34 96H18Z" fill="none" stroke="#071B49" strokeWidth="6" strokeLinejoin="round" opacity="0.9" />
      <path d="M31 84V35H45L60 58L75 35H89V84H75V54L60 79L45 54V84H31Z" fill="#071B49" />
    </svg>
  );
}

LogoMark.propTypes = {
  compact: PropTypes.bool,
};

function updateSeoMeta(pathname) {
  const routeMeta = pageMeta[pathname] || pageMeta['/'];
  const pageUrl = `${siteBaseUrl}${pathname === '/' ? '/' : pathname}`;

  document.title = routeMeta.title;

  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription) {
    metaDescription.setAttribute('content', routeMeta.description);
  }

  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) {
    canonical.setAttribute('href', pageUrl);
  }

  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) {
    ogUrl.setAttribute('content', pageUrl);
  }

  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    ogTitle.setAttribute('content', routeMeta.ogTitle);
  }

  const ogDescription = document.querySelector('meta[property="og:description"]');
  if (ogDescription) {
    ogDescription.setAttribute('content', routeMeta.ogDescription);
  }
}

function SiteHeader() {
  return (
    <header className="topbar">
      <div className="container nav">
        <a href="/" className="brand" aria-label="MYOPS home">
          <span className="brand-mark">
            <LogoMark compact />
          </span>
          <span className="brand-wordmark">MYOPS</span>
        </a>

        <nav className="nav-links" aria-label="Main navigation">
          {topNavItems.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div className="footer-brand-block">
          <a href="/" className="brand" aria-label="MYOPS home">
            <span className="brand-mark">
              <LogoMark compact />
            </span>
            <span className="brand-wordmark">MYOPS</span>
          </a>
          <p>
            MYOPS brings together operations, marketplace, finance and workflow capabilities into one business technology ecosystem.
          </p>
          <div className="footer-contact-list">
            <a href={`mailto:${companyDetails.supportEmail}`}>{companyDetails.supportEmail}</a>
            <a href={companyDetails.phoneHref}>{companyDetails.phone}</a>
            <a href={companyDetails.website}>{companyDetails.website.replace('https://', '')}</a>
          </div>
        </div>

        <div className="footer-column">
          <h3>Solutions</h3>
          <a href="/solutions">Overview</a>
          <a href="/solutions/opsp">OpsPS</a>
          <a href="/solutions/opshub">OpsHub</a>
          <a href="/solutions/opsfinance">OpsFinance</a>
          <a href="/solutions/opsflow">OpsFlow</a>
        </div>

        <div className="footer-column">
          <h3>Company</h3>
          <a href="/about">About</a>
          <a href="/pricing">Pricing</a>
          <a href="/resources">Resources</a>
          <a href="/contact">Contact</a>
        </div>

        <div className="footer-column">
          <h3>Legal</h3>
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms</a>
          <a href="/cookies">Cookies</a>
          <a href="/refund-cancellation">Refund &amp; Cancellation</a>
          <a href="/acceptable-use">Acceptable Use</a>
          <a href="/pdpa">PDPA</a>
        </div>
      </div>

      <div className="container footer-bottom">
        <span>{companyDetails.legalEntity}</span>
        <span>Registration No. {companyDetails.registration}</span>
        <span>© 2026 MYOPS</span>
      </div>
    </footer>
  );
}

function PageShell({ children, pageClass = '' }) {
  return (
    <div className={`page-shell ${pageClass}`}>
      <SiteHeader />
      <main>{children}</main>
      <SiteFooter />
    </div>
  );
}

PageShell.propTypes = {
  children: PropTypes.node.isRequired,
  pageClass: PropTypes.string,
};

function SectionIntro({ label, title, text }) {
  return (
    <div className="section-intro">
      <span className="eyebrow">{label}</span>
      <h2>{title}</h2>
      {text ? <p>{text}</p> : null}
    </div>
  );
}

SectionIntro.propTypes = {
  label: PropTypes.string.isRequired,
  title: PropTypes.string.isRequired,
  text: PropTypes.string,
};

function LandingPage() {
  return (
    <PageShell pageClass="landing-shell">
      <section className="hero">
        <div className="hero-assembly container">
          <div className="hero-content-layer">
            <a href="/" className="hero-logo" aria-label="MYOPS home">
              <img src="/images/myops-logo-wordmark.png" alt="MYOPS" width="397" height="102" />
            </a>
            <h1>
              Digital Solutions
              <br />
              for the Way
              <br />
              You Work
            </h1>
            <p>
              Practical business technology to help you manage, sell, operate and grow — all in one ecosystem.
            </p>
            <div className="hero-actions">
              <a href="/solutions" className="btn btn-primary hero-cta">
                Explore Solutions <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>

          <div className="hero-scene" aria-label="MYOPS platform overview">
            <img
              src="/images/myops-hero-bg.webp"
              alt="Two MYOPS characters looking at a laptop in front of the MYOPS orders dashboard"
              width="1536"
              height="617"
            />
          </div>
        </div>
      </section>

      <section className="trust-band">
        <div className="container trust-grid">
          <div>
            <strong>One ecosystem</strong>
            <span>Operations, commerce, finance and workflows connected.</span>
          </div>
          <div>
            <strong>Modern operations</strong>
            <span>Built for growing businesses that need clarity and speed.</span>
          </div>
          <div>
            <strong>Simple support</strong>
            <span>Contact the team through phone, email or the contact page.</span>
          </div>
        </div>
      </section>

      <section className="content-section">
        <div className="container">
          <SectionIntro
            label="Solutions"
            title="Built for the way modern teams operate"
            text="MYOPS connects business systems so product, service, financial and operational teams can act in one shared operating layer."
          />

          <div className="product-grid">
            {products.map((product) => (
              <article className={`product-card ${product.accent}`} key={product.name}>
                <div className="product-art">
                  <img
                    src={`/images/${product.art}-card-art.png`}
                    alt={`${product.name} illustration`}
                    width="380"
                    height="248"
                  />
                </div>
                <img className="product-badge" src={`/images/${product.art}-card-badge.png`} alt="" width="88" height="88" />
                <h3>{product.name}</h3>
                <p className="product-tagline">
                  {product.tag.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </p>
                <p className="product-desc">
                  {product.summary}
                </p>
                <a href={product.href} className="card-link" aria-label={product.name}>
                  <span aria-hidden="true">→</span>
                </a>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="content-section alt-panel">
        <div className="container two-column">
          <div>
            <SectionIntro
              label="Ecosystem"
              title="A connected operating layer for every business function"
              text="MYOPS helps teams work from one common operational core without losing the specialisation of each product line."
            />
          </div>
          <div className="feature-stack">
            <div className="feature-card">
              <span>01</span>
              <h3>Market visibility</h3>
              <p>Manage product, marketplace and customer touchpoints with operational clarity.</p>
            </div>
            <div className="feature-card">
              <span>02</span>
              <h3>Workflow control</h3>
              <p>Reduce task friction and keep operational handoffs moving.</p>
            </div>
            <div className="feature-card">
              <span>03</span>
              <h3>Financial oversight</h3>
              <p>Bring finance, transactions and decisions into one connected view.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="content-section">
        <div className="container two-column service-showcase">
          <div>
            <SectionIntro
              label="Southern Dotcom Service"
              title="Website & Business Application Development"
              text="We design and build professional websites and custom business applications tailored to your business needs — from company websites and customer portals to internal management systems and complete digital solutions."
            />
            <div className="inline-actions">
              <a href="/contact" className="btn btn-primary">Get a Quote</a>
              <a href="/contact" className="btn btn-secondary">Discuss Your Project</a>
            </div>
          </div>
          <div className="feature-stack">
            {digitalDevelopmentScope.map((item, index) => (
              <div className="feature-card" key={item}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <h3>{item}</h3>
                <p>Practical digital support built around the way your business operates.</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="content-section">
        <div className="container pricing-teaser">
          <div>
            <SectionIntro
              label="Business-ready"
              title="Choose the right MYOPS path for your operations"
              text="Whether you are streamlining order operations, marketplace activity or finance and workflow coordination, MYOPS is designed to scale with your business."
            />
          </div>
          <div className="cta-panel">
            <a href="/pricing" className="btn btn-primary">Review pricing</a>
            <a href="/contact" className="btn btn-secondary">Talk to the team</a>
          </div>
        </div>
      </section>

      <section className="content-section alt-panel">
        <div className="container company-summary-grid">
          <div>
            <SectionIntro label="About" title="Built by Southern Dotcom Enterprise" text="MYOPS is a business technology ecosystem focused on operational clarity and execution for modern teams." />
          </div>
          <div className="company-details">
            <p><strong>Legal entity:</strong> {companyDetails.legalEntity}</p>
            <p><strong>Registration:</strong> {companyDetails.registration}</p>
            <p><strong>Email:</strong> <a href={`mailto:${companyDetails.supportEmail}`}>{companyDetails.supportEmail}</a></p>
            <p><strong>Phone:</strong> <a href={companyDetails.phoneHref}>{companyDetails.phone}</a></p>
            <p><strong>Website:</strong> <a href={companyDetails.website}>{companyDetails.website}</a></p>
          </div>
        </div>
      </section>

      <section className="content-section">
        <div className="container faq-preview">
          <SectionIntro label="FAQ" title="Common questions" />
          <div className="faq-list compact">
            {faqItems.slice(0, 3).map((item) => (
              <details key={item.q} open>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function SolutionsPage() {
  return (
    <PageShell pageClass="page-shell-plain">
      <section className="page-hero">
        <div className="container solutions-showcase">
          <div className="solutions-intro">
            <SectionIntro
              label="Solutions"
              title="A connected ecosystem for modern business operations"
              text="Each MYOPS product supports a distinct operating need while staying connected to the same business layer. Our Southern Dotcom development service complements the MYOPS product suite with bespoke web and application build support."
            />
            <div className="inline-actions">
              <a href="/contact" className="btn btn-primary">Get a Quote</a>
              <a href="/solutions/business-website-application-development" className="btn btn-secondary">Explore Services</a>
            </div>
          </div>

          <div className="solution-tile-grid">
            {products.map((product) => (
              <article className={`solution-tile ${product.accent}`} key={product.name}>
                <div className="solution-tile-head">
                  <span className="solution-pill">{product.name}</span>
                  <span className="solution-symbol">{product.icon}</span>
                </div>
                <h3>{product.name}</h3>
                <p>{product.summary}</p>
                <a href={product.href} className="text-link">Learn more →</a>
              </article>
            ))}
            <article className="solution-tile service-tile">
              <div className="solution-tile-head">
                <span className="solution-pill">Southern Dotcom</span>
                <span className="solution-symbol">SD</span>
              </div>
              <h3>Website &amp; Business Application Development</h3>
              <p>Custom websites, customer portals, internal systems and business applications built for the way your business operates.</p>
              <a href="/solutions/business-website-application-development" className="text-link">Learn more →</a>
            </article>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function ProductDetailPage({ name, accent, summary, bullets, ctaLabel, ctaHref }) {
  return (
    <PageShell pageClass="page-shell-plain">
      <section className="page-hero">
        <div className="container product-detail-wrap">
          <div className="detail-copy">
            <span className="eyebrow">{name}</span>
            <h1>{name}</h1>
            <p>{summary}</p>
            <div className="inline-actions">
              <a href={ctaHref} className="btn btn-primary">{ctaLabel}</a>
              <a href="/solutions" className="btn btn-secondary">Back to solutions</a>
            </div>
          </div>
          <div className="detail-panel">
            <div className={`product-mini ${accent}`}>
              <span className="mini-icon">{name.slice(0, 2).toUpperCase()}</span>
            </div>
            <ul>
              {bullets.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

ProductDetailPage.propTypes = {
  name: PropTypes.string.isRequired,
  accent: PropTypes.string.isRequired,
  summary: PropTypes.string.isRequired,
  bullets: PropTypes.arrayOf(PropTypes.string).isRequired,
  ctaLabel: PropTypes.string.isRequired,
  ctaHref: PropTypes.string.isRequired,
};

function SolutionPage({ route }) {
  const product = products.find((item) => item.href === route || item.slug === route.replace('/solutions/', '')) || products[0];

  const solutionMeta = {
    opsp: {
      name: 'OpsPS',
      accent: 'pink',
      summary: 'OpsPS supports product, trip, order and customer operations with clear operational execution and service coordination.',
      bullets: ['Orders and product coordination', 'Customer and trip workflow visibility', 'Service operations oversight', 'Operational reporting and simple follow-up'],
      ctaLabel: 'Contact OpsPS',
      ctaHref: '/contact',
    },
    opshub: {
      name: 'OpsHub',
      accent: 'orange',
      summary: 'OpsHub helps businesses run a connected marketplace and operational layer for growth, transactions and collaboration.',
      bullets: ['Marketplace management', 'Business listing and coordination', 'Partner and service visibility', 'Operational coordination for growth'],
      ctaLabel: 'Visit OpsHub',
      ctaHref: 'https://opshub.myops.com.my/',
    },
    opsfinance: {
      name: 'OpsFinance',
      accent: 'purple',
      summary: 'OpsFinance helps teams bring financial clarity into day-to-day business operations and accountability.',
      bullets: ['Accounting and financial visibility', 'Expense and control tracking', 'Operational accountability', 'Reporting aligned to business activity'],
      ctaLabel: 'Talk to finance',
      ctaHref: '/contact',
    },
    opsflow: {
      name: 'OpsFlow',
      accent: 'blue',
      summary: 'OpsFlow helps teams automate handoffs, operational follow-up and recurring work so execution stays organised.',
      bullets: ['Workflow automation', 'Task coordination', 'Operational handoff visibility', 'Process consistency across teams'],
      ctaLabel: 'Discuss OpsFlow',
      ctaHref: '/contact',
    },
  };

  const current = solutionMeta[product.slug] || solutionMeta.opsp;
  return <ProductDetailPage {...current} />;
}

SolutionPage.propTypes = {
  route: PropTypes.string.isRequired,
};

function BusinessWebsiteDevelopmentPage() {
  return (
    <PageShell pageClass="page-shell-plain">
      <section className="page-hero">
        <div className="container service-showcase-grid">
          <div className="service-intro">
            <SectionIntro
              label="Southern Dotcom Service"
              title="Website & Business Application Development"
              text="We design and build professional websites and custom business applications tailored to your business needs — from company websites and customer portals to internal management systems and complete digital solutions."
            />
            <div className="inline-actions">
              <a href="/contact" className="btn btn-primary">Get a Quote</a>
              <a href="/contact" className="btn btn-secondary">Discuss Your Project</a>
            </div>
          </div>

          <div className="service-tile-grid">
            {digitalDevelopmentScope.map((item, index) => (
              <article className="service-tile" key={item}>
                <div className="solution-tile-head">
                  <span className="solution-pill">Scope</span>
                  <span className="solution-symbol">0{index + 1}</span>
                </div>
                <h3>{item}</h3>
                <p>Business-focused delivery designed for practical operational outcomes.</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </PageShell>
  );
}

const routePageMap = {
  '/solutions/opsp': () => <SolutionPage route="/solutions/opsp" />,
  '/solutions/opshub': () => <SolutionPage route="/solutions/opshub" />,
  '/solutions/opsfinance': () => <SolutionPage route="/solutions/opsfinance" />,
  '/solutions/opsflow': () => <SolutionPage route="/solutions/opsflow" />,
  '/solutions/business-website-application-development': () => <BusinessWebsiteDevelopmentPage />,
  '/services/web-and-business-applications': () => <BusinessWebsiteDevelopmentPage />,
};

function PricingPage() {
  return (
    <PageShell pageClass="page-shell-plain">
      <section className="page-hero">
        <div className="container narrow-content">
          <SectionIntro label="Pricing" title="Simple product access for modern operations" text="MYOPS pricing is structured around product access and business needs. OpsFinance is currently listed at RM29/month/company with a 7-day free trial. Custom development services are quoted separately based on project scope." />
          <div className="pricing-grid">
            <article className="pricing-card highlight">
              <span className="pricing-tag">OpsFinance</span>
              <h3>Accounting &amp; Financial Management</h3>
              <div className="price-line">
                <strong>RM29</strong>
                <span>/month/company</span>
              </div>
              <ul>
                <li>7-day free trial</li>
                <li>Core accounting and operational visibility</li>
                <li>Business financial coordination</li>
              </ul>
              <a href="/contact" className="btn btn-primary">Talk to Us</a>
            </article>
            <article className="pricing-card">
              <span className="pricing-tag">MYOPS</span>
              <h3>Product ecosystem</h3>
              <div className="price-line">
                <strong>Custom</strong>
                <span>pricing</span>
              </div>
              <ul>
                <li>Multi-solution access</li>
                <li>Business coordination and workflows</li>
                <li>Tailored setup guidance</li>
              </ul>
              <a href="/contact" className="btn btn-secondary">Request quote</a>
            </article>
            <article className="pricing-card">
              <span className="pricing-tag">Services</span>
              <h3>Website &amp; application solutions</h3>
              <div className="price-line">
                <strong>Custom</strong>
                <span>quote</span>
              </div>
              <ul>
                <li>Website design and build</li>
                <li>Business applications and integration</li>
                <li>Project scoping and consultation</li>
              </ul>
              <a href="/contact" className="btn btn-primary">Get a Quote</a>
            </article>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function AboutPage() {
  return (
    <PageShell pageClass="page-shell-plain">
      <section className="page-hero">
        <div className="container narrow-content">
          <SectionIntro label="About" title="Southern Dotcom Enterprise and the MYOPS ecosystem" text="MYOPS is a connected business operations ecosystem built to help modern organisations coordinate key operational functions with clarity." />
          <div className="about-grid">
            <div className="info-plain">
              <p>
                MYOPS brings together marketplace, operations, workflow and finance capabilities in one professional business ecosystem.
              </p>
              <p>
                The company behind the ecosystem is Southern Dotcom Enterprise, registered as 202303050959 (003472425-X).
              </p>
            </div>
            <div className="info-plain">
              <p><strong>Brand:</strong> MYOPS</p>
              <p><strong>Company:</strong> Southern Dotcom Enterprise</p>
              <p><strong>Registration:</strong> 202303050959 (003472425-X)</p>
              <p><strong>Email:</strong> <a href={`mailto:${companyDetails.supportEmail}`}>{companyDetails.supportEmail}</a></p>
              <p><strong>Phone:</strong> <a href={companyDetails.phoneHref}>{companyDetails.phone}</a></p>
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function ContactPage() {
  return (
    <PageShell pageClass="page-shell-plain">
      <section className="page-hero">
        <div className="container narrow-content">
          <SectionIntro label="Contact" title="Speak with the MYOPS team" text="Use the details below for product enquiries, support and project discussions." />
          <div className="contact-panel">
            <div className="contact-card">
              <h3>Email</h3>
              <a href={`mailto:${companyDetails.supportEmail}`}>{companyDetails.supportEmail}</a>
            </div>
            <div className="contact-card">
              <h3>Phone / WhatsApp</h3>
              <a href={companyDetails.phoneHref}>{companyDetails.phone}</a>
            </div>
            <div className="contact-card">
              <h3>Website</h3>
              <a href={companyDetails.website}>{companyDetails.website}</a>
            </div>
          </div>
          <form className="contact-form" action={`mailto:${companyDetails.supportEmail}`} method="post" encType="text/plain">
            <label>
              Name
              <input type="text" name="name" placeholder="Your name" required />
            </label>
            <label>
              Company
              <input type="text" name="company" placeholder="Business name" />
            </label>
            <label>
              Email
              <input type="email" name="email" placeholder="name@example.com" required />
            </label>
            <label>
              Phone
              <input type="tel" name="phone" placeholder="012-271 9377" />
            </label>
            <label>
              What do you need?
              <select name="interest" defaultValue="">
                <option value="" disabled>Select an option</option>
                <option value="MYOPS Product">MYOPS Product</option>
                <option value="Business Website">Business Website</option>
                <option value="Business Application">Business Application</option>
                <option value="Mobile Application">Mobile Application</option>
                <option value="Business System">Business System</option>
                <option value="Integration">Integration</option>
                <option value="Other">Other</option>
              </select>
            </label>
            <label>
              Message
              <textarea name="message" rows="5" placeholder="Tell us what your business needs." required />
            </label>
            <button type="submit" className="btn btn-primary">Send enquiry</button>
          </form>
        </div>
      </section>
    </PageShell>
  );
}

function FaqPage() {
  return (
    <PageShell pageClass="page-shell-plain">
      <section className="page-hero">
        <div className="container narrow-content">
          <SectionIntro label="FAQ" title="Frequently asked questions" text="Answers to common questions about MYOPS, our solutions and support paths." />
          <div className="faq-list">
            {faqItems.map((item) => (
              <details key={item.q} open>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function ResourcesPage() {
  return (
    <PageShell pageClass="page-shell-plain">
      <section className="page-hero">
        <div className="container narrow-content">
          <SectionIntro label="Resources" title="MYOPS information and policies" text="Useful product and legal resources for businesses, partners and users operating within the MYOPS ecosystem." />
          <div className="cards-grid resource-grid">
            {resources.map((resource) => (
              <article key={resource.href} className="resource-card">
                <span>{resource.type}</span>
                <h3>{resource.title}</h3>
                <a href={resource.href}>Open resource →</a>
              </article>
            ))}
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function PDPAPage() {
  return (
    <PageShell pageClass="page-shell-plain">
      <section className="page-hero">
        <div className="container narrow-content legal-copy">
          <SectionIntro label="PDPA" title="Personal Data Protection Act notice" text="This notice explains how MYOPS and Southern Dotcom Enterprise handle personal data in support of our website and business operations ecosystem." />
          <div className="legal-body">
            <p>MYOPS is operated by Southern Dotcom Enterprise and may process personal data in connection with website access, service enquiries, customer communications, and business support requests.</p>
            <p>Personal data may include contact details, communications records, operational information and technical information required to deliver the website and connected services.</p>
            <p>We process personal data for legitimate business purposes such as service delivery, support administration, security, website operations and compliance with applicable legal obligations.</p>
            <p>We retain personal data only as long as necessary to fulfil the purpose for which it was collected and to comply with relevant legal and business record requirements.</p>
            <p>If you have concerns about your personal data or want to understand how your information is handled, contact southerndotcom8@gmail.com or call 012-271 9377.</p>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

export default function App() {
  const [pathname, setPathname] = useState(() => {
    if (typeof window === 'undefined') {
      return '/';
    }
    return normalizePath(window.location.pathname);
  });

  useEffect(() => {
    const handleLocationChange = () => {
      setPathname(normalizePath(window.location.pathname));
    };

    window.addEventListener('popstate', handleLocationChange);
    return () => window.removeEventListener('popstate', handleLocationChange);
  }, []);

  useEffect(() => {
    updateSeoMeta(pathname);
  }, [pathname]);

  const PageComponent = routes[pathname] || LandingPage;

  if (
    pathname === '/solutions/opsp' ||
    pathname === '/solutions/opshub' ||
    pathname === '/solutions/opsfinance' ||
    pathname === '/solutions/opsflow' ||
    pathname === '/solutions/business-website-application-development' ||
    pathname === '/services/web-and-business-applications'
  ) {
    return routePageMap[pathname] ? routePageMap[pathname]() : <PageComponent />;
  }

  return <PageComponent />;
}

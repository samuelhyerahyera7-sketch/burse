/* Bloom & Box – App JS */

// ── SCROLL: header shadow + sticky CTA
const header    = document.getElementById('site-header');
const stickyCta = document.getElementById('sticky-cta');
let lastScroll  = 0;

window.addEventListener('scroll', () => {
  const y = window.scrollY;
  header.classList.toggle('scrolled', y > 20);

  // show sticky CTA after scrolling past hero (600px)
  stickyCta.classList.toggle('visible', y > 600);
  lastScroll = y;
}, { passive: true });

// ── MOBILE NAV TOGGLE
const hamburger = document.getElementById('hamburger');
const navLinks  = document.getElementById('nav-links');

hamburger.addEventListener('click', () => {
  navLinks.classList.toggle('open');
});

// close nav on link click
navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => navLinks.classList.remove('open'));
});

// ── PRICING TOGGLE
const pricingBtns   = document.querySelectorAll('.pricing-btn');
const priceAmounts  = document.querySelectorAll('.price-amount');

pricingBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    pricingBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const period = btn.dataset.period;
    priceAmounts.forEach(el => {
      const val = parseFloat(el.dataset[period]);
      el.textContent = val.toFixed(2);
    });
  });
});

// ── NEWSLETTER FORM
function handleNewsletter(e) {
  e.preventDefault();
  const form  = e.target;
  const input = form.querySelector('input');
  const btn   = form.querySelector('button');
  btn.textContent  = '✓ You\'re in!';
  btn.style.background = '#6b9e7d';
  input.value = '';
  input.placeholder = 'Thanks for joining 🌸';
  setTimeout(() => {
    btn.textContent = 'Subscribe';
    btn.style.background = '';
    input.placeholder = 'Enter your email address';
  }, 4000);
}

// ── SCROLL REVEAL ANIMATION
const revealEls = document.querySelectorAll(
  '.box-card, .step, .product-card, .review-card, .pricing-card, .insta-item'
);

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = entry.target.style.transform
        .replace('translateY(32px)', 'translateY(0)') || '';
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

revealEls.forEach((el, i) => {
  el.style.opacity = '0';
  el.style.transform += ' translateY(32px)';
  el.style.transition = `opacity .5s ease ${i * 0.05}s, transform .5s ease ${i * 0.05}s, box-shadow .25s ease, border-color .25s ease`;
  observer.observe(el);
});

// ── SMOOTH ANCHOR SCROLL (offset for fixed header)
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', e => {
    const target = document.querySelector(anchor.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const offset = header.offsetHeight + 16;
    window.scrollTo({ top: target.offsetTop - offset, behavior: 'smooth' });
  });
});

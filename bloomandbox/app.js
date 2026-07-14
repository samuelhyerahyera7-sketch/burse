/* Bloom & Box – App JS */

const hdr = document.getElementById('hdr');
window.addEventListener('scroll', () => hdr.classList.toggle('raised', window.scrollY > 10), { passive: true });

// Burger menu toggle
const mob = document.getElementById('mob');
const moboverlay = document.getElementById('moboverlay');
function closeMobNav() { document.body.classList.remove('nav-open'); }
if (mob) {
  mob.addEventListener('click', () => document.body.classList.toggle('nav-open'));
}
if (moboverlay) {
  moboverlay.addEventListener('click', closeMobNav);
}
document.querySelectorAll('.mob-nav a').forEach(a => a.addEventListener('click', closeMobNav));

// Filter buttons
document.querySelectorAll('.pf-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.pf-btn').forEach(x => x.classList.remove('act'));
  b.classList.add('act');
}));

// Shop-for tabs
document.querySelectorAll('.sf-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.sf-btn').forEach(x => x.classList.remove('act'));
  b.classList.add('act');
}));

// Newsletter
function nlSub(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const inp = e.target.querySelector('input');
  btn.textContent = 'Subscribed!';
  btn.style.background = '#5e8c72';
  inp.value = '';
  inp.placeholder = 'Thanks — you\'re on the list!';
  setTimeout(() => {
    btn.textContent = 'Subscribe';
    btn.style.background = '';
    inp.placeholder = 'Your email address';
  }, 4000);
}

// Smooth scroll with header offset
document.querySelectorAll('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
  const t = document.querySelector(a.getAttribute('href'));
  if (!t) return;
  e.preventDefault();
  window.scrollTo({ top: t.offsetTop - hdr.offsetHeight - 8, behavior: 'smooth' });
}));

// Scroll reveal
const obs = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.style.opacity = '1';
      e.target.style.transform = 'translateY(0)';
      obs.unobserve(e.target);
    }
  });
}, { threshold: 0.06, rootMargin: '0px 0px -28px 0px' });

document.querySelectorAll('.pcard,.ccard,.tcard,.contact-card,.feat,.ocard').forEach((el, i) => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(20px)';
  el.style.transition = `opacity .4s ease ${i * .04}s, transform .4s ease ${i * .04}s, box-shadow .22s ease`;
  obs.observe(el);
});

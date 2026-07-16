/* Bloom & Box — App JS */

/* ── PRODUCT DATA ── */
const BB_PRODUCTS = [
  { id:1,  name:'Classic Red Rose Bouquet',         cat:'flowers',    catLabel:'Flowers & Roses',    price:249, orig:null, badge:'Best Seller', badgeCls:'b-hot',  img:'pi1'  },
  { id:2,  name:'Luxury Birthday Gift Hamper',       cat:'hampers',    catLabel:'Gift Hampers',       price:649, orig:null, badge:'Best Seller', badgeCls:'b-hot',  img:'pi2'  },
  { id:3,  name:'Lindt Chocolate Luxury Box',        cat:'chocolates', catLabel:'Chocolates',         price:245, orig:349,  badge:'30% Off',     badgeCls:'b-sale', img:'pi3'  },
  { id:4,  name:'Orchid Plant in Ceramic Pot',       cat:'plants',     catLabel:'Plants',             price:399, orig:null, badge:'New',         badgeCls:'b-new',  img:'pi4'  },
  { id:5,  name:'Mixed Seasonal Bouquet',            cat:'flowers',    catLabel:'Flowers & Roses',    price:349, orig:null, badge:'Best Seller', badgeCls:'b-hot',  img:'pi5'  },
  { id:6,  name:'Custom Photo Gift Frame',           cat:'gifts',      catLabel:'Personalised Gifts', price:259, orig:null, badge:null,          badgeCls:'',       img:'pi6'  },
  { id:7,  name:'Premium Red Wine & Roses Set',      cat:'wine',       catLabel:'Alcohol & Wine',     price:799, orig:null, badge:'New',         badgeCls:'b-new',  img:'pi7'  },
  { id:8,  name:'Sunflower & Pink Rose Bouquet',     cat:'flowers',    catLabel:'Flowers & Roses',    price:279, orig:329,  badge:'15% Off',     badgeCls:'b-sale', img:'pi8'  },
  { id:9,  name:'SA Biltong & Snack Crate',          cat:'gourmet',    catLabel:'Gourmet & Snacks',   price:449, orig:null, badge:'Best Seller', badgeCls:'b-hot',  img:'pi9'  },
  { id:10, name:'Pink Protea & Fynbos Arrangement',  cat:'flowers',    catLabel:'Flowers & Roses',    price:499, orig:null, badge:'New',         badgeCls:'b-new',  img:'pi10' },
  { id:11, name:'Craft Beer & Snacks Gift Set',      cat:'gourmet',    catLabel:'Gourmet & Snacks',   price:549, orig:null, badge:null,          badgeCls:'',       img:'pi11' },
  { id:12, name:'Ferrero Rocher Tower Gift Box',     cat:'chocolates', catLabel:'Chocolates',         price:379, orig:429,  badge:'12% Off',     badgeCls:'b-sale', img:'pi12' },
];

/* ── CART (localStorage) ── */
function getCart() {
  try { return JSON.parse(localStorage.getItem('bb_cart') || '[]'); } catch { return []; }
}
function saveCart(c) { localStorage.setItem('bb_cart', JSON.stringify(c)); }

function addToCart(id) {
  const p = BB_PRODUCTS.find(x => x.id === id);
  if (!p) return;
  const cart = getCart();
  const item = cart.find(i => i.id === id);
  if (item) item.qty++; else cart.push({ id, qty: 1 });
  saveCart(cart);
  updateBadge();
  showToast(p.name + ' added to cart ✓');
}

function updateBadge() {
  const n = getCart().reduce((s, i) => s + i.qty, 0);
  document.querySelectorAll('.cart-count').forEach(el => {
    el.textContent = n || '';
    el.style.display = n ? 'flex' : 'none';
  });
}

function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ── HEADER SCROLL ── */
const hdrEl = document.getElementById('hdr');
if (hdrEl) window.addEventListener('scroll', () => hdrEl.classList.toggle('raised', scrollY > 10), { passive: true });

/* ── BURGER MENU ── */
const mobBtn = document.getElementById('mob');
const mobOverlay = document.getElementById('moboverlay');
function closeMob() { document.body.classList.remove('nav-open'); }
if (mobBtn) mobBtn.addEventListener('click', () => document.body.classList.toggle('nav-open'));
if (mobOverlay) mobOverlay.addEventListener('click', closeMob);
document.querySelectorAll('.mob-nav a').forEach(a => a.addEventListener('click', closeMob));

/* ── NEWSLETTER ── */
function nlSub(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button'), inp = e.target.querySelector('input');
  btn.textContent = 'Subscribed!'; btn.style.background = '#5e8c72';
  inp.value = ''; inp.placeholder = "You're on the list!";
  setTimeout(() => { btn.textContent = 'Subscribe'; btn.style.background = ''; inp.placeholder = 'Your email address'; }, 4000);
}

/* ── SMOOTH SCROLL ── */
document.querySelectorAll('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
  const t = document.querySelector(a.getAttribute('href'));
  if (!t) return;
  e.preventDefault();
  window.scrollTo({ top: t.offsetTop - (hdrEl ? hdrEl.offsetHeight : 76) - 8, behavior: 'smooth' });
}));

/* ── SCROLL REVEAL ── */
const revObs = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) { e.target.style.opacity = '1'; e.target.style.transform = 'translateY(0)'; revObs.unobserve(e.target); }
  });
}, { threshold: 0.06, rootMargin: '0px 0px -28px 0px' });
document.querySelectorAll('.pcard,.ccard,.contact-card,.feat,.ocard,.addon-card').forEach((el, i) => {
  el.style.opacity = '0'; el.style.transform = 'translateY(20px)';
  el.style.transition = `opacity .4s ease ${i * .04}s, transform .4s ease ${i * .04}s, box-shadow .22s ease`;
  revObs.observe(el);
});

/* ── PRODUCT FILTER (products.html) ── */
const filterBtns = document.querySelectorAll('[data-filter]');
if (filterBtns.length) {
  const initCat = new URLSearchParams(location.search).get('cat') || 'all';
  applyFilter(initCat);
  filterBtns.forEach(btn => btn.addEventListener('click', () => applyFilter(btn.dataset.filter)));
}

function applyFilter(cat) {
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('act', b.dataset.filter === cat));
  document.querySelectorAll('.pcard[data-cat]').forEach(card => {
    card.classList.toggle('pcard-hidden', cat !== 'all' && card.dataset.cat !== cat);
  });
  const url = new URL(location.href);
  url.searchParams.set('cat', cat);
  history.replaceState(null, '', url.toString());
}

/* ── CART PAGE ── */
if (document.getElementById('cart-wrap')) renderCart();

function fmt(n) { return 'R ' + n.toFixed(2); }

function renderCart() {
  const cart = getCart();
  const wrap = document.getElementById('cart-wrap');
  if (!cart.length) {
    wrap.innerHTML = `<div class="cart-empty">
      <div class="confirm-icon">🛒</div>
      <h2>Your cart is empty</h2>
      <p>Add some beautiful gifts to get started.</p>
      <a href="products.html" class="btn btn-primary" style="display:inline-block">Shop Now</a>
    </div>`;
    return;
  }
  const delivery = 99;
  const totalQty = cart.reduce((s, i) => s + i.qty, 0);
  const subtotal = cart.reduce((s, i) => {
    const p = BB_PRODUCTS.find(x => x.id === i.id);
    return s + (p ? p.price * i.qty : 0);
  }, 0);
  const itemsHtml = cart.map(item => {
    const p = BB_PRODUCTS.find(x => x.id === item.id);
    if (!p) return '';
    return `<div class="cart-row">
      <div class="cart-thumb ${p.img}"></div>
      <div>
        <p class="cart-item-name">${p.name}</p>
        <p class="cart-item-cat">${p.catLabel}</p>
        <div class="cart-qty">
          <button class="qty-btn" onclick="changeQty(${p.id},-1)">&#8722;</button>
          <span class="qty-val">${item.qty}</span>
          <button class="qty-btn" onclick="changeQty(${p.id},1)">+</button>
        </div>
      </div>
      <div class="cart-right">
        <span class="cart-item-price">${fmt(p.price * item.qty)}</span>
        <button class="cart-remove" onclick="removeItem(${p.id})" title="Remove">&#10005;</button>
      </div>
    </div>`;
  }).join('');
  wrap.innerHTML = `<div class="cart-layout">
    <div>
      <div class="cart-items-list">${itemsHtml}</div>
      <div id="checkout-slot"></div>
    </div>
    <div class="cart-summary">
      <p class="cs-title">Order Summary</p>
      <div class="cs-row"><span>Subtotal (${totalQty} item${totalQty !== 1 ? 's' : ''})</span><span>${fmt(subtotal)}</span></div>
      <div class="cs-row"><span>Delivery</span><span>${fmt(delivery)}</span></div>
      <hr class="cs-divider">
      <div class="cs-total"><span>Total</span><span>${fmt(subtotal + delivery)}</span></div>
      <button class="btn-checkout" onclick="showCheckout()">Proceed to Checkout &#8594;</button>
    </div>
  </div>`;
}

function changeQty(id, delta) {
  let cart = getCart();
  const item = cart.find(i => i.id === id);
  if (!item) return;
  item.qty = Math.max(0, item.qty + delta);
  if (item.qty === 0) cart = cart.filter(i => i.id !== id);
  saveCart(cart); updateBadge(); renderCart();
}

function removeItem(id) {
  saveCart(getCart().filter(i => i.id !== id));
  updateBadge(); renderCart();
}

function showCheckout() {
  const slot = document.getElementById('checkout-slot');
  if (!slot) return;
  if (slot.children.length) { slot.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const today = new Date().toISOString().split('T')[0];
  slot.innerHTML = `<div class="checkout-section">
    <h2>Delivery Details</h2>
    <form class="checkout-grid" onsubmit="placeOrder(event)" novalidate>
      <div class="cform-group"><label>Full Name</label><input type="text" required placeholder="Recipient's full name"></div>
      <div class="cform-group"><label>Phone</label><input type="tel" required placeholder="+27 80 000 0000"></div>
      <div class="cform-group"><label>Email</label><input type="email" required placeholder="your@email.com"></div>
      <div class="cform-group"><label>Delivery Suburb</label>
        <input type="text" required placeholder="e.g. Sandton" list="sb-list" autocomplete="off">
        <datalist id="sb-list">
          <option value="Sandton"><option value="Rosebank"><option value="Randburg">
          <option value="Fourways"><option value="Midrand"><option value="Centurion">
          <option value="Pretoria Central"><option value="Menlo Park"><option value="Brooklyn">
          <option value="Hatfield"><option value="Lynnwood"><option value="Waterkloof">
          <option value="Johannesburg CBD"><option value="Parktown"><option value="Northcliff">
          <option value="Roodepoort"><option value="Soweto"><option value="Kempton Park">
          <option value="Edenvale"><option value="Bedfordview"><option value="Boksburg">
          <option value="Bryanston"><option value="Sunninghill"><option value="Woodmead">
        </datalist>
      </div>
      <div class="cform-group"><label>Delivery Date</label><input type="date" required min="${today}"></div>
      <div class="cform-group full"><label>Gift Message (optional)</label>
        <textarea placeholder="Write a heartfelt message to include with your gift..."></textarea>
      </div>
      <div class="cform-group full"><button type="submit" class="btn-place">Place Order &#8594;</button></div>
    </form>
  </div>`;
  slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function placeOrder(e) {
  e.preventDefault();
  const required = e.target.querySelectorAll('[required]');
  for (const f of required) {
    if (!f.value.trim()) { f.focus(); f.style.borderColor = '#dc2626'; return; }
    f.style.borderColor = '';
  }
  saveCart([]); updateBadge();
  document.getElementById('cart-wrap').innerHTML = `<div class="order-confirm">
    <div class="confirm-icon">&#127800;</div>
    <h2>Order Placed!</h2>
    <p>Thank you! We'll confirm your delivery via email and WhatsApp shortly. Expect fresh flowers delivered with love.</p>
    <a href="index.html" class="btn btn-primary" style="display:inline-block">Back to Home</a>
  </div>`;
}

/* ── INIT ── */
updateBadge();

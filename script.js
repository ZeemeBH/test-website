/* ============================================================
   BOXOUT — Landing Page Script
   ============================================================ */

/* ── Sticky Nav ── */
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

/* ── Mobile Burger ── */
const burger = document.getElementById('burger');
const navLinks = document.getElementById('navLinks');
burger.addEventListener('click', () => {
  const open = navLinks.classList.toggle('open');
  burger.setAttribute('aria-expanded', String(open));
});
// Close on link click
navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('open');
    burger.setAttribute('aria-expanded', 'false');
  });
});

/* ── Counter animation ── */
function animateCounter(el) {
  const target = parseInt(el.dataset.target, 10);
  const duration = 1600;
  const step = 16;
  const steps = duration / step;
  const increment = target / steps;
  let current = 0;
  const timer = setInterval(() => {
    current += increment;
    if (current >= target) {
      el.textContent = target.toLocaleString();
      clearInterval(timer);
    } else {
      el.textContent = Math.floor(current).toLocaleString();
    }
  }, step);
}

/* ── Intersection Observer for scroll animations ── */
const io = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      io.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

document.querySelectorAll('[data-animate]').forEach(el => io.observe(el));

/* Counter observer — fires when hero stats scroll into view */
const counterObs = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.querySelectorAll('.stat__num[data-target]').forEach(animateCounter);
      counterObs.unobserve(entry.target);
    }
  });
}, { threshold: 0.5 });

const heroStats = document.querySelector('.hero__stats');
if (heroStats) counterObs.observe(heroStats);

/* ── Pricing toggle ── */
const billingToggle = document.getElementById('billingToggle');
const toggleMonthly = document.getElementById('toggle-monthly');
const toggleAnnual = document.getElementById('toggle-annual');
let isAnnual = false;

billingToggle.addEventListener('click', () => {
  isAnnual = !isAnnual;
  billingToggle.setAttribute('aria-checked', String(isAnnual));
  toggleMonthly.classList.toggle('active', !isAnnual);
  toggleAnnual.classList.toggle('active', isAnnual);

  document.querySelectorAll('.price[data-monthly]').forEach(el => {
    const val = isAnnual ? el.dataset.annual : el.dataset.monthly;
    el.textContent = '$' + val;
  });
});

/* ── Testimonial slider ── */
const track = document.getElementById('testimonialTrack');
const dots = document.querySelectorAll('.dot');
let current = 0;
let autoTimer;

function goTo(index) {
  current = (index + dots.length) % dots.length;
  track.style.transform = `translateX(-${current * 100}%)`;
  dots.forEach((d, i) => d.classList.toggle('active', i === current));
}

dots.forEach(dot => {
  dot.addEventListener('click', () => {
    clearInterval(autoTimer);
    goTo(parseInt(dot.dataset.index, 10));
    startAuto();
  });
});

function startAuto() {
  autoTimer = setInterval(() => goTo(current + 1), 5000);
}
startAuto();

/* Touch/swipe support for slider */
let touchStartX = 0;
track.parentElement.addEventListener('touchstart', e => {
  touchStartX = e.touches[0].clientX;
}, { passive: true });
track.parentElement.addEventListener('touchend', e => {
  const diff = touchStartX - e.changedTouches[0].clientX;
  if (Math.abs(diff) > 40) {
    clearInterval(autoTimer);
    goTo(current + (diff > 0 ? 1 : -1));
    startAuto();
  }
}, { passive: true });

/* ── Contact form ── */
const form = document.getElementById('contactForm');
const feedback = document.getElementById('formFeedback');

form.addEventListener('submit', e => {
  e.preventDefault();
  feedback.textContent = '';
  feedback.className = 'form__feedback';

  const name = form.name.value.trim();
  const email = form.email.value.trim();
  const message = form.message.value.trim();
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!name) {
    showFeedback('Please enter your name.', 'error');
    form.name.focus();
    return;
  }
  if (!emailRe.test(email)) {
    showFeedback('Please enter a valid email address.', 'error');
    form.email.focus();
    return;
  }
  if (!message) {
    showFeedback('Please include a message.', 'error');
    form.message.focus();
    return;
  }

  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  // Simulate async send
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = 'Send message';
    form.reset();
    showFeedback('Message sent! We\'ll be in touch within 2 hours.', 'success');
  }, 1200);
});

function showFeedback(msg, type) {
  feedback.textContent = msg;
  feedback.className = 'form__feedback ' + type;
}

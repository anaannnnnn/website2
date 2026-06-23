/* =====================================================================
   Desire Group — interaction & motion layer
   GSAP + ScrollTrigger for scroll-driven reveals & counters.
   Motion (motion.dev, the vanilla successor to Framer Motion) for the
   hero intro choreography. Graceful fallback if libraries are absent.
   ===================================================================== */
(() => {
  'use strict';

  const root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('reveal-ready');

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasGSAP = typeof window.gsap !== 'undefined';
  const hasMotion = typeof window.Motion !== 'undefined';

  /* ── NAV: scrolled state + mobile toggle ─────────────── */
  const nav = document.querySelector('.nav');
  const toggle = document.querySelector('.nav__toggle');
  const links = document.querySelector('.nav__links');

  const onScroll = () => {
    if (!nav) return;
    nav.classList.toggle('scrolled', window.scrollY > 20);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    links.querySelectorAll('a').forEach(a =>
      a.addEventListener('click', () => {
        links.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      })
    );
  }

  /* ── Smooth anchor scrolling ─────────────────────────── */
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const id = a.getAttribute('href');
      if (id.length < 2) return;
      const el = document.querySelector(id);
      if (!el) return;
      e.preventDefault();
      const y = el.getBoundingClientRect().top + window.scrollY - 90;
      window.scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' });
    });
  });

  /* ── HERO intro choreography (Motion) ────────────────── */
  function heroIntro() {
    const targets = document.querySelectorAll('[data-hero]');
    if (reduce || !targets.length) {
      targets.forEach(t => { t.style.opacity = 1; t.style.transform = 'none'; });
      return;
    }
    if (hasMotion && Motion.animate) {
      targets.forEach((el, i) => {
        Motion.animate(
          el,
          { opacity: [0, 1], transform: ['translateY(28px)', 'translateY(0px)'] },
          { duration: 0.9, delay: 0.15 + i * 0.12, easing: [0.22, 1, 0.36, 1] }
        );
      });
    } else if (hasGSAP) {
      gsap.fromTo(targets,
        { opacity: 0, y: 28 },
        { opacity: 1, y: 0, duration: 0.9, stagger: 0.12, delay: 0.15, ease: 'power3.out' });
    } else {
      targets.forEach(t => { t.style.opacity = 1; t.style.transform = 'none'; });
    }
  }

  /* ── Scroll reveals (GSAP ScrollTrigger or IO fallback) ─ */
  function setupReveals() {
    const items = document.querySelectorAll('[data-reveal]');
    if (!items.length) return;

    if (reduce) {
      items.forEach(el => el.classList.add('is-in'));
      return;
    }

    if (hasGSAP && window.ScrollTrigger) {
      gsap.registerPlugin(ScrollTrigger);
      items.forEach(el => {
        const delay = parseFloat(el.dataset.delay || '0');
        gsap.fromTo(el,
          { opacity: 0, y: 34 },
          {
            opacity: 1, y: 0, duration: 0.85, delay, ease: 'power3.out',
            scrollTrigger: { trigger: el, start: 'top 86%', once: true }
          });
      });
    } else {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(en => {
          if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
        });
      }, { threshold: 0.15 });
      items.forEach(el => io.observe(el));
    }
  }

  /* ── Animated counters ───────────────────────────────── */
  function setupCounters() {
    const nums = document.querySelectorAll('[data-count]');
    if (!nums.length) return;

    const run = (el) => {
      const target = parseFloat(el.dataset.count);
      const suffix = el.dataset.suffix || '';
      if (reduce) { el.textContent = target + suffix; return; }
      const dur = 1400;
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased) + suffix;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    if (hasGSAP && window.ScrollTrigger) {
      nums.forEach(el => ScrollTrigger.create({
        trigger: el, start: 'top 90%', once: true, onEnter: () => run(el)
      }));
    } else {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(en => {
          if (en.isIntersecting) { run(en.target); io.unobserve(en.target); }
        });
      }, { threshold: 0.4 });
      nums.forEach(el => io.observe(el));
    }
  }

  /* ── Subtle parallax on hero copy ────────────────────── */
  function heroParallax() {
    if (reduce || !hasGSAP || !window.ScrollTrigger) return;
    const copy = document.querySelector('.hero__copy');
    if (!copy) return;
    gsap.to(copy, {
      y: -60, ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true }
    });
  }

  function boot() {
    heroIntro();
    setupReveals();
    setupCounters();
    heroParallax();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

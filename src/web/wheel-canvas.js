(() => {
  'use strict';

  const BASE_HUES = [174, 208, 268, 330, 12, 42, 96, 150, 232, 296, 352, 64];

  function isDarkTheme() {
    if (document.documentElement.dataset.theme === 'dark') return true;
    if (document.documentElement.dataset.theme === 'light') return false;
    const scheme = getComputedStyle(document.documentElement).colorScheme || '';
    return scheme.includes('dark');
  }

  /* Wheel slices are domain colour: they identify an option, they never carry
     the only copy of any information, and every one of them is also written out
     with its label and probability in the list below the wheel. Saturation and
     lightness follow the host theme so the wheel stays readable in both. */
  function palette(count) {
    const dark = isDarkTheme();
    const lightness = dark ? 62 : 46;
    const saturation = dark ? 58 : 66;
    return Array.from({ length: count }, (_, index) => {
      const hue = BASE_HUES[index % BASE_HUES.length] + Math.floor(index / BASE_HUES.length) * 7;
      return `hsl(${(hue % 360 + 360) % 360} ${saturation}% ${lightness}%)`;
    });
  }

  function labelColor(background) {
    const match = /hsl\((\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\)/.exec(background);
    if (!match) return '#FFFFFF';
    if (Number(match[3]) >= 62) return '#101413';
    return '#FFFFFF';
  }

  const easeOutCubic = t => 1 - (1 - t) ** 3;
  const easeOutQuint = t => 1 - (1 - t) ** 5;

  function prefersReducedMotion() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * @param canvas a <canvas> element that already lives in the layout.
   *
   * The wheel never decides anything: the caller draws from the sampler first
   * and then asks the wheel to land on that slice. An animation that "stops
   * where it stops" would make the visible result depend on frame timing.
   */
  function create(canvas) {
    const context = canvas.getContext('2d');
    let slices = [];
    let rotation = -Math.PI / 2;
    let frame = null;
    let size = 0;

    function resize() {
      const ratio = Math.min(globalThis.devicePixelRatio || 1, 3);
      const width = Math.max(160, Math.round(canvas.clientWidth || 280));
      if (width === size && canvas.width === Math.round(width * ratio)) return;
      size = width;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(width * ratio);
      canvas.style.height = `${width}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function arcFor(index) {
      const total = slices.reduce((sum, slice) => sum + slice.share, 0);
      let start = 0;
      for (let step = 0; step < index; step += 1) start += slices[step].share;
      const sweep = slices[index]?.share ?? 0;
      const safe = total > 0 ? total : 1;
      return { start: (start / safe) * Math.PI * 2, sweep: (sweep / safe) * Math.PI * 2 };
    }

    function draw() {
      resize();
      const radius = size / 2;
      const center = radius;
      context.clearRect(0, 0, size, size);

      if (slices.length === 0) {
        context.save();
        context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--ats-outline-variant').trim() || '#BFC9C5';
        context.lineWidth = 2;
        context.beginPath();
        context.arc(center, center, radius - 4, 0, Math.PI * 2);
        context.stroke();
        context.restore();
        return;
      }

      const colors = palette(slices.length);
      context.save();
      context.translate(center, center);
      context.rotate(rotation);
      let angle = 0;
      const full = Math.PI * 2;
      const total = slices.reduce((sum, slice) => sum + slice.share, 0) || 1;
      slices.forEach((slice, index) => {
        const sweep = (slice.share / total) * full;
        context.beginPath();
        context.moveTo(0, 0);
        context.arc(0, 0, radius - 3, angle, angle + sweep);
        context.closePath();
        context.fillStyle = colors[index];
        context.fill();
        context.strokeStyle = 'rgba(0,0,0,0.12)';
        context.lineWidth = 1;
        context.stroke();

        if (sweep > 0.16) {
          context.save();
          context.rotate(angle + sweep / 2);
          context.fillStyle = labelColor(colors[index]);
          const fontSize = Math.max(11, Math.min(15, size / 24));
          context.font = `600 ${fontSize}px var(--ats-font-family, system-ui, sans-serif)`;
          context.textAlign = 'right';
          context.textBaseline = 'middle';
          const available = radius * 0.74;
          let text = slice.label;
          while (text.length > 1 && context.measureText(text).width > available) {
            text = text.slice(0, -2);
          }
          if (text !== slice.label) text = `${text}…`;
          context.fillText(text, radius * 0.88, 0);
          context.restore();
        }
        angle += sweep;
      });
      context.restore();

      const outline = getComputedStyle(document.documentElement).getPropertyValue('--ats-surface').trim() || '#FFFFFF';
      context.save();
      context.translate(center, center);
      context.beginPath();
      context.arc(0, 0, radius * 0.17, 0, Math.PI * 2);
      context.fillStyle = outline;
      context.fill();
      context.restore();
    }

    function animateTo(index, options = {}) {
      cancel();
      draw();
      if (index < 0 || index >= slices.length) return Promise.resolve();
      const { start, sweep } = arcFor(index);
      /* The pointer sits at the top of the wheel, which is -90 degrees in the
         canvas coordinate system before any rotation. */
      const target = -Math.PI / 2 - (start + sweep / 2);
      const current = rotation;
      const turns = options.turns ?? 4;
      const normalized = ((target - current) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      const total = normalized + turns * Math.PI * 2;
      if (prefersReducedMotion() || options.duration === 0) {
        rotation = current + normalized;
        draw();
        return Promise.resolve();
      }
      const duration = options.duration ?? 2400;
      const started = performance.now();
      return new Promise(resolve => {
        const step = now => {
          const progress = Math.min(1, (now - started) / duration);
          rotation = current + total * easeOutQuint(progress);
          draw();
          if (progress < 1 && frame !== null) {
            frame = requestAnimationFrame(step);
          } else {
            frame = null;
            rotation = current + normalized;
            draw();
            resolve();
          }
        };
        frame = requestAnimationFrame(step);
      });
    }

    function cancel() {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    }

    return {
      setSlices(list) {
        slices = list;
        draw();
      },
      getSlices() {
        return slices;
      },
      render: draw,
      animateTo,
      cancel,
      isAnimating: () => frame !== null,
      /* Where the currently drawn slice sits, for tests and for callers that
         want to re-render without re-animating. */
      angleOf: arcFor,
    };
  }

  globalThis.wheelCanvas = { create, palette, isDarkTheme, prefersReducedMotion, easeOutCubic, easeOutQuint, BASE_HUES };
})();

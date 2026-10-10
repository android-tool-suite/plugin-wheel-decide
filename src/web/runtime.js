(() => {
  'use strict';

  const pluginId = document.querySelector('meta[name="ats-plugin-id"]')?.content;
  const sessionId = document.querySelector('meta[name="ats-session-id"]')?.content;
  const transport = window.atsTransport;
  const available = Boolean(pluginId && sessionId && transport);

  let nextId = 1;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const pending = new Map();
  const listeners = new Map();
  let lastSequence = -1;
  let readyTimer = null;

  function emit(name, payload) {
    for (const listener of listeners.get(name) || []) listener(payload);
  }

  if (available) {
    readyTimer = setTimeout(() => readyReject(new Error('无法连接应用，请返回后重新打开工具。')), 5000);
    transport.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.pluginId !== pluginId || message.sessionId !== sessionId) return;
      if (message.kind === 'ready') {
        clearTimeout(readyTimer);
        readyTimer = null;
        applyTheme(message.payload);
        readyResolve(message.payload || {});
        return;
      }
      if (message.kind === 'event') {
        if (!(message.sequence > lastSequence)) return;
        lastSequence = message.sequence;
        if (message.event === 'app.themeChanged') applyTheme(message.payload);
        emit(message.event, message.payload || {});
        return;
      }
      if (message.kind !== 'response') return;
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      clearTimeout(request.timeout);
      if (message.ok) request.resolve(message.result || {});
      else request.reject(Object.assign(new Error(message.error?.message || '操作失败'), message.error || {}));
    };
    transport.postMessage(JSON.stringify({
      protocol: '2.0',
      kind: 'hello',
      pluginId,
      sessionId,
      requestId: '0',
      payload: { supportedProtocols: ['2.0'], features: [] },
    }));
  } else {
    readyReject(new Error('此页面只能在应用内打开。'));
  }

  /**
   * The host pushes a full stylesheet whenever the theme changes. Writing it to
   * a dedicated <style> element is what keeps an open page in sync with a
   * light/dark switch instead of only picking the theme up on the next open.
   */
  function applyTheme(payload) {
    const css = payload && typeof payload.css === 'string' ? payload.css : '';
    if (css === '') return;
    let style = document.querySelector('style[data-ats-runtime-theme]');
    if (!style) {
      style = document.createElement('style');
      style.dataset.atsRuntimeTheme = 'true';
      document.head.append(style);
    }
    style.textContent = css;
    if (payload && typeof payload.dark === 'boolean') {
      document.documentElement.dataset.theme = payload.dark ? 'dark' : 'light';
    }
  }

  function call(method, payload = {}, deadlineMs = 30000) {
    if (!available) return Promise.reject(new Error('此页面只能在应用内打开。'));
    return ready.then(() => new Promise((resolve, reject) => {
      const requestId = String(nextId++);
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('操作超时，请重试。'));
      }, deadlineMs);
      pending.set(requestId, { resolve, reject, timeout });
      transport.postMessage(JSON.stringify({ protocol: '2.0', kind: 'request', pluginId, sessionId, requestId, method, payload, deadlineMs }));
    }));
  }

  function on(name, listener) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(listener);
    return () => listeners.get(name)?.delete(listener);
  }

  const toBase64 = bytes => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  };
  const fromBase64 = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));

  globalThis.wheelRuntime = { available, ready, call, on, toBase64, fromBase64, applyTheme };
})();

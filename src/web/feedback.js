(() => {
  'use strict';

  const DEFAULT_TIMEOUT = 5000;
  const ERROR_TIMEOUT = 10000;

  function create(element) {
    let timer = null;
    let current = null;

    function dismiss() {
      clearTimeout(timer);
      timer = null;
      current = null;
      element.hidden = true;
      element.replaceChildren();
    }

    /**
     * @param text    already user-facing; never a raw exception message.
     * @param options `{ error, timeout, action: { label, run } }`.
     *
     * The bar is appended to the open dialog when there is one, otherwise a
     * modal <dialog> would paint over it and the message would never be seen.
     */
    function show(text, options = {}) {
      const message = String(text ?? '').trim();
      if (message === '') {
        dismiss();
        return;
      }
      dismiss();
      const error = options.error === true;
      element.className = 'snackbar';
      element.setAttribute('role', error ? 'alert' : 'status');
      element.setAttribute('aria-live', error ? 'assertive' : 'polite');
      const label = document.createElement('span');
      label.textContent = message;
      element.append(label);
      if (options.action && typeof options.action.run === 'function') {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'text-button';
        action.textContent = options.action.label || '查看';
        action.onclick = () => {
          dismiss();
          options.action.run();
        };
        element.append(action);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'text-button';
      close.textContent = '关闭';
      close.setAttribute('aria-label', '关闭提示');
      close.onclick = dismiss;
      element.append(close);

      const host = document.querySelector('dialog[open]') || document.body;
      host.append(element);
      element.hidden = false;
      current = message;
      timer = setTimeout(dismiss, options.timeout || (error ? ERROR_TIMEOUT : DEFAULT_TIMEOUT));
    }

    return { show, dismiss, current: () => current };
  }

  globalThis.wheelFeedback = { create };
})();

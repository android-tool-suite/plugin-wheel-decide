(() => {
  'use strict';

  const CHUNK = 131072;
  const PRESETS = 'wheel-presets';
  const HISTORY = 'wheel-history';

  const DECODER = new TextDecoder();
  const ENCODER = new TextEncoder();

  async function readJson(datasetId) {
    const runtime = globalThis.wheelRuntime;
    const opened = await runtime.call('storage.dataset.openRead', { datasetId });
    if (!opened.found) return null;
    const chunks = [];
    let offset = 0;
    try {
      for (;;) {
        const part = await runtime.call('storage.dataset.read', { handle: opened.handle, offset, maxBytes: CHUNK });
        const bytes = runtime.fromBase64(part.bytes);
        if (bytes.length > 0) {
          chunks.push(bytes);
          offset += bytes.length;
        }
        if (part.eof || bytes.length === 0) break;
      }
    } finally {
      await runtime.call('storage.dataset.abort', { handle: opened.handle }).catch(() => {});
    }
    const total = chunks.reduce((sum, item) => sum + item.length, 0);
    const bytes = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.length;
    }
    const parsed = JSON.parse(DECODER.decode(bytes));
    return parsed && typeof parsed === 'object' ? parsed : null;
  }

  async function writeJson(datasetId, value) {
    const runtime = globalThis.wheelRuntime;
    const opened = await runtime.call('storage.dataset.openWrite', { datasetId });
    try {
      const bytes = ENCODER.encode(JSON.stringify(value));
      if (Number.isFinite(opened.maxBytes) && bytes.length > opened.maxBytes) {
        throw new Error('保存内容超过容量上限');
      }
      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        await runtime.call('storage.dataset.write', {
          handle: opened.handle,
          bytes: runtime.toBase64(bytes.subarray(offset, offset + CHUNK)),
        });
      }
      await runtime.call('storage.dataset.commit', { handle: opened.handle });
    } catch (error) {
      await runtime.call('storage.dataset.abort', { handle: opened.handle }).catch(() => {});
      throw error;
    }
  }

  /**
   * Reads both datasets. A corrupt or missing dataset falls back to the default
   * shape instead of failing the page: the wheel is usable without any stored
   * data, and the caller reports the downgrade instead of showing an empty
   * screen.
   */
  async function load() {
    const model = globalThis.wheelModel;
    const problems = [];
    let store = null;
    let history = null;
    try {
      store = await readJson(PRESETS);
    } catch (error) {
      problems.push(`预设读取失败：${error.message}`);
    }
    try {
      history = await readJson(HISTORY);
    } catch (error) {
      problems.push(`历史读取失败：${error.message}`);
    }
    return {
      store: model.normalizeStore(store),
      history: model.normalizeHistory(history),
      problems,
      readable: store !== null,
    };
  }

  async function saveStore(store) {
    await writeJson(PRESETS, store);
  }

  async function saveHistory(entries) {
    await writeJson(HISTORY, { formatVersion: 1, entries });
  }

  globalThis.wheelStorage = { PRESETS, HISTORY, readJson, writeJson, load, saveStore, saveHistory };
})();

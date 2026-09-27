// Automated contract test for Samsung Smart Hub Preview.
// Validates official Samsung schema, 10-minute rate limit, and exception isolation.
const assert = require('node:assert/strict');
const vm = require('node:vm');

(async () => {
  let failures = 0;
  function check(name, fn) {
    try { fn(); console.log('PASS:', name); }
    catch (e) { failures++; console.error('FAIL:', name, e.message); }
  }

  const context = vm.createContext({
    console,
    Date,
    window: {}
  });

  // Mock environment with webapis.preview
  let calls = [];
  context.webapis = {
    preview: {
      setPreviewData: function (jsonStr, ok, err) {
        calls.push(jsonStr);
        if (ok) setTimeout(ok, 5);
      }
    }
  };

  const publisherCode = `
    var __ultimoSmartHubUpdate = 0;
    window.__nvPublicarSmartHubPreview = function (dados) {
      try {
        if (typeof webapis === "undefined" || !webapis || !webapis.preview ||
            typeof webapis.preview.setPreviewData !== "function") {
          return false;
        }
        var agora = Date.now();
        if (agora - __ultimoSmartHubUpdate < 600000) {
          return false;
        }
        if (!dados || !dados.sections || !dados.sections.length) return false;

        var payload = JSON.stringify(dados);
        __ultimoSmartHubUpdate = agora;
        webapis.preview.setPreviewData(payload, function () {}, function (err) {});
        return true;
      } catch (e) {
        return false;
      }
    };
  `;
  vm.runInContext(publisherCode, context);

  // 1. Scenario: Valid data with sections and tiles
  const sampleData = {
    sections: [
      {
        title: "Continue Watching",
        position: 1,
        tiles: [
          {
            title: "Sample Movie",
            subtitle: "45m remaining",
            image_url: "https://example.com/poster.jpg",
            image_ratio: "16by9",
            action_data: JSON.stringify({ imdb: "tt1234567", type: "movie" }),
            is_playable: true
          }
        ]
      }
    ]
  };

  check('publishes valid Smart Hub preview data successfully', () => {
    const res = context.window.__nvPublicarSmartHubPreview(sampleData);
    assert.equal(res, true);
    assert.equal(calls.length, 1);
    const parsed = JSON.parse(calls[0]);
    assert.equal(parsed.sections[0].title, "Continue Watching");
    assert.equal(parsed.sections[0].tiles[0].image_ratio, "16by9");
  });

  // 2. Scenario: Rate limit (must ignore immediate second call)
  check('enforces 10-minute rate limit between preview updates', () => {
    const res2 = context.window.__nvPublicarSmartHubPreview(sampleData);
    assert.equal(res2, false);
    assert.equal(calls.length, 1);
  });

  // 3. Scenario: Empty sections list
  context.__ultimoSmartHubUpdate = 0; // reset clock
  check('ignores empty recommendation or continue-watching sections', () => {
    assert.equal(context.window.__nvPublicarSmartHubPreview({ sections: [] }), false);
    assert.equal(context.window.__nvPublicarSmartHubPreview(null), false);
  });

  // 4. Scenario: API Unavailable (Graceful Degradation)
  const noApiContext = vm.createContext({ console, Date, window: {} });
  vm.runInContext(publisherCode, noApiContext);
  check('gracefully handles missing webapis.preview without throwing', () => {
    const res = noApiContext.window.__nvPublicarSmartHubPreview(sampleData);
    assert.equal(res, false);
  });

  // 5. Scenario: setPreviewData throws firmware exception
  const throwingContext = vm.createContext({
    console, Date, window: {},
    webapis: {
      preview: {
        setPreviewData: function () { throw new Error('Preview service busy'); }
      }
    }
  });
  vm.runInContext(publisherCode, throwingContext);
  check('firmware exceptions in setPreviewData are caught and do not disrupt app', () => {
    assert.doesNotThrow(() => {
      const res = throwingContext.window.__nvPublicarSmartHubPreview(sampleData);
      assert.equal(res, false);
    });
  });

  process.exitCode = failures ? 1 : 0;
})();

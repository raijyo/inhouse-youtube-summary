/* options.js – YouTube Summary Extension Settings */

document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput = document.getElementById('api-key');
  const endpointInput = document.getElementById('endpoint-url');
  const modelInput = document.getElementById('model-name');
  const form = document.getElementById('settings-form');
  const testBtn = document.getElementById('test-btn');
  const toggleKeyBtn = document.getElementById('toggle-key');

  // Load saved settings
  const config = await chrome.storage.sync.get(['apiKey', 'endpointUrl', 'modelName']);
  if (config.apiKey) apiKeyInput.value = config.apiKey;
  if (config.endpointUrl) endpointInput.value = config.endpointUrl;
  if (config.modelName) modelInput.value = config.modelName;

  // Toggle API key visibility
  toggleKeyBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyBtn.textContent = '隠す';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyBtn.textContent = '表示';
    }
  });

  // Save settings
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const apiKey = apiKeyInput.value.trim();
    const endpointUrl = endpointInput.value.trim();
    const modelName = modelInput.value.trim();

    if (!apiKey || !endpointUrl || !modelName) {
      showStatus('すべての項目を入力してください', 'error');
      return;
    }

    await chrome.storage.sync.set({ apiKey, endpointUrl, modelName });
    showStatus('✅ 設定を保存しました！', 'success');
  });

  // Connection test
  testBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const endpointUrl = endpointInput.value.trim();
    const modelName = modelInput.value.trim();

    if (!apiKey || !endpointUrl || !modelName) {
      showStatus('テストの前にすべての項目を入力してください', 'error');
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = '⏳ テスト中...';

    const testArea = document.getElementById('test-area');
    const testResult = document.getElementById('test-result');
    testArea.classList.remove('hidden');
    testResult.className = 'test-result loading';
    testResult.textContent = '🔄 エンドポイントに接続中...';

    try {
      const url = endpointUrl.replace(/\/+$/, '') + '/chat/completions';

      const startTime = Date.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'user', content: 'こんにちは。これは疎通テストです。「接続成功」と返答してください。' }
          ],
          max_tokens: 50,
          temperature: 0,
        }),
      });

      const elapsed = Date.now() - startTime;

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        testResult.className = 'test-result error';
        testResult.textContent =
          `❌ 接続失敗\n\n` +
          `ステータス: ${res.status} ${res.statusText}\n` +
          `URL: ${url}\n` +
          `モデル: ${modelName}\n` +
          (errBody ? `\nレスポンス:\n${errBody}` : '');
        return;
      }

      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content || '(応答なし)';

      testResult.className = 'test-result success';
      testResult.textContent =
        `✅ 接続成功！\n\n` +
        `URL: ${url}\n` +
        `モデル: ${data.model || modelName}\n` +
        `応答時間: ${elapsed}ms\n` +
        `AIの返答: ${reply}`;

    } catch (err) {
      testResult.className = 'test-result error';
      testResult.textContent =
        `❌ 接続エラー\n\n` +
        `エラー: ${err.message}\n\n` +
        `考えられる原因:\n` +
        `- エンドポイントURLが正しくない\n` +
        `- サーバーが起動していない\n` +
        `- ネットワーク接続の問題\n` +
        `- CORSの設定が必要`;
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '🔌 疎通テスト';
    }
  });
});

function showStatus(message, type) {
  const el = document.getElementById('save-status');
  el.textContent = message;
  el.className = `status-msg ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

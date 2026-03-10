/* popup.js – YouTube Summary Extension */

const logs = [];
let rawMarkdown = '';

// ── Logging ──────────────────────────────────────────────────
function addLog(message, level = 'info') {
  const time = new Date().toLocaleTimeString('ja-JP');
  const entry = { time, message, level };
  logs.push(entry);

  const logContent = document.getElementById('log-content');
  const div = document.createElement('div');
  div.className = `log-entry log-${level}`;
  div.textContent = `[${time}] ${message}`;
  logContent.appendChild(div);
  logContent.scrollTop = logContent.scrollHeight;

  const logCount = document.getElementById('log-count');
  logCount.textContent = logs.length;
  logCount.classList.remove('hidden');
}

// ── Status (fun messages) ────────────────────────────────────
const STATUS_STEPS = [
  { icon: '🔍', text: '文字起こしを探しています...', progress: 10 },
  { icon: '📜', text: '文字起こしを取得中...', progress: 30 },
  { icon: '📡', text: 'AIにデータを送信中...', progress: 50 },
  { icon: '🤖', text: 'AIが一生懸命まとめています...', progress: 70 },
  { icon: '✍️', text: 'サマリーを仕上げています...', progress: 90 },
  { icon: '🎉', text: '完了しました！', progress: 100 },
];

function setStatus(stepIndex) {
  const statusArea = document.getElementById('status-area');
  statusArea.classList.remove('hidden');

  const step = STATUS_STEPS[stepIndex];
  document.getElementById('status-icon').textContent = step.icon;
  document.getElementById('status-text').textContent = step.text;
  document.getElementById('progress-fill').style.width = step.progress + '%';
}

function hideStatus() {
  document.getElementById('status-area').classList.add('hidden');
}

// ── Toast ────────────────────────────────────────────────────
function showToast(text) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2000);
}

// ── Copy helpers ─────────────────────────────────────────────
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('コピーしました！');
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('コピーしました！');
  });
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Check config
  const config = await chrome.storage.sync.get(['apiKey', 'endpointUrl', 'modelName']);
  const hasConfig = config.apiKey && config.endpointUrl && config.modelName;

  // Check current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isYouTube = tab && tab.url && tab.url.includes('youtube.com/watch');

  if (!isYouTube) {
    document.getElementById('not-youtube').classList.remove('hidden');
    document.getElementById('main-area').classList.add('hidden');
    return;
  }

  if (!hasConfig) {
    document.getElementById('no-config').classList.remove('hidden');
    document.getElementById('main-area').classList.add('hidden');
    document.getElementById('open-options').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
    return;
  }

  document.getElementById('main-area').classList.remove('hidden');

  // Show video title
  document.getElementById('video-title').textContent = tab.title || 'YouTube動画';

  // Summarize button
  document.getElementById('summarize-btn').addEventListener('click', () => {
    startSummarize(tab, config);
  });

  // Copy summary
  document.getElementById('copy-summary').addEventListener('click', () => {
    copyToClipboard(rawMarkdown);
  });

  // Copy logs
  document.getElementById('copy-logs').addEventListener('click', () => {
    const text = logs.map(l => `[${l.time}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
    copyToClipboard(text);
  });

  // Clear logs
  document.getElementById('clear-logs').addEventListener('click', () => {
    logs.length = 0;
    document.getElementById('log-content').innerHTML = '';
    document.getElementById('log-count').textContent = '0';
    document.getElementById('log-count').classList.add('hidden');
  });
});

// ── Summarize Flow ───────────────────────────────────────────
async function startSummarize(tab, config) {
  const btn = document.getElementById('summarize-btn');
  btn.disabled = true;
  btn.textContent = '⏳ 処理中...';
  document.getElementById('summary-area').classList.add('hidden');

  try {
    // Step 0 – looking for transcript
    setStatus(0);
    addLog('文字起こしの取得を開始します');

    // Step 1 – get transcript from content script
    setStatus(1);
    addLog(`タブ: ${tab.url}`);

    let transcript;
    try {
      // Execute extraction script directly in the tab (no message passing)
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });

      const response = results?.[0]?.result;
      if (!response) {
        addLog('content script から応答がありません', 'error');
        throw new Error('スクリプト実行に失敗しました。ページをリロードしてから再度お試しください。');
      }

      // Show debug logs from content script
      if (response.logs && response.logs.length > 0) {
        response.logs.forEach(msg => addLog(`[content] ${msg}`));
      }

      if (response.error) {
        addLog(`文字起こし取得エラー: ${response.error}`, 'error');
        throw new Error(response.error);
      }
      transcript = response.transcript;
      addLog(`文字起こし取得成功 (${transcript.length} 文字)`, 'success');
    } catch (err) {
      if (err.message && !err.message.includes('スクリプト実行に失敗')) {
        throw err;
      }
      addLog(`文字起こし取得エラー: ${err.message}`, 'error');
      throw new Error('文字起こしの取得に失敗しました。ページをリロードしてから再度お試しください。');
    }

    if (!transcript || transcript.trim().length === 0) {
      addLog('文字起こしが空です', 'error');
      throw new Error('この動画には文字起こしがありません。');
    }

    // Step 2 – send to AI
    setStatus(2);
    addLog(`API: ${config.endpointUrl} / model: ${config.modelName}`);

    // Step 3 – AI processing
    setStatus(3);

    const summary = await callAI(config, transcript);
    addLog('AIからレスポンスを受信', 'success');

    // Step 4 – formatting
    setStatus(4);
    rawMarkdown = summary;

    const summaryContent = document.getElementById('summary-content');
    summaryContent.innerHTML = marked.parse(summary);

    // Step 5 – done
    setStatus(5);
    addLog('サマリー生成完了', 'success');

    document.getElementById('summary-area').classList.remove('hidden');

    setTimeout(() => hideStatus(), 2000);

  } catch (err) {
    addLog(`エラー: ${err.message}`, 'error');
    document.getElementById('status-icon').textContent = '😵';
    document.getElementById('status-text').textContent = err.message;
    document.getElementById('progress-fill').style.width = '0%';

    // Automatically expand log area on error
    document.getElementById('log-area').open = true;
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ サマリーを生成する';
  }
}

// ── AI API Call ──────────────────────────────────────────────
async function callAI(config, transcript) {
  const systemPrompt = `あなたは動画の内容を簡潔にまとめる専門家です。
与えられた文字起こしテキストを、10行〜20行程度の簡潔なサマリーにまとめてください。

ルール:
- Markdown形式で出力してください
- 重要なポイントを箇条書きで整理してください
- 動画の主要なトピックと結論を含めてください
- 日本語で出力してください
- 簡潔かつ分かりやすい表現を使ってください`;

  const url = config.endpointUrl.replace(/\/+$/, '') + '/chat/completions';

  addLog(`リクエスト送信: POST ${url}`);

  const body = {
    model: config.modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `以下の動画の文字起こしをサマリーにまとめてください:\n\n${transcript}` },
    ],
    temperature: 0.5,
    max_tokens: 2048,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    addLog(`APIエラー: ${res.status} ${res.statusText} - ${errText}`, 'error');
    throw new Error(`APIエラー (${res.status}): ${res.statusText}`);
  }

  const data = await res.json();
  addLog(`APIレスポンス受信 (status: ${res.status})`, 'success');

  if (!data.choices || data.choices.length === 0) {
    addLog('APIレスポンスにchoicesがありません', 'error');
    throw new Error('AIからの応答が空でした');
  }

  return data.choices[0].message.content;
}

/* content.js – YouTube transcript extraction
   Executed via chrome.scripting.executeScript from popup.js.
   Returns { transcript, logs, error? } as the script's last expression. */

(async () => {
  const debugLogs = [];
  const log = (msg) => debugLogs.push(msg);

  try {
    const params = new URLSearchParams(window.location.search);
    const videoId = params.get('v');
    if (!videoId) {
      return { error: '動画IDが見つかりません', transcript: '', logs: debugLogs };
    }

    log(`videoId: ${videoId}`);

    // Fetch the video page HTML to get caption information
    log('動画ページHTMLを取得中...');
    let html;
    try {
      const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        log(`ページ取得失敗: ${res.status}`);
        return { error: `ページ取得失敗: ${res.status}`, transcript: '', logs: debugLogs };
      }
      html = await res.text();
      log(`HTML取得成功 (${html.length} bytes)`);
    } catch (err) {
      log(`ページ取得エラー: ${err.message}`);
      return { error: `ページ取得エラー: ${err.message}`, transcript: '', logs: debugLogs };
    }

    // ── Strategy 1: Extract captionTracks from HTML ──────────
    log('Strategy 1: captionTracksを抽出中...');
    const s1 = await (async () => {
      try {
        const marker = '"captionTracks":';
        const idx = html.indexOf(marker);
        if (idx === -1) {
          log('captionTracks が HTML 内に見つかりません');
          return null;
        }

        const start = idx + marker.length;
        const arrayStr = extractJSONArray(html, start);
        if (!arrayStr) {
          log('captionTracks の JSON 配列パースに失敗');
          return null;
        }

        const captions = JSON.parse(arrayStr);
        log(`キャプショントラック数: ${captions.length}`);
        captions.forEach((c, i) => {
          log(`  [${i}] lang=${c.languageCode}, kind=${c.kind || 'manual'}, name=${c.name?.simpleText || ''}`);
        });

        let track = captions.find(c => c.languageCode === 'ja' && c.kind !== 'asr');
        if (!track) track = captions.find(c => c.languageCode === 'ja');
        if (!track) track = captions.find(c => c.kind === 'asr');
        if (!track) track = captions[0];

        if (!track || !track.baseUrl) {
          log('有効なキャプショントラックが見つかりません');
          return null;
        }

        log(`選択トラック: lang=${track.languageCode}, kind=${track.kind || 'manual'}`);

        const res = await fetch(track.baseUrl);
        if (!res.ok) {
          log(`字幕XML取得失敗: ${res.status}`);
          return null;
        }

        const xml = await res.text();
        log(`字幕XMLサイズ: ${xml.length} bytes`);

        const text = parseTranscriptXML(xml);
        if (text.trim().length === 0) {
          log('字幕XMLのパース結果が空です');
          log(`XML先頭200文字: ${xml.substring(0, 200)}`);
          return null;
        }

        return text;
      } catch (err) {
        log(`Strategy 1 エラー: ${err.message}`);
        return null;
      }
    })();

    if (s1) {
      log(`Strategy 1 成功: ${s1.length} 文字`);
      return { transcript: s1, logs: debugLogs };
    }

    // ── Strategy 2: Innertube get_transcript API ─────────────
    log('Strategy 2: innertube APIを試行中...');
    const s2 = await (async () => {
      try {
        const keyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
        if (!keyMatch) {
          log('INNERTUBE_API_KEY が見つかりません');
          return null;
        }
        const apiKey = keyMatch[1];
        log(`INNERTUBE_API_KEY: ${apiKey}`);

        const versionMatch = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
        const clientVersion = versionMatch ? versionMatch[1] : '2.20240101.00.00';
        log(`clientVersion: ${clientVersion}`);

        // Find getTranscriptEndpoint params
        const altMatch = html.match(/"getTranscriptEndpoint"\s*:\s*\{[^}]*"params"\s*:\s*"([^"]+)"/);
        if (!altMatch) {
          log('get_transcript params が見つかりません');
          return null;
        }
        const transcriptParams = altMatch[1];
        log(`transcript params: ${transcriptParams.substring(0, 40)}...`);

        const res = await fetch(
          `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              context: {
                client: {
                  clientName: 'WEB',
                  clientVersion: clientVersion,
                },
              },
              params: transcriptParams,
            }),
          }
        );

        if (!res.ok) {
          log(`innertube API 失敗: ${res.status}`);
          return null;
        }

        const data = await res.json();
        log(`innertube レスポンス受信`);

        // Parse transcript
        const actions = data?.actions;
        if (actions) {
          for (const action of actions) {
            const panel = action?.updateEngagementPanelAction?.content
              ?.transcriptRenderer?.body?.transcriptBodyRenderer;
            if (panel) {
              const segments = panel.cueGroups || [];
              log(`innertube cueGroups数: ${segments.length}`);
              const lines = [];
              for (const group of segments) {
                const cues = group?.transcriptCueGroupRenderer?.cues || [];
                for (const cue of cues) {
                  const text = cue?.transcriptCueRenderer?.cue?.simpleText;
                  if (text) lines.push(text.trim());
                }
              }
              if (lines.length > 0) return lines.join('\n');
            }
          }
        }

        log('innertube レスポンスに認識可能な構造がありません');
        log(`レスポンスキー: ${JSON.stringify(Object.keys(data || {}))}`);
        return null;
      } catch (err) {
        log(`Strategy 2 エラー: ${err.message}`);
        return null;
      }
    })();

    if (s2) {
      log(`Strategy 2 成功: ${s2.length} 文字`);
      return { transcript: s2, logs: debugLogs };
    }

    log('全ての方法で文字起こしが取得できませんでした');
    return {
      error: 'この動画では文字起こしが利用できません。字幕が有効な動画でお試しください。',
      transcript: '',
      logs: debugLogs,
    };

  } catch (err) {
    log(`致命的エラー: ${err.message}`);
    return { error: err.message, transcript: '', logs: debugLogs };
  }

  // ── Helper: extract JSON array by bracket matching ─────────
  function extractJSONArray(str, startIndex) {
    if (str[startIndex] !== '[') return null;
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIndex; i < str.length; i++) {
      const ch = str[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return str.substring(startIndex, i + 1);
      }
    }
    return null;
  }

  // ── Helper: parse transcript XML ───────────────────────────
  function parseTranscriptXML(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    if (doc.querySelector('parsererror')) return '';

    const texts = doc.querySelectorAll('text');
    if (texts.length > 0) {
      return Array.from(texts)
        .map(t => decodeHTMLEntities(t.textContent.trim()))
        .filter(t => t.length > 0)
        .join('\n');
    }

    const paragraphs = doc.querySelectorAll('p');
    if (paragraphs.length > 0) {
      return Array.from(paragraphs)
        .map(p => {
          const subs = p.querySelectorAll('s');
          if (subs.length > 0) {
            return Array.from(subs).map(s => s.textContent.trim()).join(' ');
          }
          return p.textContent.trim();
        })
        .filter(t => t.length > 0)
        .join('\n');
    }

    return '';
  }

  function decodeHTMLEntities(text) {
    const ta = document.createElement('textarea');
    ta.innerHTML = text;
    return ta.value;
  }
})();

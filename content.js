/* content.js – YouTube transcript extraction */

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'getTranscript') {
    extractTranscript()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message, transcript: '', logs: [] }));
    return true; // async response
  }
});

async function extractTranscript() {
  const debugLogs = [];
  const log = (msg) => debugLogs.push(msg);

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

  // Strategy 1: Extract captionTracks directly from HTML
  log('Strategy 1: captionTracksを抽出中...');
  const captionResult = await tryCaptionTracks(html, log);
  if (captionResult) {
    log(`Strategy 1 成功: ${captionResult.length} 文字`);
    return { transcript: captionResult, logs: debugLogs };
  }

  // Strategy 2: Innertube get_transcript API
  log('Strategy 2: innertube APIを試行中...');
  const innertubeResult = await tryInnertubeAPI(html, videoId, log);
  if (innertubeResult) {
    log(`Strategy 2 成功: ${innertubeResult.length} 文字`);
    return { transcript: innertubeResult, logs: debugLogs };
  }

  log('全ての方法で文字起こしが取得できませんでした');
  return {
    error: 'この動画では文字起こしが利用できません。字幕が有効な動画でお試しください。',
    transcript: '',
    logs: debugLogs,
  };
}

// ── Strategy 1: Caption Tracks from player response ──────────
async function tryCaptionTracks(html, log) {
  try {
    // Find "captionTracks" in the HTML and extract the array
    const marker = '"captionTracks":';
    const idx = html.indexOf(marker);
    if (idx === -1) {
      log('captionTracks が HTML 内に見つかりません');
      return null;
    }

    // Extract the JSON array starting from the marker
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

    // Select best track: prefer Japanese manual, then Japanese ASR, then any ASR, then first
    let track = captions.find(c => c.languageCode === 'ja' && c.kind !== 'asr');
    if (!track) track = captions.find(c => c.languageCode === 'ja');
    if (!track) track = captions.find(c => c.kind === 'asr');
    if (!track) track = captions[0];

    if (!track || !track.baseUrl) {
      log('有効なキャプショントラックが見つかりません');
      return null;
    }

    log(`選択トラック: lang=${track.languageCode}, kind=${track.kind || 'manual'}`);
    log(`URL: ${track.baseUrl.substring(0, 80)}...`);

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
      return null;
    }

    return text;
  } catch (err) {
    log(`Strategy 1 エラー: ${err.message}`);
    return null;
  }
}

// ── Strategy 2: Innertube get_transcript API ─────────────────
async function tryInnertubeAPI(html, videoId, log) {
  try {
    // Extract INNERTUBE_API_KEY
    const keyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    if (!keyMatch) {
      log('INNERTUBE_API_KEY が見つかりません');
      return null;
    }
    const apiKey = keyMatch[1];
    log(`INNERTUBE_API_KEY: ${apiKey}`);

    // Extract client version
    const versionMatch = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
    const clientVersion = versionMatch ? versionMatch[1] : '2.20240101.00.00';
    log(`clientVersion: ${clientVersion}`);

    // Find transcript params from engagement panels in ytInitialData
    // Look for the serialized params
    const paramsMatch = html.match(/"serializedShareEntity"\s*:\s*"([^"]+)".*?"getTranscriptEndpoint"\s*:\s*\{[^}]*"params"\s*:\s*"([^"]+)"/s);
    let transcriptParams = null;

    if (paramsMatch) {
      transcriptParams = paramsMatch[2];
    } else {
      // Alternative: search for getTranscriptEndpoint params directly
      const altMatch = html.match(/"getTranscriptEndpoint"\s*:\s*\{[^}]*"params"\s*:\s*"([^"]+)"/);
      if (altMatch) {
        transcriptParams = altMatch[1];
      }
    }

    if (!transcriptParams) {
      log('get_transcript params が見つかりません');
      return null;
    }

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

    // Parse transcript from the response
    const text = parseInnertubeTranscript(data, log);
    if (!text || text.trim().length === 0) {
      log('innertube transcript のパース結果が空です');
      return null;
    }

    return text;
  } catch (err) {
    log(`Strategy 2 エラー: ${err.message}`);
    return null;
  }
}

// ── JSON Array extraction ────────────────────────────────────
function extractJSONArray(str, startIndex) {
  if (str[startIndex] !== '[') return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < str.length; i++) {
    const ch = str[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return str.substring(startIndex, i + 1);
      }
    }
  }

  return null;
}

// ── Innertube transcript parser ──────────────────────────────
function parseInnertubeTranscript(data, log) {
  try {
    // Try multiple response structures
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

    // Alternative structure
    const body = data?.body?.transcriptBodyRenderer;
    if (body) {
      const segments = body.cueGroups || [];
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

    log('innertube レスポンスに認識可能な構造がありません');
    log(`レスポンスキー: ${JSON.stringify(Object.keys(data || {}))}`);
    return null;
  } catch (err) {
    log(`innertube パースエラー: ${err.message}`);
    return null;
  }
}

// ── XML transcript parser ────────────────────────────────────
function parseTranscriptXML(xml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  // Check for parse error
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    return '';
  }

  // Standard format: <text> elements
  const texts = doc.querySelectorAll('text');
  if (texts.length > 0) {
    return Array.from(texts)
      .map(t => decodeHTMLEntities(t.textContent.trim()))
      .filter(t => t.length > 0)
      .join('\n');
  }

  // SRV3 format: <body><p> elements
  const paragraphs = doc.querySelectorAll('p');
  if (paragraphs.length > 0) {
    return Array.from(paragraphs)
      .map(p => {
        // <p> may contain <s> sub-elements
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

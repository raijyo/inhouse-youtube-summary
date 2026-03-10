/* content.js – YouTube transcript extraction */

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'getTranscript') {
    extractTranscript()
      .then(transcript => sendResponse({ transcript }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // async response
  }
});

async function extractTranscript() {
  // Get video ID from URL
  const params = new URLSearchParams(window.location.search);
  const videoId = params.get('v');
  if (!videoId) {
    throw new Error('動画IDが見つかりません');
  }

  // Fetch the transcript via YouTube's internal API
  // First, get the page data that contains the transcript endpoint info
  const transcript = await fetchTranscriptFromPage(videoId);
  return transcript;
}

async function fetchTranscriptFromPage(videoId) {
  // Try to get transcript data from YouTube's timedtext API
  // First attempt: use the page's ytInitialPlayerResponse
  const playerResponse = getPlayerResponse();

  if (playerResponse) {
    const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (captions && captions.length > 0) {
      // Prefer Japanese, then auto-generated, then first available
      let track = captions.find(c => c.languageCode === 'ja');
      if (!track) track = captions.find(c => c.languageCode === 'ja' && c.kind === 'asr');
      if (!track) track = captions.find(c => c.kind === 'asr');
      if (!track) track = captions[0];

      const url = track.baseUrl;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`文字起こし取得失敗: ${res.status}`);

      const xml = await res.text();
      return parseTranscriptXML(xml);
    }
  }

  // Fallback: try fetching from the timedtext endpoint directly
  const langs = ['ja', 'en', ''];
  for (const lang of langs) {
    try {
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=srv3`;
      const res = await fetch(url);
      if (res.ok) {
        const xml = await res.text();
        const text = parseTranscriptXML(xml);
        if (text.trim().length > 0) return text;
      }
    } catch (_) {
      // try next language
    }
  }

  throw new Error('この動画では文字起こしが利用できません。字幕が有効な動画でお試しください。');
}

function getPlayerResponse() {
  // Try to access ytInitialPlayerResponse from page scripts
  try {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent;
      if (text.includes('ytInitialPlayerResponse')) {
        const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
        if (match) {
          return JSON.parse(match[1]);
        }
      }
    }
  } catch (_) {
    // ignore parse errors
  }

  // Try window variable directly (may not be accessible from content script)
  return null;
}

function parseTranscriptXML(xml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const texts = doc.querySelectorAll('text');

  if (texts.length === 0) {
    // Try body > p format (srv3)
    const paragraphs = doc.querySelectorAll('body > p');
    if (paragraphs.length > 0) {
      return Array.from(paragraphs)
        .map(p => decodeHTMLEntities(p.textContent.trim()))
        .filter(t => t.length > 0)
        .join('\n');
    }
    return '';
  }

  return Array.from(texts)
    .map(t => decodeHTMLEntities(t.textContent.trim()))
    .filter(t => t.length > 0)
    .join('\n');
}

function decodeHTMLEntities(text) {
  const ta = document.createElement('textarea');
  ta.innerHTML = text;
  return ta.value;
}

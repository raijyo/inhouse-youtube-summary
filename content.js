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
  const params = new URLSearchParams(window.location.search);
  const videoId = params.get('v');
  if (!videoId) {
    throw new Error('動画IDが見つかりません');
  }

  // Strategy 1: Fetch the video page HTML and extract caption tracks
  const captions = await getCaptionTracksFromPage(videoId);
  if (captions && captions.length > 0) {
    // Prefer Japanese, then any auto-generated, then first available
    let track = captions.find(c => c.languageCode === 'ja' && c.kind !== 'asr');
    if (!track) track = captions.find(c => c.languageCode === 'ja');
    if (!track) track = captions.find(c => c.kind === 'asr');
    if (!track) track = captions[0];

    const res = await fetch(track.baseUrl);
    if (!res.ok) throw new Error(`字幕取得失敗: ${res.status}`);

    const xml = await res.text();
    const text = parseTranscriptXML(xml);
    if (text.trim().length > 0) return text;
  }

  // Strategy 2: Try YouTube's innertube transcript API
  const innertubeResult = await tryInnertubeTranscript(videoId);
  if (innertubeResult && innertubeResult.trim().length > 0) {
    return innertubeResult;
  }

  throw new Error('この動画では文字起こしが利用できません。字幕が有効な動画でお試しください。');
}

async function getCaptionTracksFromPage(videoId) {
  try {
    // Re-fetch the video page to get fresh player response data
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      credentials: 'include',
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Extract ytInitialPlayerResponse from the HTML
    const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*var\s/s);
    if (!match) {
      // Try alternative pattern
      const match2 = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
      if (!match2) return null;
      try {
        const data = JSON.parse(match2[1]);
        return data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
      } catch (_) {
        return null;
      }
    }

    const data = JSON.parse(match[1]);
    return data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
  } catch (_) {
    return null;
  }
}

async function tryInnertubeTranscript(videoId) {
  try {
    // Use YouTube's innertube API to get the transcript
    // First we need to get engagement panels info from the page
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      credentials: 'include',
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Extract the serialized share entity for transcript
    // Look for the transcript params in ytInitialData
    const dataMatch = html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script>)/s);
    if (!dataMatch) return null;

    const initialData = JSON.parse(dataMatch[1]);

    // Find transcript panel params
    const params = findTranscriptParams(initialData);
    if (!params) return null;

    // Call the innertube get_transcript endpoint
    const apiKey = extractApiKey(html);
    if (!apiKey) return null;

    const transcriptRes = await fetch(
      `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20240101.00.00',
            },
          },
          params,
        }),
      }
    );

    if (!transcriptRes.ok) return null;

    const transcriptData = await transcriptRes.json();
    return parseInnertubeTranscript(transcriptData);
  } catch (_) {
    return null;
  }
}

function findTranscriptParams(initialData) {
  // Search through engagement panels for transcript
  try {
    const panels = initialData?.engagementPanels || [];
    for (const panel of panels) {
      const content = panel?.engagementPanelSectionListRenderer?.content;
      const transcript = content?.continuationItemRenderer?.continuationEndpoint
        ?.getTranscriptEndpoint?.params;
      if (transcript) return transcript;

      // Alternative path
      const structured = content?.structuredDescriptionContentRenderer?.items;
      if (structured) {
        for (const item of structured) {
          const ep = item?.videoDescriptionTranscriptSectionRenderer
            ?.subHeaderRenderer?.transcriptSubHeaderRenderer
            ?.openTranscriptButton?.buttonRenderer?.command
            ?.getTranscriptEndpoint?.params;
          if (ep) return ep;
        }
      }
    }
  } catch (_) {
    // ignore
  }
  return null;
}

function extractApiKey(html) {
  const match = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function parseInnertubeTranscript(data) {
  try {
    const body = data?.actions?.[0]?.updateEngagementPanelAction
      ?.content?.transcriptRenderer?.body?.transcriptBodyRenderer;
    if (!body) return null;

    const segments = body.cueGroups || [];
    const lines = [];
    for (const group of segments) {
      const cues = group?.transcriptCueGroupRenderer?.cues || [];
      for (const cue of cues) {
        const text = cue?.transcriptCueRenderer?.cue?.simpleText;
        if (text) lines.push(text.trim());
      }
    }
    return lines.filter(l => l.length > 0).join('\n');
  } catch (_) {
    return null;
  }
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

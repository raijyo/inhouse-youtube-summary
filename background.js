/* background.js – Service Worker */

// Ensure content script is injected when navigating YouTube pages
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('youtube.com/watch')) {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    }).catch(() => {
      // Script may already be injected via manifest
    });
  }
});

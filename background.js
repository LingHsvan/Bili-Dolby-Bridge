"use strict";

/*
 * The declarative MAIN-world script can run after Bilibili's stream script
 * on some extension builds. Inject once more as soon as this extension's
 * isolated content script starts; page-bridge.js is idempotent.
 */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "bili-dolby-bridge:inject") {
    if (!sender.tab?.id) return false;
    void chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
        files: ["page-bridge.js"],
        world: "MAIN",
        injectImmediately: true
      })
      .catch(() => {});
    return false;
  }

  if (message?.type === "bili-dolby-bridge:get-tab-status") {
    chrome.tabs.query({ url: "https://www.bilibili.com/video/*" }, (tabs) => {
      const tab = [...tabs].reverse().find((candidate) => candidate.id);
      if (!tab?.id) return false;
      void queryTabStatus(tab.id);
    });
  }

  return false;
});

const queryTabStatus = (tabId) =>
  new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "get-status" }, (status) => {
      if (chrome.runtime.lastError || !status) {
        resolve(null);
        return;
      }
      void chrome.storage.local.set({ ...status, updatedAt: Date.now() });
      resolve(status);
    });
  });

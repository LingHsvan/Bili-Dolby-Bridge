"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true
});

const DEFAULT_STATUS = Object.freeze({
  supportState: "checking",
  lastTrackId: null,
  lastError: null,
  lastEvent: "initial",
  updatedAt: 0
});

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    enabled: stored.enabled !== false
  };
}

async function getStatus() {
  const stored = await chrome.storage.local.get(DEFAULT_STATUS);
  return {
    supportState: stored.supportState || DEFAULT_STATUS.supportState,
    lastTrackId: stored.lastTrackId ?? null,
    lastError: stored.lastError ?? null,
    lastEvent: stored.lastEvent || DEFAULT_STATUS.lastEvent,
    updatedAt: Number(stored.updatedAt) || 0
  };
}

async function saveStatus(patch) {
  const status = { ...(await getStatus()), ...patch };
  await chrome.storage.local.set({
    supportState: status.supportState,
    lastTrackId: status.lastTrackId,
    lastError: status.lastError,
    lastEvent: status.lastEvent,
    updatedAt: Date.now()
  });
  return status;
}

async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ enabled: settings.enabled !== false });
  return settings;
}

globalThis.BiliDolbyBridgeStorage = {
  DEFAULT_SETTINGS,
  DEFAULT_STATUS,
  getSettings,
  getStatus,
  saveStatus,
  saveSettings
};

"use strict";

const labels = {
  checking: "检查中",
  supported: "当前环境支持",
  compatibility: "兼容模式",
  unsupported: "当前环境不支持 E-AC-3",
  available: "等待杜比音源",
  playing: "正在播放杜比音轨",
  "no-dolby": "此视频没有杜比音轨",
  "waiting-player": "等待播放器",
  error: "出现错误"
};

const render = async () => {
  const settings = await BiliDolbyBridgeStorage.getSettings();
  const status = await BiliDolbyBridgeStorage.getStatus();
  document.getElementById("enabled").checked = settings.enabled;
  document.getElementById("state").textContent =
    labels[status.supportState] || status.supportState;
  document.getElementById("track").textContent =
    `音轨：${status.lastTrackId ?? "-"}`;
};

document.getElementById("enabled").addEventListener("change", async (event) => {
  await BiliDolbyBridgeStorage.saveSettings({
    enabled: event.currentTarget.checked
  });
});

document.getElementById("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener(render);
try {
  chrome.runtime.sendMessage({ type: "bili-dolby-bridge:get-tab-status" });
} catch {}
render();

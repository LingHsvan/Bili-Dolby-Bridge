"use strict";

const capabilityText = {
  checking: "检查中",
  supported: "支持",
  compatibility: "兼容模式",
  unsupported: "不支持",
  available: "等待音源",
  playing: "正在播放杜比",
  "no-dolby": "当前视频无杜比音轨",
  "waiting-player": "等待播放器",
  error: "错误"
};

const byId = (id) => document.getElementById(id);

const formatDate = (timestamp) => {
  if (!timestamp) return "-";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "short",
      timeStyle: "medium"
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
};

const render = async () => {
  const settings = await BiliDolbyBridgeStorage.getSettings();
  const status = await BiliDolbyBridgeStorage.getStatus();
  byId("enabled").checked = settings.enabled;

  const capability = byId("capability");
  capability.textContent = capabilityText[status.supportState] || status.supportState;
  capability.className =
    status.supportState === "playing" || status.supportState === "supported"
      ? "good"
      : status.supportState === "unsupported" || status.supportState === "error"
        ? "bad"
        : "";
  byId("track").textContent = status.lastTrackId ?? "-";
  byId("native-support").textContent =
    status.supportState === "compatibility"
      ? "未报告（使用兼容模式）"
      : status.supportState === "supported"
        ? "支持"
        : status.supportState === "checking"
          ? "检查中"
          : "未报告";
  byId("event").textContent = status.lastEvent || "-";
  byId("error").textContent = status.lastError || "-";
  byId("updated").textContent = formatDate(status.updatedAt);
};

byId("enabled").addEventListener("change", async (event) => {
  await BiliDolbyBridgeStorage.saveSettings({
    enabled: event.currentTarget.checked
  });
  render();
});

chrome.storage.onChanged.addListener(render);
try {
  chrome.runtime.sendMessage({ type: "bili-dolby-bridge:get-tab-status" });
} catch {}
render();

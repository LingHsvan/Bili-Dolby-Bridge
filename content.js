(() => {
  "use strict";

  const CHANNEL = "bili-dolby-bridge";
  const TRACK_IDS = new Set([30250, 30255]);
  const PAGE_STATE_TIMEOUT_MS = 600;
  const ACTION_TIMEOUT_MS = 12000;
  const SPA_POLL_MS = 750;
  const PROBE_HOLD_MS = 15000;

  let enabled = true;
  let currentUrl = "";
  let actionInFlight = false;
  let actionKey = "";
  let actionTimer = 0;
  let pageState = null;
  let pageStateResolvers = [];

  try {
    chrome.runtime.sendMessage({ type: "bili-dolby-bridge:inject" });
  } catch {}

  const getPageState = (timeoutMs = PAGE_STATE_TIMEOUT_MS) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        pageStateResolvers = pageStateResolvers.filter((entry) => entry !== done);
        resolve(null);
      }, timeoutMs);

      const done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      pageStateResolvers.push(done);
      window.postMessage({ channel: CHANNEL, type: "state" }, location.origin);
    });

  const post = (type, detail = {}) => {
    window.postMessage({ channel: CHANNEL, type, ...detail }, location.origin);
  };

  const readJsonStorage = (key) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  const writeJsonStorage = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };

  const updateDolbyPreference = (on, quality = null) => {
    const storageKey = "bpx_player_profile";
    const profile = readJsonStorage(storageKey);
    let updated = false;
    if (profile) {
      profile.media = profile.media || {};
      if (on) {
        profile.media.dolbyAudio = true;
        profile.media.audioQuality = 30250;
        if (quality && !profile.media.quality) {
          profile.media.quality = quality;
        }
      } else {
        profile.media.dolbyAudio = false;
        if (Number(profile.media.audioQuality) === 30250) {
          profile.media.audioQuality = null;
        }
      }
      updated = writeJsonStorage(storageKey, profile);
    }

    const legacy = readJsonStorage("bilibili_player_settings");
    if (legacy?.setting_config) {
      legacy.setting_config.dolbyAtmos = on;
      updated =
        writeJsonStorage("bilibili_player_settings", legacy) || updated;
    }
    return updated;
  };

  let lastPersistedStatus = "";
  const persistStatus = async (patch) => {
    try {
      const signature = JSON.stringify(patch);
      if (signature === lastPersistedStatus && !patch.lastTrackId) return;
      lastPersistedStatus = signature;
      await chrome.storage.local.set({ ...patch, updatedAt: Date.now() });
    } catch {}
  };

  const recordStatus = async (patch) => {
    Object.assign(localStatus, patch, { updatedAt: Date.now() });
    await persistStatus(patch);
    refreshUi();
  };

  const isVideoPage = () =>
    /^\/video\/|^\/bangumi\/play\/|^\/cheese\/play\//.test(location.pathname) ||
    /\/x\/player\/(?:wbi\/)?playurl/.test(location.pathname) ||
    Boolean(
      document.querySelector(
        "#bilibili-player, .bpx-player-container, video"
      )
    );

  const getVideo = () =>
    document.querySelector(
      "#bilibili-player video, .bpx-player-container video, video"
    );

  const findDolbyControl = () => {
    const player =
      document.querySelector("#bilibili-player") ||
      document.querySelector(".bpx-player-container");
    if (!player) return null;

    const nativeDolby = player.querySelector(
      '.bpx-player-ctrl-dolby, .bpx-player-ctrl-atmos'
    );
    if (nativeDolby) return nativeDolby;

    const candidates = player.querySelectorAll(
      '[class*="dolby"], [data-title*="杜比"], [title*="杜比"], [aria-label*="杜比"], [data-tooltip*="杜比"]'
    );
    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) continue;
      const label = [
        element.className,
        element.getAttribute("title"),
        element.getAttribute("data-title"),
        element.getAttribute("aria-label"),
        element.getAttribute("data-tooltip"),
        element.textContent
      ]
        .filter(Boolean)
        .join(" ");
      if (/dolby|杜比|全景/i.test(label)) return element;
    }
    return null;
  };

  const controlTitle = (element) =>
    [
      element?.getAttribute?.("data-title"),
      element?.getAttribute?.("title"),
      element?.getAttribute?.("aria-label"),
      element?.getAttribute?.("data-tooltip")
    ]
      .filter(Boolean)
      .join(" ");

  const isDolbyControl = (element) =>
    Boolean(element) &&
    (/dolby|atmos/i.test(String(element.className || "")) ||
      /杜比|全景/i.test(controlTitle(element)));

  const isDolbyEnabled = (element) =>
    isDolbyControl(element) &&
    (/active|opened|checked/i.test(String(element.className || "")) ||
      /关闭.*(?:杜比|全景)|(?:杜比|全景).*关闭/i.test(controlTitle(element)));

  const findAudioEffectControl = () => {
    const player =
      document.querySelector("#bilibili-player") ||
      document.querySelector(".bpx-player-container");
    if (!player) return null;

    const dolby = player.querySelector(
      '.bpx-player-ctrl-dolby, .bpx-player-ctrl-atmos, [class*="dolby" i], [data-title*="杜比"], [title*="杜比"], [aria-label*="杜比"]'
    );
    if (dolby) return dolby;
    return null;
  };

  const parsePlayUrlData = (value) => {
    if (!value || typeof value !== "object") return null;
    const candidates = [
      value,
      value.data,
      value.result,
      value.response,
      value.detail
    ];
    for (const candidate of candidates) {
      const dash = candidate?.dash;
      if (dash?.dolby || dash?.audio) return candidate;
    }
    return null;
  };

  const getPlayUrlRequest = () => {
    try {
      const entries = performance.getEntriesByType("resource");
      return entries
        .map((entry) => entry.name)
        .filter((name) => /\/x\/player\/(?:wbi\/)?playurl/i.test(name))
        .at(-1);
    } catch {
      return null;
    }
  };

  const fetchPlayUrl = async () => {
    const requestUrl = getPlayUrlRequest();
    if (!requestUrl) return null;
    const response = await fetch(requestUrl, {
      credentials: "include"
    });
    if (!response.ok) throw new Error(`playurl HTTP ${response.status}`);
    return response.json();
  };

  const hasDolbyAudio = (response) => {
    const body = parsePlayUrlData(response) || response;
    const dolby = body?.dash?.dolby;
    const audio = Array.isArray(dolby?.audio) ? dolby.audio[0] : null;
    return Number(dolby?.type) === 2
      ? {
          enabled: true,
          trackId: Number(audio?.id) || null
        }
      : {
          enabled: false,
          trackId: null
        };
  };

  const detectTrackFromPerformance = () => {
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const match = entry.name.match(/(?:-|_)(30250|30255)(?:\.m4s|\?|$)/);
        if (match) return Number(match[1]);
      }
    } catch {}
    return null;
  };

  const waitFor = async (predicate, timeoutMs = ACTION_TIMEOUT_MS) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = predicate();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  };

  const detectTrackFromNetwork = async () => {
    const state = pageState || (await getPageState());
    const trackId = Number(state?.lastTrackId);
    return TRACK_IDS.has(trackId) ? trackId : null;
  };

  const clickDolbyControl = async () => {
    const control = await waitFor(findDolbyControl, 6000);
    if (!control) return false;

    const tooltip = [
      control.getAttribute("title"),
      control.getAttribute("data-title"),
      control.getAttribute("aria-label"),
      control.getAttribute("data-tooltip"),
      control.textContent
    ]
      .filter(Boolean)
      .join(" ");

    if (/关闭.*(?:杜比|全景)|(?:杜比|全景).*关闭/i.test(tooltip)) {
      return true;
    }

    control.click();
    updateDolbyPreference(true);
    return true;
  };

  let probeHold = 0;
  const keepProbeAlive = () => {
    if (probeHold > 0) return;
    post("probe-start");
    probeHold = window.setTimeout(() => {
      probeHold = 0;
      post("probe-end");
    }, PROBE_HOLD_MS);
  };

  const localStatus = {
    supportState: "checking",
    lastTrackId: null,
    lastError: null,
    lastEvent: "initial",
    updatedAt: 0
  };

  const attemptEnable = async (key, reason) => {
    if (actionInFlight || !enabled || !isVideoPage()) return;
    if (actionKey === key) return;

    actionInFlight = true;
    actionKey = key;
    clearTimeout(actionTimer);
    actionTimer = window.setTimeout(() => {
      actionInFlight = false;
      actionKey = "";
    }, ACTION_TIMEOUT_MS + 3000);

    keepProbeAlive();
    const state = await getPageState();
    if (state) {
      pageState = state;
      if (state.supportState === "unsupported") {
        await recordStatus({
          supportState: "unsupported",
          lastError: "当前浏览器未报告 E-AC-3 解码能力",
          lastEvent: state.lastEvent
        });
        actionInFlight = false;
        actionKey = "";
        return;
      }
    }

    try {
      const preferenceUpdated = updateDolbyPreference(true, pickNativeQuality());
      await persistStatus({
        supportState:
          state?.supportState === "compatibility"
            ? "compatibility"
            : state?.supportState || "available",
        lastTrackId: null,
        lastError: null,
        lastEvent: preferenceUpdated
          ? `preference-${reason}`
          : `preference-missing-${reason}`
      });
      const player = document.querySelector("#bilibili-player video") || getVideo();
      let playbackStarted = false;
      if (player) {
        const onPlaying = () => {
          playbackStarted = true;
          if (localStatus.lastTrackId != null) {
            localStatus.supportState = "playing";
            localStatus.updatedAt = Date.now();
            void chrome.storage.local.set(localStatus);
            void refreshUi();
          }
        };
        player.addEventListener("playing", onPlaying, { once: true });
        window.setTimeout(() => player.removeEventListener("playing", onPlaying), 8000);
        if (!player.paused && !player.ended && player.readyState >= 2) {
          playbackStarted = true;
        }
      }
      const playUrl = await fetchPlayUrl().catch(() => null);
      if (!playUrl && !player) {
        await recordStatus({
          supportState: "waiting-player",
          lastTrackId: null,
          lastError: null,
          lastEvent: `waiting-${reason}`
        });
        return;
      }
      const dolbyResponse = hasDolbyAudio(playUrl);
      if (playUrl && !dolbyResponse.enabled) {
        await recordStatus({
          supportState: "no-dolby",
          lastTrackId: null,
          lastError: "当前视频未返回杜比音源，请检查大会员权限、版权或地区限制",
          lastEvent: `no-dolby-${reason}`
        });
        return;
      }

      const playerControl = findAudioEffectControl();
      if (playerControl && !isDolbyEnabled(playerControl)) {
        await clickDolbyControl();
      }

      const track = detectTrackFromPerformance();
      if (track) {
        localStatus.supportState = playbackStarted ? "playing" : "available";
        localStatus.lastTrackId = track;
        localStatus.lastError = null;
        localStatus.lastEvent = playbackStarted
          ? `track-${reason}`
          : `dolby-selected-${reason}`;
        localStatus.updatedAt = Date.now();
        await recordStatus({
          supportState: localStatus.supportState,
          lastTrackId: localStatus.lastTrackId,
          lastError: localStatus.lastError,
          lastEvent: localStatus.lastEvent
        });
      } else {
        await recordStatus({
          supportState: dolbyResponse.enabled ? "available" : "waiting-player",
          lastTrackId: null,
          lastError: dolbyResponse.enabled
            ? "Bilibili 已显示杜比按钮，但当前账号未返回 30250；大会员、版权或地区权限可能不足"
            : null,
          lastEvent: dolbyResponse.enabled
            ? `dolby-source-unavailable-${reason}`
            : `waiting-${reason}`
        });
      }
    } catch (error) {
      await recordStatus({
        supportState: "error",
        lastError: String(error?.message || error),
        lastEvent: `error-${reason}`
      });
    } finally {
      actionInFlight = false;
      actionKey = "";
      clearTimeout(actionTimer);
    }
  };

  const refreshUi = async () => {
    const status = await chrome.storage.local.get({
      supportState: "checking",
      lastEvent: "initial",
      updatedAt: 0
    });
    document.documentElement.dataset.biliDolbyBridge =
      status.supportState === "playing" ||
      (TRACK_IDS.has(Number(status.lastTrackId)) &&
        status.supportState === "available")
        ? "active"
        : status.supportState;
    const badge = document.querySelector("[data-bili-dolby-bridge-ui]");
    if (!badge) return;
    const trackId = Number(status.lastTrackId);
    if (status.supportState === "playing" && TRACK_IDS.has(trackId)) {
      badge.textContent = `杜比 ${trackId}`;
      badge.title = "正在播放 Bilibili 杜比音轨";
      badge.dataset.state = "active";
    } else if (status.supportState === "no-dolby") {
      badge.textContent = "无杜比音源";
      badge.title =
        status.lastError || "当前视频未返回杜比音轨";
      badge.dataset.state = "unavailable";
    } else if (status.supportState === "available") {
      badge.textContent = "等待杜比音源";
      badge.title = status.lastError || "播放器已启用，但尚未请求到杜比音轨";
      badge.dataset.state = "waiting";
    } else {
      badge.textContent =
        status.supportState === "waiting-player"
          ? "等待播放器"
          : "杜比未接管";
      badge.title =
        status.lastError ||
        status.lastEvent ||
        "正在等待 Bilibili 播放器";
      badge.dataset.state = "waiting";
    }
  };

  const tick = () => {
    if (!enabled || !isVideoPage()) return;
    const url = location.href;
    const observedTrackId =
      detectTrackFromPerformance() ||
      (TRACK_IDS.has(Number(pageState?.lastTrackId))
        ? Number(pageState.lastTrackId)
        : null);
    if (
      observedTrackId &&
      Number(localStatus.lastTrackId) !== Number(observedTrackId)
    ) {
      localStatus.lastTrackId = Number(observedTrackId);
      localStatus.supportState = "playing";
      localStatus.lastError = null;
      localStatus.lastEvent = "media-track-observed";
      localStatus.updatedAt = Date.now();
      lastPersistedStatus = "";
      void persistStatus({
        supportState: "playing",
        lastTrackId: Number(observedTrackId),
        lastError: null,
        lastEvent: "media-track-observed"
      });
      void refreshUi();
    }
    const hasLoadedTrack = localStatus.lastTrackId != null;
    if (url !== currentUrl) {
      currentUrl = url;
      actionKey = "";
      actionInFlight = false;
      void attemptEnable(`page:${url}`, "page");
    } else if (!hasLoadedTrack) {
      const status = document.documentElement.dataset.biliDolbyBridge;
      if (!["active", "available", "playing"].includes(status)) {
        void attemptEnable(`ready:${url}`, "ready");
      }
    }
  };

  const pickNativeQuality = () => {
    const player =
      document.querySelector("#bilibili-player") ||
      document.querySelector(".bpx-player-container");
    if (!player) return 126;
    const qualityValues = [...player.querySelectorAll("li[data-value]")]
      .map((element) => Number(element.getAttribute("data-value")))
      .filter(Number.isFinite);
    if (qualityValues.includes(126)) return 126;
    if (qualityValues.includes(120)) return 120;
    return 80;
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL) return;

    if (message.type === "state-response") {
      pageState = message.detail || null;
      pageStateResolvers.splice(0).forEach((resolve) => resolve(pageState));
      Object.assign(localStatus, {
        supportState:
          pageState?.capability === "compatibility"
            ? "compatibility"
            : pageState?.supportState === "supported"
              ? "supported"
              : localStatus.supportState,
        lastTrackId: pageState?.lastTrackId ?? localStatus.lastTrackId,
        lastError: pageState?.lastError ?? null,
        lastEvent: pageState?.lastEvent || localStatus.lastEvent,
        updatedAt: Date.now()
      });
      if (pageState?.supportState) {
        lastPersistedStatus = "";
        void persistStatus({
          supportState: pageState.supportState,
          lastTrackId: pageState.lastTrackId,
          lastError: pageState.lastError,
          lastEvent: pageState.lastEvent
        });
      }
    } else if (message.type === "state") {
      pageState = message.detail || pageState;
      pageStateResolvers.splice(0).forEach((resolve) => resolve(pageState));
    }
  });

  window.addEventListener("bili-dolby-bridge:state", (event) => {
    const detail = event.detail;
    if (!detail) return;
    pageState = detail;
    pageStateResolvers.splice(0).forEach((resolve) => resolve(detail));
    Object.assign(localStatus, {
      supportState:
        detail.capability === "compatibility"
          ? "compatibility"
          : localStatus.supportState,
      lastTrackId: detail.lastTrackId ?? localStatus.lastTrackId,
      lastError: detail.lastError ?? null,
      lastEvent: detail.lastEvent || localStatus.lastEvent,
      updatedAt: Date.now()
    });
    if (TRACK_IDS.has(Number(detail.lastTrackId))) {
      lastPersistedStatus = "";
      void persistStatus({
        supportState: detail.capability || "available",
        lastTrackId: Number(detail.lastTrackId),
        lastError: detail.lastError || null,
        lastEvent: detail.lastEvent || "page-state"
      });
    }
  });

  window.addEventListener("bili-dolby-bridge-playurl", (event) => {
    if (event.detail) {
      void persistStatus({
        lastEvent: "playurl-observed",
        lastTrackId:
          event.detail?.dash?.dolby?.audio?.[0]?.id ??
          event.detail?.data?.dash?.dolby?.audio?.[0]?.id ??
          null
      });
    }
  });

  void chrome.storage.local.get({ enabled: true }).then((stored) => {
    enabled = stored.enabled !== false;
    if (enabled && isVideoPage()) {
      const control = findAudioEffectControl();
      if (!isDolbyEnabled(control)) {
        updateDolbyPreference(true, pickNativeQuality());
      }
    }
    tick();
  });

  const setupPageUi = () => {
    if (document.querySelector("[data-bili-dolby-bridge-ui]")) return;
    const badge = document.createElement("button");
    badge.type = "button";
    badge.dataset.biliDolbyBridgeUi = "badge";
    badge.textContent = "杜比未接管";
    badge.setAttribute("aria-label", "Bili Dolby Bridge 状态");
    Object.assign(badge.style, {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      zIndex: "2147483647",
      padding: "6px 10px",
      border: "1px solid #c9d2dd",
      borderRadius: "6px",
      background: "#fff",
      color: "#1b2532",
      font: "600 12px/1.3 system-ui, sans-serif",
      boxShadow: "0 4px 14px #0002",
      cursor: "pointer"
    });
    const onKeyDown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        badge.click();
      }
    };
    badge.addEventListener("keydown", onKeyDown);
    badge.addEventListener("click", () => {
      void chrome.storage.local.set({
        enabled: false,
        lastEvent: "disabled-by-page-button"
      });
      post("probe-end");
      document
        .querySelectorAll("[data-bili-dolby-bridge-ui]")
        .forEach((element) => element.remove());
    });
    document.documentElement.appendChild(badge);
    void refreshUi();
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !("enabled" in changes)) return;
    enabled = changes.enabled.newValue !== false;
    actionKey = "";
    actionInFlight = false;
    if (enabled) {
      tick();
      if (document.readyState !== "loading") setupPageUi();
    }
  });

  document.addEventListener(
    "DOMContentLoaded",
    () => {
      if (enabled && isVideoPage()) setupPageUi();
    },
    { once: true }
  );

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "get-status") return false;
    const merged = { ...localStatus, updatedAt: Date.now() };
    sendResponse(merged);
    void chrome.storage.local.set(merged);
    return false;
  });

  /*
   * The local copy avoids a race where the options page requests status
   * before the storage write caused by the just-finished switch lands.
   */
  void chrome.storage.local.get({
    supportState: "checking",
    lastTrackId: null,
    lastError: null,
    lastEvent: "initial",
    updatedAt: 0
  }).then((status) => {
    Object.assign(localStatus, status);
  });

  /*
   * Keep the bridge's live track information in localStatus immediately.
   */
  new MutationObserver(() => {
    if (enabled) {
      void refreshUi();
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  setInterval(tick, SPA_POLL_MS);
  document.addEventListener("DOMContentLoaded", () => void refreshUi(), {
    once: true
  });
})();

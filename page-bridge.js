/*
 * Runs in the Bilibili page's main world. The only environment changes are
 * bounded browser-capability values used by Bilibili's audio probe.
 */
(() => {
  "use strict";

  const FLAG = "__biliDolbyBridge";
  if (window[FLAG]?.installed) {
    window[FLAG].probeStarted = true;
    window[FLAG].ping?.();
    return;
  }

  const state = {
    installed: true,
    capability: "checking",
    nativeEac3: false,
    edgeProbe: false,
    lastTrackId: null,
    lastError: null,
    lastEvent: "installed",
    updatedAt: Date.now()
  };
  window[FLAG] = state;

  const NativeMediaSource = window.MediaSource;
  const NativeURL = window.URL;
  let probeDepth = 0;
  let probeStarted = false;
  let nativeDolbySupported = false;
  Object.defineProperty(state, "probeStarted", {
    configurable: true,
    enumerable: true,
    get: () => probeStarted,
    set: (value) => {
      probeStarted = Boolean(value);
    }
  });

  const snapshotState = () => ({
    installed: true,
    capability: state.capability,
    supportState: state.capability,
    nativeEac3: Boolean(state.nativeEac3),
    edgeProbe: Boolean(state.edgeProbe),
    lastTrackId: state.lastTrackId,
    lastError: state.lastError,
    lastEvent: state.lastEvent,
    updatedAt: state.updatedAt,
    probeStarted,
    probeDepth
  });

  const notify = () => {
    state.updatedAt = Date.now();
    window.dispatchEvent(
      new CustomEvent("bili-dolby-bridge:state", { detail: snapshotState() })
    );
  };

  const setCapability = (capability, event) => {
    state.capability = capability;
    state.lastEvent = event;
    notify();
  };

  const hasNativeEac3 = () => {
    try {
      return Boolean(
        NativeMediaSource &&
          /^audio\/mp4$/i.test("audio/mp4") &&
          NativeMediaSource.isTypeSupported('audio/mp4; codecs="ec-3"')
      );
    } catch {
      return false;
    }
  };

  nativeDolbySupported = hasNativeEac3();
  state.nativeEac3 = nativeDolbySupported;
  state.edgeProbe = true;

  if (!NativeMediaSource) {
    setCapability("unsupported", "no-mse");
  } else if (!nativeDolbySupported) {
    setCapability("compatibility", "native-eac3-missing");
  } else {
    setCapability("supported", "native-eac3-supported");
  }

  /*
   * Bilibili first checks MediaSource support for E-AC-3, then separately
   * excludes ordinary Chrome by UA. Its getEdgeInfo() looks for the legacy
   * Edge/ token, so expose that token only during the synchronous probe.
   */
  const patchUaProbe = () => {
    const navigatorProto = window.Navigator?.prototype;
    if (!navigatorProto) return;

    const prototypeChain = [];
    for (
      let prototype = navigatorProto;
      prototype && prototype !== Object.prototype;
      prototype = Object.getPrototypeOf(prototype)
    ) {
      prototypeChain.push(prototype);
    }
    const currentDescriptor = prototypeChain
      .map((prototype) =>
        Object.getOwnPropertyDescriptor(prototype, "userAgent")
      )
      .find((descriptor) => descriptor?.get);
    if (currentDescriptor?.get?.__biliDolbyBridgePatched) return;
    const nativeGetter = currentDescriptor.get;
    const patchedGetter = function () {
      const actual = nativeGetter.call(this);
      if (
        (probeDepth > 0 || probeStarted) &&
        /Chrome\//i.test(actual) &&
        !/\bEdge\//i.test(actual)
      ) {
        const withoutChromiumEdge = actual.replace(/\s+Edg\/[\d.]+/i, "");
        return `${withoutChromiumEdge} Edge/${(actual.match(/Chrome\/(\d+)/i) || [])[1] || "157"}.0.0.0`;
      }
      return actual;
    };
    patchedGetter.__biliDolbyBridgePatched = true;
    Object.defineProperty(navigatorProto, "userAgent", {
      configurable: true,
      enumerable: true,
      get: patchedGetter
    });
  };

  const patchMediaSource = () => {
    if (!NativeMediaSource || !window.MediaSource) return;
    const original = NativeMediaSource.isTypeSupported;
    if (typeof original !== "function" || original.__biliDolbyBridgePatched) return;

    const patched = function (type) {
      if (
        (probeDepth > 0 || probeStarted) &&
        typeof type === "string" &&
        /audio\/mp4/i.test(type) &&
        /(?:ec-3|ac-3)/i.test(type)
      ) {
        return true;
      }
      return original.apply(this, arguments);
    };
    patched.__biliDolbyBridgePatched = true;
    NativeMediaSource.isTypeSupported = patched;
  };

  const patchMediaCapabilities = () => {
    const capabilities = window.navigator?.mediaCapabilities;
    if (!capabilities || typeof capabilities.decodingInfo !== "function") return;
    const original = capabilities.decodingInfo;
    if (original.__biliDolbyBridgePatched) return;

    const patched = function (configuration) {
      const type = configuration?.audio?.contentType;
      if (
        (probeDepth > 0 || probeStarted) &&
        typeof type === "string" &&
        /audio\/mp4/i.test(type) &&
        /(?:ec-3|ac-3)/i.test(type)
      ) {
        return Promise.resolve({
          supported: true,
          smooth: true,
          powerEfficient: true
        });
      }
      return original.apply(this, arguments);
    };
    patched.__biliDolbyBridgePatched = true;
    capabilities.decodingInfo = patched;
  };

  patchUaProbe();
  patchMediaSource();
  patchMediaCapabilities();

  /*
   * Bilibili's synchronous Dolby probe runs while parsing each playurl
   * response, before the media element is available. Start a bounded window
   * now so the first request is covered even if isolated-script messaging is
   * delayed. The window is closed after the first media asset request or
   * after a short timeout.
   */
  probeStarted = true;
  window.setTimeout(() => {
    probeStarted = false;
    notify();
  }, 5000);

  /*
   * Bilibili reaches the E-AC-3 check after the manifest has arrived. Keep
   * the compatibility window open while player media starts, but never alter
   * the persistent UA seen by page analytics, requests, or other features.
   */
  const beginProbe = () => {
    probeDepth += 1;
  };
  const endProbe = () => {
    probeDepth = Math.max(0, probeDepth - 1);
  };

  const runProbeWindow = (fn) => {
    state.edgeProbe = true;
    notify();
    beginProbe();
    try {
      return fn?.();
    } finally {
      endProbe();
      state.edgeProbe = false;
      notify();
    }
  };

  state.beginProbe = beginProbe;
  state.endProbe = endProbe;
  state.runProbeWindow = runProbeWindow;
  state.ping = notify;
  state.probeActive = () => probeStarted || probeDepth > 0;

  /*
   * Keep the exact native check for diagnostics. Do not use it to gate the
   * extension: in some Chrome builds MediaSource reports support even when
   * the operating system cannot route the 6-channel stream.
   */
  state.verifyNativeEac3 = hasNativeEac3;
  state.rememberTrack = (trackId, error = null) => {
    if (Number(trackId) === 30251) return;
    state.lastTrackId = trackId == null ? null : Number(trackId);
    state.lastError = error;
    state.lastEvent = error ? "track-error" : "track-observed";
    notify();
  };

  /*
   * The media element is the authoritative signal for verification. Match
   * only the E-AC-3 representation URL and its real player audio track.
   */
  const observeTrackIdFromUrl = (url) => {
    if (typeof url !== "string" || !url) return;
    const match = url.match(/(?:-|_)(30250|30255)(?:\.m4s|\.mp4|\?|$)/);
    if (match) state.rememberTrack(Number(match[1]));
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
        observeTrackIdFromUrl(url);
        if (
          typeof url === "string" &&
          /\.(?:m4s|mp4)(?:\?|$)/i.test(url) &&
          !/\/x\/player\//i.test(url)
        ) {
          probeStarted = false;
        }
      } catch {}
      return originalFetch.apply(this, args);
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      observeTrackIdFromUrl(url);
      if (
        typeof url === "string" &&
        /\.(?:m4s|mp4)(?:\?|$)/i.test(url) &&
        !/\/x\/player\//i.test(url)
      ) {
        probeStarted = false;
      }
    } catch {}
    return originalOpen.call(this, method, url, ...rest);
  };

  if (typeof NativeURL.createObjectURL === "function") {
    const originalCreateObjectUrl = NativeURL.createObjectURL;
    NativeURL.createObjectURL = function (object) {
      try {
        if (object && typeof object.url === "string") {
          observeTrackIdFromUrl(object.url);
        }
      } catch {}
      return originalCreateObjectUrl.apply(this, arguments);
    };
  }

  const observeMedia = () => {
    const video = document.querySelector("video");
    if (!video || video.__biliDolbyBridgeObserved) return;
    video.__biliDolbyBridgeObserved = true;
    video.addEventListener(
      "playing",
      () => {
        probeStarted = false;
        state.lastEvent = "media-playing";
        notify();
      },
      { passive: true }
    );
    video.addEventListener(
      "error",
      () => {
        probeStarted = false;
        state.lastError = video.error?.message || "media-error";
        state.lastEvent = "media-error";
        notify();
      },
      { passive: true }
    );
  };

  const startMediaObserver = () => {
    observeMedia();
    if (document.documentElement) {
      new MutationObserver(observeMedia).observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    } else {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          observeMedia();
          new MutationObserver(observeMedia).observe(document.documentElement, {
            childList: true,
            subtree: true
          });
        },
        { once: true }
      );
    }
  };
  startMediaObserver();

  /*
   * Exposed to the isolated content script. The content script enables the
   * short probe window immediately before native player audio switching.
   */
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== "bili-dolby-bridge") return;

    if (message.type === "state") {
      window.postMessage(
        {
          channel: "bili-dolby-bridge",
          type: "state-response",
          detail: snapshotState()
        },
        location.origin
      );
      return;
    }

    if (message.type === "probe-start") {
      state.edgeProbe = true;
      beginProbe();
      probeStarted = true;
      notify();
    }
    if (message.type === "probe-end") {
      endProbe();
      state.edgeProbe = false;
      notify();
    }
    if (message.type === "remember-track") {
      state.rememberTrack(message.trackId, message.error);
    }
  });

  notify();
})();

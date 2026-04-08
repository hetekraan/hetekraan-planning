(function () {
  function getCookieVal(name) {
    try {
      const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : null;
    } catch (_) {
      return null;
    }
  }

  function setCookieVal(name, value, maxAgeSec) {
    try {
      document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAgeSec}; path=/; SameSite=Strict`;
    } catch (_) {}
  }

  function clearCookieVal(name) {
    try {
      document.cookie = `${name}=; max-age=0; path=/`;
    } catch (_) {}
  }

  function decodeSessionPayload(token) {
    try {
      const rawB64 = String(token || '').split('.')[0];
      if (!rawB64) return null;
      const std = rawB64.replace(/-/g, '+').replace(/_/g, '/');
      const padded = std + '=='.slice(0, (4 - (std.length % 4)) % 4);
      const parts = atob(padded).split('|');
      if (parts.length < 2) return null;
      return { user: parts[0], second: parts[1] };
    } catch (_) {
      return null;
    }
  }

  function getStoredSession(input) {
    const sessionKey = input?.sessionKey;
    const userKey = input?.userKey;
    const readCookie = input?.getCookieVal;
    const decode = input?.decodeSessionPayload;
    const getDateStr = input?.getDateStr;
    if (!sessionKey || !userKey || !readCookie || !decode || !getDateStr) return null;

    let token = null;
    let user = null;
    try {
      token = localStorage.getItem(sessionKey);
      user = localStorage.getItem(userKey);
    } catch (_) {}

    if (!token || !user) {
      token = readCookie(sessionKey);
      user = readCookie(userKey);
      if (token && user) {
        try {
          localStorage.setItem(sessionKey, token);
          localStorage.setItem(userKey, user);
        } catch (_) {}
      }
    }
    if (!token || !user) return null;

    const payload = decode(token);
    if (!payload || payload.user !== user) return null;

    const expiresAt = Number(payload.second);
    if (!Number.isNaN(expiresAt) && expiresAt > 0) {
      if (Date.now() > expiresAt) return null;
      return { user, token };
    }
    const today = getDateStr(new Date());
    if (payload.second !== today) return null;
    return { user, token };
  }

  function hkAuthHeader(input) {
    const sessionKey = input?.sessionKey;
    const readCookie = input?.getCookieVal;
    if (!sessionKey || !readCookie) return '';
    try {
      return localStorage.getItem(sessionKey) || readCookie(sessionKey) || '';
    } catch (_) {
      return '';
    }
  }

  window.HKPlannerAuthSession = {
    getCookieVal,
    setCookieVal,
    clearCookieVal,
    decodeSessionPayload,
    getStoredSession,
    hkAuthHeader,
  };
})();

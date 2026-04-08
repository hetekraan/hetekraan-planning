(function () {
  function isLoginDebugEnabled() {
    try {
      return localStorage.getItem('hk_debug_login') === '1';
    } catch (_) {
      return false;
    }
  }

  function loginDebug(step, payload) {
    if (!isLoginDebugEnabled()) return;
    try {
      console.debug(`[LOGIN_DEBUG] ${step}`, payload || {});
    } catch (_) {}
  }

  function clearLoginState(input) {
    const userKey = input?.userKey;
    const sessionKey = input?.sessionKey;
    const clearCookieVal = input?.clearCookieVal;
    if (!userKey || !sessionKey || !clearCookieVal) return;

    try {
      localStorage.removeItem(userKey);
    } catch (_) {}
    try {
      localStorage.removeItem(sessionKey);
    } catch (_) {}
    try {
      localStorage.removeItem('hk_login_day_amsterdam');
    } catch (_) {}
    try {
      sessionStorage.removeItem(userKey);
    } catch (_) {}
    clearCookieVal(sessionKey);
    clearCookieVal(userKey);
  }

  function logoutPlanning(input) {
    const clearLoginStateFn = input?.clearLoginState;
    if (!clearLoginStateFn) return;
    clearLoginStateFn();
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.classList.remove('hidden');
    const pass = document.getElementById('loginPass');
    if (pass) pass.value = '';
    const error = document.getElementById('loginError');
    if (error) error.classList.remove('visible');
  }

  function checkLogin(input) {
    const getStoredSession = input?.getStoredSession;
    const render = input?.render;
    const loadAppointments = input?.loadAppointments;
    const clearLoginState = input?.clearLoginState;
    if (!getStoredSession || !render || !loadAppointments || !clearLoginState) return;

    const session = getStoredSession();
    loginDebug('checkLogin_session', { hasSession: !!session, user: session?.user || null });
    if (session) {
      const overlay = document.getElementById('loginOverlay');
      if (overlay) overlay.classList.add('hidden');
      render();
      loadAppointments();
      return;
    }
    clearLoginState();
  }

  async function doLogin(input) {
    const userKey = input?.userKey;
    const sessionKey = input?.sessionKey;
    const setCookieVal = input?.setCookieVal;
    const render = input?.render;
    const loadAppointments = input?.loadAppointments;
    if (!userKey || !sessionKey || !setCookieVal || !render || !loadAppointments) return;

    const userEl = document.getElementById('loginUser');
    const passEl = document.getElementById('loginPass');
    const errEl = document.getElementById('loginError');
    const btn = document.querySelector('.btn-login');
    const user = String(userEl?.value || '').trim().toLowerCase();
    const pass = String(passEl?.value || '');
    loginDebug('doLogin_start', { hasUser: !!user, hasPass: !!pass });

    if (btn) btn.disabled = true;
    if (errEl) errEl.classList.remove('visible');

    try {
      const res = await fetch('/api/ghl?action=auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, password: pass }),
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_) {}
      loginDebug('doLogin_response', { status: res.status, ok: res.ok, hasToken: !!data?.token, user: data?.user || null });
      if (res.ok && data?.token) {
        try {
          localStorage.setItem(userKey, data.user);
        } catch (_) {}
        try {
          localStorage.setItem(sessionKey, data.token);
        } catch (_) {}
        setCookieVal(userKey, data.user);
        setCookieVal(sessionKey, data.token);
        const overlay = document.getElementById('loginOverlay');
        if (overlay) overlay.classList.add('hidden');
        render();
        loadAppointments();
        loginDebug('doLogin_success', { storedUser: data.user });
        return;
      }
      const msg =
        res.status >= 500
          ? `Serverfout (${res.status}) — probeer opnieuw of neem contact op met Daan`
          : data?.error || 'Gebruikersnaam of wachtwoord onjuist';
      if (errEl) {
        errEl.textContent = msg;
        errEl.classList.add('visible');
      }
      if (passEl) passEl.value = '';
    } catch (_) {
      loginDebug('doLogin_network_error');
      if (errEl) {
        errEl.textContent = 'Geen verbinding met de server — controleer je internet';
        errEl.classList.add('visible');
      }
      if (passEl) passEl.value = '';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.HKPlannerLogin = {
    clearLoginState,
    logoutPlanning,
    checkLogin,
    doLogin,
  };
})();

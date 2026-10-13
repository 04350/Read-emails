// ==UserScript==
// @name         Read-emails — תצוגת פתיחות בתוך Gmail
// @namespace    https://github.com/04350/Read-emails
// @version      0.1.2
// @description  מציג ליד הודעות שנשלחו אם נפתחו וכמה פעמים, ומוסיף כפתור צד בעברית להצגת זמני פתיחה
// @match        https://mail.google.com/mail/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // יש להגדיר כאן את כתובת ה-Worker ואת אותו DASHBOARD_TOKEN שהוגדר ב-Cloudflare.
  // אין לשמור בקובץ ציבורי את הטוקן האישי; הכנס אותו רק בעותק המקומי ב-Tampermonkey.
  const WORKER_URL = 'PASTE_YOUR_CLOUDFLARE_WORKER_URL_HERE';
  const DASHBOARD_TOKEN = 'PASTE_YOUR_DASHBOARD_TOKEN_HERE';

  const STYLE_ID = 'read-emails-sidebar-styles';
  const BUTTON_ID = 'read-emails-sidebar-button';
  const PANEL_ID = 'read-emails-sidebar-panel';
  const BADGE_ATTR = 'data-read-emails-badge';
  let eventCache = [];
  let lastFetch = 0;
  let fetchInProgress = false;
  // ready = server data loaded; error = server could not be reached (do not falsely claim unopened).
  let eventsState = 'loading';

  const configured = () =>
    WORKER_URL.startsWith('https://') &&
    !WORKER_URL.includes('PASTE_') &&
    DASHBOARD_TOKEN &&
    !DASHBOARD_TOKEN.includes('PASTE_');

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID}{position:fixed;left:12px;top:350px;width:42px;height:42px;border:0;border-radius:50%;margin:0;display:flex;align-items:center;justify-content:center;background:#e8f0fe;color:#174ea6;cursor:pointer;font:700 17px Arial;box-shadow:0 1px 4px #0002;z-index:999998}
      #${BUTTON_ID}:hover{background:#d2e3fc}
      #${PANEL_ID}{position:fixed;top:350px;left:64px;right:auto;width:min(370px,calc(100vw - 100px));max-height:calc(100vh - 24px);overflow:auto;z-index:999999;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:14px;box-shadow:0 8px 32px #0003;padding:16px;direction:rtl;font:14px Arial,sans-serif}
      #${PANEL_ID} *{box-sizing:border-box}
      #${PANEL_ID} .re-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
      #${PANEL_ID} .re-title{font-size:17px;font-weight:700}
      #${PANEL_ID} .re-close{border:0;background:#f1f3f4;border-radius:8px;padding:6px 10px;cursor:pointer}
      #${PANEL_ID} .re-muted{color:#5f6368;line-height:1.5}
      #${PANEL_ID} .re-item{border-top:1px solid #e8eaed;padding:10px 0}
      #${PANEL_ID} .re-item-title{font-weight:700;margin-bottom:5px;overflow-wrap:anywhere}
      #${PANEL_ID} .re-time{font-size:13px;color:#3c4043;margin:4px 0}
      [${BADGE_ATTR}]{display:inline-flex;align-items:center;gap:4px;margin:5px 6px 5px 0;padding:4px 8px;border-radius:6px;border:1px solid #dadce0;background:#f8f9fa;color:#3c4043;font:12px Arial,sans-serif;direction:rtl;vertical-align:middle;position:relative;z-index:2}
      [${BADGE_ATTR}][data-opened="yes"]{background:#e6f4ea;border-color:#ceead6;color:#137333}
    `;
    document.head.appendChild(style);
  }

  function notify(message) {
    let el = document.getElementById('read-emails-sidebar-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'read-emails-sidebar-toast';
      Object.assign(el.style, {
        position: 'fixed', bottom: '20px', right: '20px', zIndex: '1000000',
        background: '#202124', color: '#fff', padding: '11px 15px',
        borderRadius: '9px', boxShadow: '0 4px 18px #0003',
        font: '14px Arial', direction: 'rtl', maxWidth: '340px'
      });
      document.body.appendChild(el);
    }
    el.textContent = message;
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.remove(), 4500);
  }

  function getEvents(force = false) {
    return new Promise((resolve) => {
      if (!configured()) {
        eventsState = 'error';
        resolve({ ok: false, error: 'יש להגדיר WORKER_URL ואת DASHBOARD_TOKEN בקוד הסקריפט.' });
        return;
      }
      if (fetchInProgress) {
        resolve({ ok: true, events: eventCache });
        return;
      }
      if (!force && Date.now() - lastFetch < 30000) {
        resolve({ ok: true, events: eventCache });
        return;
      }
      fetchInProgress = true;
      GM_xmlhttpRequest({
        method: 'GET',
        url: WORKER_URL.replace(/\/$/, '') + '/events',
        headers: { Authorization: 'Bearer ' + DASHBOARD_TOKEN },
        onload: (response) => {
          fetchInProgress = false;
          lastFetch = Date.now();
          if (response.status !== 200) {
            eventsState = 'error';
            resolve({ ok: false, error: 'השרת החזיר שגיאה ' + response.status + '. ייתכן שהגישה נחסמת על ידי הסינון.' });
            return;
          }
          try {
            const data = JSON.parse(response.responseText);
            eventCache = Array.isArray(data.events) ? data.events : [];
            eventsState = 'ready';
            resolve({ ok: true, events: eventCache });
          } catch {
            eventsState = 'error';
            resolve({ ok: false, error: 'התקבלה תשובה לא תקינה מהשרת.' });
          }
        },
        onerror: () => {
          fetchInProgress = false;
          eventsState = 'error';
          resolve({ ok: false, error: 'לא ניתן להתחבר לשרת. בדוק אם הגישה אליו מאושרת.' });
        }
      });
    });
  }

  function extractTrackingId(img) {
    const candidates = ['src', 'data-src', 'data-original-src', 'srcset']
      .map((name) => img.getAttribute(name) || '')
      .filter(Boolean);
    for (const candidate of candidates) {
      let value = candidate;
      for (let i = 0; i < 3; i++) {
        const match = value.match(/(?:\/pixel\?id=|pixel%3fid%3d|pixel%3Fid%3D)([a-f0-9-]{20,80})/i);
        if (match) return match[1];
        try {
          const decoded = decodeURIComponent(value.replace(/&amp;/g, '&'));
          if (decoded === value) break;
          value = decoded;
        } catch { break; }
      }
      try {
        const url = new URL(candidate.split(/\s+/)[0], location.href);
        const id = url.searchParams.get('id');
        if (id && /^[a-f0-9-]{20,80}$/i.test(id)) return id;
      } catch {}
    }
    return null;
  }

  function messageContainer(img) {
    return img.closest('[data-message-id]') ||
      img.closest('.adn') ||
      img.closest('.h7') ||
      img.closest('.gs') ||
      img.closest('[role="listitem"]') ||
      img.parentElement?.parentElement ||
      img.parentElement;
  }

  function renderBadges() {
    // Gmail may proxy or encode remote image URLs, so inspect both direct and encoded attributes.
    document.querySelectorAll('img').forEach((img) => {
      const id = extractTrackingId(img);
      if (!id) return;
      const container = messageContainer(img);
      if (!container) return;
      let badge = container.querySelector('[' + BADGE_ATTR + '="' + id + '"]');
      const count = eventCache.filter((ev) => ev.id === id).length;
      if (!badge) {
        badge = document.createElement('span');
        badge.setAttribute(BADGE_ATTR, id);
        const anchor = img.closest('span') || img.parentElement;
        if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(badge, anchor.nextSibling);
        else container.appendChild(badge);
      }
      const label = eventsState === 'ready'
        ? (count === 0 ? 'לא נפתח' : 'נפתח ' + count)
        : (eventsState === 'error' ? 'לא ניתן לבדוק' : 'בודק…');
      const opened = eventsState === 'ready' && count > 0 ? 'yes' : 'no';
      if (badge.dataset.opened !== opened) badge.dataset.opened = opened;
      if (badge.textContent !== label) badge.textContent = label;
      const title = eventsState === 'ready'
        ? (count ? 'נרשמו ' + count + ' אירועי פתיחה בשרת' : 'לא נרשם אירוע פתיחה בשרת')
        : (eventsState === 'error' ? 'השרת אינו זמין כרגע; אי אפשר לקבוע אם נפתח' : 'ממתין לנתוני השרת');
      if (badge.title !== title) badge.title = title;
    });
  }

  function buildSideButton() {
    if (document.getElementById(BUTTON_ID)) return;
    // Hebrew Gmail is RTL; keep the control on the opposite side, below the top toolbar.
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.title = 'זמני פתיחת מיילים';
    button.setAttribute('aria-label', 'זמני פתיחת מיילים');
    button.textContent = '✓';
    button.addEventListener('click', togglePanel);
    Object.assign(button.style, { position: 'fixed', left: '12px', top: '350px', zIndex: '999998' });
    document.body.appendChild(button);
  }

  function togglePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); return; }
    const panel = document.createElement('aside');
    panel.id = PANEL_ID;
    panel.innerHTML = '<div class="re-head"><div class="re-title">מעקב פתיחת מיילים</div><button class="re-close" type="button">סגירה</button></div><div class="re-muted">טוען את נתוני הפתיחה…</div>';
    panel.querySelector('.re-close').addEventListener('click', () => panel.remove());
    document.body.appendChild(panel);
    getEvents(true).then((result) => {
      if (!panel.isConnected) return;
      panel.querySelector('.re-muted')?.remove();
      if (!result.ok) {
        const message = document.createElement('p');
        message.className = 're-muted';
        message.textContent = result.error;
        panel.appendChild(message);
        return;
      }
      const ids = new Map();
      for (const event of result.events) {
        if (!ids.has(event.id)) ids.set(event.id, []);
        ids.get(event.id).push(event);
      }
      if (!ids.size) {
        const empty = document.createElement('p');
        empty.className = 're-muted';
        empty.textContent = 'עדיין לא נרשמו פתיחות.';
        panel.appendChild(empty);
        return;
      }
      for (const [id, events] of ids) {
        const item = document.createElement('section');
        item.className = 're-item';
        const title = document.createElement('div');
        title.className = 're-item-title';
        title.textContent = 'מזהה הודעה: ' + id;
        item.appendChild(title);
        const count = document.createElement('div');
        count.className = 're-muted';
        count.textContent = 'נרשמו ' + events.length + ' אירועי פתיחה';
        item.appendChild(count);
        events.slice().sort((a, b) => (b.openedAt || '').localeCompare(a.openedAt || '')).forEach((event) => {
          const time = document.createElement('div');
          time.className = 're-time';
          const date = new Date(event.openedAt);
          time.textContent = Number.isNaN(date.getTime()) ? 'זמן לא ידוע' : date.toLocaleString('he-IL');
          item.appendChild(time);
        });
        panel.appendChild(item);
      }
      const note = document.createElement('p');
      note.className = 're-muted';
      note.textContent = 'הערה: סריקות אבטחה ושרתי תמונות עשויים להירשם כפתיחה. הנתונים מוצגים לפי מזהה מעקב.';
      panel.appendChild(note);
    });
  }

  async function refresh() {
    addStyles();
    buildSideButton();
    await getEvents();
    // Render even when the server request fails, so the badge can show 'לא ניתן לבדוק'.
    renderBadges();
  }

  // Gmail redraws its interface dynamically, so re-check the page as it changes.
  const observer = new MutationObserver(() => {
    buildSideButton();
    renderBadges();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  refresh();
  setInterval(refresh, 30000);
})();
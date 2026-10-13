// ==UserScript==
// @name         Read-emails — מעקב פתיחת מיילים ב-Gmail
// @namespace    https://github.com/04350/Read-emails
// @version      0.1.0
// @description  מוסיף פיקסל מעקב למיילים יוצאים ב-Gmail ומציג אירועי פתיחה
// @match        https://mail.google.com/mail/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // אחרי פריסת worker.js, הדבק כאן את כתובת ה-Worker ואת סוד לוח הבקרה.
  const WORKER_URL = 'PASTE_YOUR_CLOUDFLARE_WORKER_URL_HERE'; // e.g. https://read-emails.example.workers.dev
  const DASHBOARD_TOKEN = 'PASTE_YOUR_DASHBOARD_TOKEN_HERE';

  const installed = () => WORKER_URL.startsWith('https://') && !WORKER_URL.includes('PASTE_');
  const tokenReady = () => DASHBOARD_TOKEN && !DASHBOARD_TOKEN.includes('PASTE_');
  const seen = new WeakSet();

  function toast(message) {
    let el = document.getElementById('read-emails-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'read-emails-toast';
      Object.assign(el.style, { position: 'fixed', bottom: '20px', right: '20px', zIndex: '999999', background: '#172554', color: 'white', padding: '12px 16px', borderRadius: '10px', boxShadow: '0 5px 25px #0004', font: '14px Arial', maxWidth: '360px', direction: 'rtl' });
      document.body.appendChild(el);
    }
    el.textContent = message;
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.remove(), 5000);
  }

  function getBodyFromButton(button) {
    const compose = button.closest('[role="dialog"]') || button.closest('form') || document;
    return compose.querySelector('div[aria-label="Message Body"][contenteditable="true"], div[contenteditable="true"][g_editable="true"]');
  }

  function addPixel(body) {
    if (!installed()) { toast('צריך להגדיר תחילה את כתובת Cloudflare Worker בקוד Tampermonkey.'); return; }
    if (!body || body.dataset.readEmailsTracked === '1') return;
    const id = crypto.randomUUID();
    const img = document.createElement('img');
    img.src = WORKER_URL.replace(/\/$/, '') + '/pixel?id=' + encodeURIComponent(id);
    img.width = 1;
    img.height = 1;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.style.cssText = 'width:1px!important;height:1px!important;max-width:1px!important;opacity:0!important;border:0!important;';
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    marker.appendChild(img);
    body.appendChild(marker);
    body.dataset.readEmailsTracked = '1';
    const records = GM_getValue('trackedMessages', []);
    records.push({ id, createdAt: new Date().toISOString() });
    GM_setValue('trackedMessages', records.slice(-1000));
    toast('פיקסל מעקב נוסף למייל. שלח כרגיל.');
  }

  // Hook the Gmail send-button click; use capture phase to add the image before Gmail serializes the message.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('div[role="button"],button');
    if (!button) return;
    const label = ((button.getAttribute('aria-label') || '') + ' ' + (button.innerText || '')).trim().toLowerCase();
    if (!/(^|\b)send\b|שליחה|שלח/.test(label)) return;
    const body = getBodyFromButton(button);
    if (body && body.dataset.readEmailsTracked !== '1') {
      // Avoid interrupting sending; insert synchronously on the same click.
      addPixel(body);
    }
  }, true);

  GM_registerMenuCommand('Read-emails: הצג פתיחות שנרשמו', async () => {
    if (!installed() || !tokenReady()) { toast('הגדר WORKER_URL ואת DASHBOARD_TOKEN בקוד המשתמש.'); return; }
    GM_xmlhttpRequest({
      method: 'GET',
      url: WORKER_URL.replace(/\/$/, '') + '/events',
      headers: { 'Authorization': 'Bearer ' + DASHBOARD_TOKEN },
      onload: (r) => {
        if (r.status !== 200) { toast('לא ניתן לטעון אירועים (HTTP ' + r.status + ').'); return; }
        let data;
        try { data = JSON.parse(r.responseText); } catch { toast('תשובת השרת אינה תקינה.'); return; }
        const local = new Map((GM_getValue('trackedMessages', [])).map(x => [x.id, x]));
        const grouped = new Map();
        for (const ev of data.events || []) {
          if (!grouped.has(ev.id)) grouped.set(ev.id, []);
          grouped.get(ev.id).push(ev);
        }
        const lines = [];
        for (const [id, opens] of grouped) {
          const first = local.get(id);
          lines.push((first ? new Date(first.createdAt).toLocaleString() : 'מייל (מזהה לא מוכר)') + ' — ' + opens.length + ' אירועי פתיחה');
          for (const open of opens.slice(0, 10)) lines.push('   • ' + new Date(open.openedAt).toLocaleString());
        }
        const text = lines.length ? lines.join('\n') : 'עדיין לא נרשמו פתיחות.';
        const w = window.open('', '_blank', 'width=720,height=600');
        if (w) {
          w.document.title = 'Read-emails — פתיחות';
          const pre = w.document.createElement('pre');
          pre.dir = 'rtl';
          pre.style.cssText = 'white-space:pre-wrap;font:15px Arial;padding:20px';
          pre.textContent = text + '\n\nהערה: סריקות אבטחה ושרתי תמונות עשויים להירשם כפתיחה.';
          w.document.body.appendChild(pre);
        } else toast(text.slice(0, 500));
      },
      onerror: () => toast('שגיאת רשת בעת טעינת האירועים.')
    });
  });

  GM_registerMenuCommand('Read-emails: בדיקת הגדרות', () => {
    toast(installed() ? 'כתובת Worker הוגדרה.' : 'עדיין לא הוגדרה כתובת Worker בקוד.');
  });

  toast('Read-emails נטען. מעקב יפעל לאחר הגדרת Cloudflare Worker.');
})();
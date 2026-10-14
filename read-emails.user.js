// ==UserScript==
// @name         Read-emails — מעקב פתיחת מיילים ב-Gmail
// @namespace    https://github.com/04350/Read-emails
// @version      0.1.2
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

  function getComposeFromButton(button) {
    return button.closest('[role="dialog"]') || button.closest('form') || document;
  }

  function getBodyFromButton(button) {
    const compose = getComposeFromButton(button);
    // Gmail's aria-label changes with the interface language, so don't depend on the
    // English "Message Body" label. In a compose dialog the message editor is contenteditable.
    return compose.querySelector(
      'div[contenteditable="true"][g_editable="true"],' +
      'div[aria-label*="Message Body"][contenteditable="true"],' +
      'div[aria-label*="גוף ההודעה"][contenteditable="true"],' +
      'div[contenteditable="true"]'
    );
  }

  function addPixel(body) {
    if (!installed()) { toast('צריך להגדיר תחילה את כתובת Cloudflare Worker בקוד Tampermonkey.'); return; }
    if (!body) { toast('לא מצאתי את אזור כתיבת ההודעה. לא נוסף פיקסל מעקב.'); return; }
    if (body.dataset.readEmailsTracked === '1') { toast('כבר נוסף פיקסל מעקב למייל הזה.'); return; }
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

  // Add the pixel during capture phase, before Gmail serializes the compose body for sending.
  // Support Hebrew and English labels, and clicks on icons nested inside the send button.
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const button = target?.closest('div[role="button"],button,[role="button"]');
    if (!button) return;

    const label = [
      button.getAttribute('aria-label') || '',
      button.getAttribute('data-tooltip') || '',
      button.getAttribute('title') || '',
      button.innerText || ''
    ].join(' ').trim().toLowerCase();

    if (!/(\\bsend\\b|שלח|שליחה)/i.test(label)) return;
    if (!installed()) {
      toast('צריך להגדיר את WORKER_URL בקוד Tampermonkey לפני השליחה.');
      return;
    }

    const body = getBodyFromButton(button);
    if (!body) {
      toast('זיהיתי לחיצה על שליחה, אבל לא מצאתי את גוף ההודעה. לא נוסף פיקסל מעקב.');
      return;
    }

    // Run synchronously on the same click so the image is present before Gmail sends.
    addPixel(body);
  }, true);

  GM_registerMenuCommand('Read-emails: הצג פתיחות שנרשמו', async () => {
    if (!installed() || !tokenReady()) { toast('הגדר WORKER_URL ואת DASHBOARD_TOKEN בקוד המשתמש.'); return; }
    GM_xmlhttpRequest({
      method: 'GET',
      url: WORKER_URL.replace(/\/$/, '') + '/events',
      headers: { 'Authorization': 'Bearer ' + DASHBOARD_TOKEN },
      onload: (r) => {
        if (r.status !== 200) {
          // Include a short, sanitized response preview to help diagnose proxy/filter errors.
          const detail = String(r.responseText || '').replace(/[\\r\\n\\t]+/g, ' ').trim().slice(0, 120);
          toast('לא ניתן לטעון אירועים (HTTP ' + r.status + ')' + (detail ? ': ' + detail : '.'));
          return;
        }
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
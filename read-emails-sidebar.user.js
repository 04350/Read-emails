// ==UserScript==
// @name         Read-emails — תצוגת פתיחות בתוך Gmail
// @namespace    https://github.com/04350/Read-emails
// @version      0.2.4
// @description  סקריפט מאוחד: הוספת פיקסל מעקב והצגת פתיחות בעברית ב-Gmail
// @match        https://mail.google.com/mail/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // יש להגדיר כאן את כתובת ה-Worker ואת אותו DASHBOARD_TOKEN שהוגדר ב-Cloudflare.
  // אין לשמור בקובץ ציבורי את הטוקן האישי; הכנס אותו רק בעותק המקומי ב-Tampermonkey.
  const WORKER_URL = 'https://royal-sun-b560.m67331222.workers.dev';
  const DASHBOARD_TOKEN = 'QWERTYUIOPASDFGHJKLZXCVBNM123456';
  // Tracking pixels only require WORKER_URL. The sidebar's private event panel also requires DASHBOARD_TOKEN.

  const STYLE_ID = 'read-emails-sidebar-styles';
  const BUTTON_ID = 'read-emails-sidebar-button';
  const PANEL_ID = 'read-emails-sidebar-panel';
  const BADGE_ATTR = 'data-read-emails-badge';
  const ROW_BADGE_ATTR = 'data-read-emails-row-badge';
  let eventCache = [];
  let lastFetch = 0;
  let fetchInProgress = false;
  // ready = server data loaded; error = server could not be reached (do not falsely claim unopened).
  let eventsState = 'loading';
  let activeRow = null;
  let activeRecord = null;
  let hoverUpdateCounter = 0;
  const AUTO_SCAN_GRACE_MS = 30 * 1000; // Suppress likely immediate security-scanner fetches.

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
      #${BUTTON_ID}{position:fixed;left:6px;top:400px;width:42px;height:42px;border:0;border-radius:50%;margin:0;display:flex;align-items:center;justify-content:center;background:#e8f0fe;color:#174ea6;cursor:pointer;font:700 17px Arial;box-shadow:0 1px 4px #0002;z-index:999998}
      #${BUTTON_ID}:hover{background:#d2e3fc}
      #${PANEL_ID}{position:fixed;top:400px;left:58px;right:auto;width:min(370px,calc(100vw - 100px));max-height:calc(100vh - 24px);overflow:auto;z-index:999999;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:14px;box-shadow:0 8px 32px #0003;padding:16px;direction:rtl;font:14px Arial,sans-serif}
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
      [${ROW_BADGE_ATTR}]{display:inline-flex;align-items:center;margin:0 8px;padding:3px 7px;border-radius:6px;border:1px solid #dadce0;background:#f8f9fa;color:#3c4043;font:12px Arial,sans-serif;direction:rtl;vertical-align:middle;white-space:nowrap}
      [${ROW_BADGE_ATTR}][data-opened="yes"]{background:#e6f4ea;border-color:#ceead6;color:#137333}
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

  function getTrackedMessages() {
    try {
      const items = GM_getValue('readEmailsSidebarTrackedMessages', []);
      return Array.isArray(items) ? items : [];
    } catch {
      return [];
    }
  }

  function isSentFolder() {
    // The labels and hover panel belong to the sender's Sent view only, never to a recipient's Inbox.
    const hash = String(location.hash || '').toLowerCase();
    return /^#\/?sent(?:\/|$|[?&])/.test(hash) || /^#sent(?:\/|$|[?&])/.test(hash);
  }

  function normalizeSubject(value) {
    return String(value || '')
      .replace(/\s+\(\d+\)$/, '')
      .replace(/^(?:(?:re|fw|fwd):\s*|העברה:\s*|תגובה:\s*)+/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('he-IL');
  }

  function countedEventsForRecord(record) {
    const events = eventCache.filter((ev) => ev.id === record.id);
    const sentAt = Date.parse(record.sentAt || record.createdAt || '');
    if (!Number.isFinite(sentAt)) return events;

    // Only records created at send-time have sentAt. For these, ignore all events
    // earlier than the local send click as well as events in the following 30 seconds.
    // A pixel request can arrive just before the metadata is saved; that negative age
    // is a strong sign of an immediate proxy/scanner fetch, not proof of a human opening.
    if (!record.sentAt) return events; // Legacy records have no trustworthy send-time.
    return events.filter((ev) => {
      const openedAt = Date.parse(ev.openedAt || '');
      if (!Number.isFinite(openedAt)) return false;
      const age = openedAt - sentAt;
      return age >= AUTO_SCAN_GRACE_MS;
    });
  }

  function setBadgeStatus(badge, id) {
    const record = getTrackedMessages().find((item) => item.id === id);
    const count = record
      ? countedEventsForRecord(record).length
      : eventCache.filter((ev) => ev.id === id).length;
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
  }

  function getComposeFromButton(button) {
    return button.closest('[role="dialog"]') || button.closest('form') || document;
  }

  function getBodyFromButton(button) {
    const compose = getComposeFromButton(button);
    // Gmail changes the editor's aria-label by language, so use contenteditable as a fallback.
    return compose.querySelector(
      'div[contenteditable="true"][g_editable="true"],' +
      'div[aria-label*="Message Body"][contenteditable="true"],' +
      'div[aria-label*="גוף ההודעה"][contenteditable="true"],' +
      'div[contenteditable="true"]'
    );
  }

  function readRecipients(compose) {
    const values = [...compose.querySelectorAll(
      '[name="to"] [email],[name="to"] [data-hovercard-id],[name="to"] input,[name="to"]'
    )].map((el) =>
      el.getAttribute('email') ||
      el.getAttribute('data-hovercard-id') ||
      el.getAttribute('data-email') ||
      el.value ||
      ''
    );
    return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  }

  function makeTrackingId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
      return (char === 'x' ? random : (random & 3) | 8).toString(16);
    });
  }

  function addPixelAndSaveMessage(button) {
    const workerReady = WORKER_URL.startsWith('https://') && !WORKER_URL.includes('PASTE_');
    if (!workerReady) {
      notify('צריך להגדיר את WORKER_URL בקוד של הסקריפט החדש לפני השליחה.');
      return;
    }

    const compose = getComposeFromButton(button);
    const body = getBodyFromButton(button);
    if (!body) {
      notify('זיהיתי לחיצה על שליחה, אבל לא מצאתי את גוף ההודעה. לא נוסף פיקסל מעקב.');
      return;
    }
    if (body.dataset.readEmailsTracked === '1') return;

    const id = makeTrackingId();
    const img = document.createElement('img');
    img.src = WORKER_URL.replace(/\/+$/, '') + '/pixel?id=' + encodeURIComponent(id);
    img.width = 1;
    img.height = 1;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.setAttribute('data-read-emails-pixel', id);
    img.style.cssText = 'width:1px!important;height:1px!important;max-width:1px!important;max-height:1px!important;opacity:0!important;border:0!important;';

    const marker = document.createElement('span');
    marker.setAttribute('data-read-emails-marker', id);
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = '\u200b';
    marker.appendChild(img);
    body.appendChild(marker);
    body.dataset.readEmailsTracked = '1';

    const subjectInput = compose.querySelector(
      'input[name="subjectbox"],input[placeholder*="נושא"],input[placeholder*="Subject"]'
    );
    const subject = String(subjectInput?.value || '').trim() || '(ללא נושא)';
    const recipients = readRecipients(compose);
    const sentAt = new Date().toISOString();
    const record = {
      id,
      subject,
      recipients,
      createdAt: sentAt,
      sentAt
    };

    try {
      const records = getTrackedMessages().filter((item) => item.id !== id);
      records.push(record);
      GM_setValue('readEmailsSidebarTrackedMessages', records.slice(-1000));
      // Keep compatibility with the old script's local key, without requiring the old script to run.
      const legacy = GM_getValue('trackedMessages', []);
      legacy.push({ id, createdAt: record.createdAt });
      GM_setValue('trackedMessages', legacy.slice(-1000));
    } catch {}

    notify('פיקסל מעקב נוסף למייל. שלח כרגיל.');
    renderListBadges();
  }

  function findSendControl(target) {
    let node = target;
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      if (node.matches?.('[role="dialog"],form')) break;

      const isInteractive = node.matches?.('button,[role="button"],[data-tooltip],[aria-label],[title],.T-I-atl');
      if (!isInteractive) continue;

      const label = [
        node.getAttribute('aria-label') || '',
        node.getAttribute('data-tooltip') || '',
        node.getAttribute('title') || '',
        node.getAttribute('data-testid') || '',
        node.innerText || '',
        node.textContent || '',
        typeof node.className === 'string' ? node.className : ''
      ].join(' ').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().toLowerCase();

      if (/(send|שלח|שליחה|שליחת הודעה)/i.test(label)) return node;
      // Gmail's main send button commonly retains this class even if it has no readable label.
      if (node.classList?.contains('T-I-atl')) return node;
    }
    return null;
  }

  function handleSendAttempt(target) {
    const sendControl = findSendControl(target);
    if (!sendControl) return false;

    const compose = getComposeFromButton(sendControl);
    const body = getBodyFromButton(sendControl);
    if (!body) {
      notify('זיהיתי את כפתור השליחה, אבל לא מצאתי את גוף ההודעה. לא נוסף פיקסל מעקב.');
      return true;
    }
    if (body.dataset.readEmailsTracked === '1') {
      notify('כבר קיים פיקסל מעקב בטיוטה הזו. אם זו טיוטה שנוצרה לפני העדכון, פתח הודעה חדשה לבדיקה.');
      return true;
    }

    addPixelAndSaveMessage(sendControl);
    return true;
  }

  function hookSendClicks() {
    // Try to add the tracking pixel before Gmail processes the send click.
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (target) handleSendAttempt(target);
    }, true);

    // Also support Gmail's Ctrl+Enter shortcut. The key event target is the editor,
    // not the send button, so add the pixel directly to that compose draft.
    document.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return;
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const editor = target?.closest?.('[contenteditable="true"]');
      if (!editor) return;

      const compose = editor.closest('[role="dialog"]') || editor.closest('form');
      if (!compose) {
        notify('קלטתי Ctrl+Enter, אבל לא מצאתי את חלון כתיבת המייל. לא נוסף פיקסל.');
        return;
      }
      // Use the editor as context; getComposeFromButton will resolve the surrounding compose dialog.
      addPixelAndSaveMessage(editor);
    }, true);
  }

  function rowSubjectNode(row) {
    return row.querySelector('.bog, .bqe, [data-thread-id] .bog, .y6 span');
  }

  function recordForRow(row) {
    const subjectNode = rowSubjectNode(row);
    if (!subjectNode) return null;
    const subject = normalizeSubject(subjectNode.textContent || subjectNode.innerText);
    if (!subject) return null;

    const candidates = getTrackedMessages().filter((item) => normalizeSubject(item.subject) === subject);
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    const rowText = String(row.innerText || row.textContent || '').toLocaleLowerCase('he-IL');
    const byRecipient = candidates.filter((item) =>
      (item.recipients || []).some((recipient) =>
        recipient && rowText.includes(String(recipient).toLocaleLowerCase('he-IL'))
      )
    );
    if (byRecipient.length === 1) return byRecipient[0];
    if (byRecipient.length > 1) return byRecipient.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
    return null;
  }

  function renderListBadges() {
    if (!isSentFolder()) {
      document.querySelectorAll('[' + ROW_BADGE_ATTR + ']').forEach((badge) => badge.remove());
      return;
    }
    document.querySelectorAll('tr.zA').forEach((row) => {
      const subjectNode = rowSubjectNode(row);
      if (!subjectNode) return;
      const record = recordForRow(row);
      let badge = row.querySelector('[' + ROW_BADGE_ATTR + ']');

      if (!record) {
        if (badge && !getTrackedMessages().some((item) => normalizeSubject(item.subject) === normalizeSubject(subjectNode.textContent || subjectNode.innerText))) {
          badge.remove();
        }
        return;
      }

      if (!badge) {
        badge = document.createElement('span');
        badge.setAttribute(ROW_BADGE_ATTR, record.id);
        subjectNode.insertAdjacentElement('afterend', badge);
      } else if (badge.getAttribute(ROW_BADGE_ATTR) !== record.id) {
        badge.setAttribute(ROW_BADGE_ATTR, record.id);
      }
      setBadgeStatus(badge, record.id);
    });
  }

  function createPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('aside');
    panel.id = PANEL_ID;
    panel.innerHTML = '<div class="re-head"><div class="re-title">מעקב פתיחת מיילים</div><button class="re-close" type="button">סגירה</button></div><div class="re-muted">העבר את העכבר מעל הודעה שנשלחה כדי לראות את נתוני הפתיחה שלה.</div>';
    panel.querySelector('.re-close').addEventListener('click', () => panel.remove());
    document.body.appendChild(panel);
    return panel;
  }

  function renderContextForRow(row, autoOpen = true) {
    if (!isSentFolder()) return;
    activeRow = row;
    const record = recordForRow(row);
    if (!record) {
      activeRecord = null;
      const currentPanel = document.getElementById(PANEL_ID);
      if (currentPanel && !autoOpen) {
        currentPanel.querySelector('.re-muted')?.remove();
        const message = document.createElement('p');
        message.className = 're-muted';
        message.textContent = 'לא נמצאו פרטי מעקב למייל הזה. ודא שנשלח עם פיקסל מעקב; אם נושא המייל חוזר על עצמו, ייתכן שלא ניתן לזהותו בוודאות.';
        currentPanel.appendChild(message);
      }
      return;
    }
    activeRecord = record;
    const panel = document.getElementById(PANEL_ID) || (autoOpen ? createPanel() : null);
    if (!panel) return;
    renderContextRecord(panel, record);
  }

  function renderContextRecord(panel, record, forceFetch = false) {
    const requestId = ++hoverUpdateCounter;
    panel.replaceChildren();

    const head = document.createElement('div');
    head.className = 're-head';
    const title = document.createElement('div');
    title.className = 're-title';
    title.textContent = 'פרטי פתיחה';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 're-close';
    close.textContent = 'סגירה';
    close.addEventListener('click', () => panel.remove());
    head.append(title, close);
    panel.appendChild(head);

    const subject = document.createElement('div');
    subject.className = 're-item-title';
    subject.textContent = record.subject || 'מייל שנשלח';
    panel.appendChild(subject);

    const status = document.createElement('p');
    status.className = 're-muted';
    status.textContent = eventsState === 'ready' ? 'מחשב נתוני פתיחה…' :
      (eventsState === 'error' ? 'לא ניתן להתחבר כרגע לשרת כדי לבדוק פתיחות.' : 'טוען נתוני פתיחה…');
    panel.appendChild(status);

    getEvents(forceFetch).then((result) => {
      if (!panel.isConnected || requestId !== hoverUpdateCounter) return;
      status.remove();

      if (!result.ok) {
        const error = document.createElement('p');
        error.className = 're-muted';
        error.textContent = result.error;
        panel.appendChild(error);
        return;
      }

      const allEvents = eventCache.filter((event) => event.id === record.id);
      const opens = countedEventsForRecord(record)
        .sort((a, b) => (b.openedAt || '').localeCompare(a.openedAt || ''));
      const count = document.createElement('p');
      count.className = 're-muted';
      count.textContent = opens.length === 0 ? 'לא נרשמה פתיחה' : 'נפתח ' + opens.length;
      panel.appendChild(count);

      // Diagnostics distinguish "no pixel request reached the server" from "a hit was filtered".
      const diagnostics = document.createElement('p');
      diagnostics.className = 're-muted';
      if (allEvents.length > 0 && opens.length === 0) {
        diagnostics.textContent = 'השרת קיבל ' + allEvents.length + ' בקשות לתמונה, אך כולן סוננו כי נרשמו לפני תום 30 שניות ההמתנה. אם פתחת את המייל אחרי דקה, צריך לבדוק אם נשלחה בקשת תמונה חדשה.';
      } else {
        diagnostics.textContent = 'בקשות תמונת מעקב שנרשמו בשרת: ' + allEvents.length + ' · אירועים שנספרו כפתיחה: ' + opens.length;
      }
      panel.appendChild(diagnostics);

      if (opens.length) {
        const label = document.createElement('div');
        label.className = 're-muted';
        label.textContent = 'זמני הפתיחה שנרשמו:';
        panel.appendChild(label);
        opens.slice(0, 12).forEach((event) => {
          const line = document.createElement('div');
          line.className = 're-time';
          const date = new Date(event.openedAt);
          line.textContent = Number.isNaN(date.getTime()) ? 'זמן לא ידוע' : date.toLocaleString('he-IL');
          panel.appendChild(line);
        });
      }
      const note = document.createElement('p');
      note.className = 're-muted';
      note.textContent = 'בקשות שנרשמו ב־30 השניות הראשונות אחרי השליחה אינן נספרות, כדי לצמצם סימוני פתיחה אוטומטיים. סריקות מאוחרות יותר עדיין עלולות להירשם.';
      panel.appendChild(note);
    });
  }

  function attachRowHover() {
    document.addEventListener('mouseover', (event) => {
      if (!isSentFolder()) return;
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const row = target?.closest('tr.zA');
      if (!row || row === activeRow) return;
      activeRow = row;
      const record = recordForRow(row);

      if (record) {
        renderContextForRow(row, true);
        return;
      }

      activeRecord = null;
      const panel = document.getElementById(PANEL_ID);
      if (panel) {
        panel.replaceChildren();
        const head = document.createElement('div');
        head.className = 're-head';
        const title = document.createElement('div');
        title.className = 're-title';
        title.textContent = 'פרטי פתיחה';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 're-close';
        close.textContent = 'סגירה';
        close.addEventListener('click', () => panel.remove());
        head.append(title, close);
        panel.appendChild(head);
        const message = document.createElement('p');
        message.className = 're-muted';
        message.textContent = 'לא נמצא מעקב עבור המייל הזה, או שנושא המייל אינו חד־משמעי.';
        panel.appendChild(message);
      }
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

  function rememberVisibleTrackedMessage(id) {
    if (!isSentFolder()) return; // Never collect/display sender-side status while viewing received mail.
    const known = getTrackedMessages();
    const subjectNode = document.querySelector('h2.hP, h2[data-thread-perm-id]');
    const subject = String(subjectNode?.textContent || subjectNode?.innerText || '').trim();
    if (!subject) return;
    const existing = known.find((item) => item.id === id);
    if (existing) {
      // Repair older records missing the subject, without changing their original sent date.
      if (!existing.subject) {
        existing.subject = subject;
        try { GM_setValue('readEmailsSidebarTrackedMessages', known); } catch {}
      }
      return;
    }
    const record = { id, subject, recipients: [], createdAt: new Date().toISOString() };
    try { GM_setValue('readEmailsSidebarTrackedMessages', [...known, record].slice(-1000)); } catch {}
  }

  function captureOpenSentThread() {
    if (!isSentFolder()) return;
    const subjectNode = document.querySelector('h2.hP, h2[data-thread-perm-id]');
    if (!subjectNode) return;
    // Save the subject-to-ID link locally only when the sender opens their Sent copy.
    document.querySelectorAll('img').forEach((img) => {
      const id = extractTrackingId(img);
      if (id) rememberVisibleTrackedMessage(id);
    });
  }

  function getOpenSentRecord() {
    if (!isSentFolder()) return null;
    const subjectNode = document.querySelector('h2.hP, h2[data-thread-perm-id]');
    const subject = normalizeSubject(subjectNode?.textContent || subjectNode?.innerText || '');
    if (!subject) return null;

    const tracked = getTrackedMessages();
    const visibleIds = new Set();
    document.querySelectorAll('img').forEach((img) => {
      const id = extractTrackingId(img);
      if (id) visibleIds.add(id);
    });
    const directMatch = tracked.find((item) => visibleIds.has(item.id));
    if (directMatch) return directMatch;

    const subjectMatches = tracked.filter((item) => normalizeSubject(item.subject) === subject);
    return subjectMatches.length === 1 ? subjectMatches[0] : null;
  }

  function updatePanelForOpenMessage(refreshSameRecord = false) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !isSentFolder()) return;
    const record = getOpenSentRecord();
    if (record && (activeRecord?.id !== record.id || refreshSameRecord)) {
      activeRow = null;
      activeRecord = record;
      renderContextRecord(panel, record, false);
    }
  }

  function renderBadges() {
    // Intentionally do not add badges inside the message body. The recipient may also run
    // this userscript; status labels are rendered only on the sender's Sent-mail rows.
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
    Object.assign(button.style, { position: 'fixed', left: '6px', top: '400px', zIndex: '999998' });
    document.body.appendChild(button);
  }

  function togglePanel() {
    if (!isSentFolder()) {
      const oldPanel = document.getElementById(PANEL_ID);
      if (oldPanel) oldPanel.remove();
      const panel = createPanel();
      panel.replaceChildren();
      const head = document.createElement('div');
      head.className = 're-head';
      const title = document.createElement('div');
      title.className = 're-title';
      title.textContent = 'מעקב פתיחת מיילים';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 're-close';
      close.textContent = 'סגירה';
      close.addEventListener('click', () => panel.remove());
      head.append(title, close);
      panel.appendChild(head);
      const message = document.createElement('p');
      message.className = 're-muted';
      message.textContent = 'נתוני מעקב מוצגים רק בתיקיית "נשלח", אצל מי ששלח את המייל.';
      panel.appendChild(message);
      return;
    }
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      existing.remove();
      return;
    }
    const panel = createPanel();
    const record = getOpenSentRecord();
    if (record) {
      activeRecord = record;
      activeRow = null;
      renderContextRecord(panel, record, true);
    } else {
      const message = panel.querySelector('.re-muted');
      if (message) message.textContent = 'פתח מייל מתוך תיקיית „נשלח” כדי לראות כאן את מספר הפתיחות ואת הזמנים שלו.';
    }
  }

  async function refresh() {
    addStyles();
    buildSideButton();
    await getEvents();
    // Render even when the server request fails, so the badge can show 'לא ניתן לבדוק'.
    captureOpenSentThread();
    renderListBadges();
    updatePanelForOpenMessage(true);
  }

  // Gmail redraws its interface dynamically, so re-check the page as it changes.
  const observer = new MutationObserver(() => {
    buildSideButton();
    captureOpenSentThread();
    renderListBadges();
    updatePanelForOpenMessage();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  hookSendClicks();
  refresh();
  setInterval(refresh, 30000);
  notify(
    WORKER_URL.startsWith('https://') && !WORKER_URL.includes('PASTE_')
      ? 'סקריפט Read-emails המאוחד נטען. אפשר לשלוח מייל בדיקה.'
      : 'סקריפט Read-emails נטען, אבל צריך להגדיר WORKER_URL בקוד.'
  );
})();

# Read-emails — מעקב פתיחת מיילים ב-Gmail (Tampermonkey)

מימוש ראשוני וחינמי: userscript ל-Gmail + Cloudflare Worker + Workers KV. לא נדרשת פרסום בחנות Chrome. אין צורך בשרת בתשלום, אך נדרשת הגדרה חד-פעמית בחשבון Cloudflare.

## מה עובד בפועל
- Tampermonkey מריץ סקריפט בתוך Gmail.
- בזמן לחיצה על Send, הסקריפט מנסה להוסיף פיקסל 1×1 למייל היוצא.
- כאשר תוכנת הדואר של הנמען טוענת את התמונה, ה-Worker רושם אירוע עם זמן UTC.
- דרך תפריט Tampermonkey אפשר לראות אירועי פתיחה שנרשמו.

## מגבלות חשובות
- אין אפשרות להבטיח זיהוי בכל מייל: Gmail או שירות הנמען עשויים להסיר תמונות, לחסום אותן או לטעון אותן דרך שרת proxy.
- מערכות אבטחה עשויות לטעון תמונות אוטומטית ולכן להיראות כפתיחה גם אם הנמען לא קרא את המייל.
- זיהוי לפי פיקסל אינו הוכחה שאדם קרא את ההודעה.
- סקריפט ה-DOM של Gmail עשוי להצריך התאמה אם Google משנה את ממשק השליחה. יש לבדוק תחילה עם מייל ניסוי.
- המימוש אינו עוקף חסימת תמונות או הגנות פרטיות.
- שמות הנמענים ותוכן המייל אינם נשמרים בשרת; נשמרים מזהה אקראי, חותמת זמן ו-user-agent מקוצר.

## התקנה והגדרה

### 1. צור Worker חינמי ב-Cloudflare
1. היכנס לחשבון Cloudflare.
2. פתח Workers & Pages וצור Worker חדש, למשל `read-emails`.
3. העתק את כל הקוד שבקובץ `worker.js` לעורך ה-Worker ושמור/פרוס אותו.
4. תחת Bindings הוסף Workers KV namespace בשם **TRACKING_KV** וחבר אותו ל-Worker.
5. תחת Settings → Variables and Secrets הוסף secret בשם **DASHBOARD_TOKEN**. השתמש במחרוזת אקראית ארוכה (לפחות 32 תווים); שמור אותה בסוד.
6. פרוס מחדש ובדוק שכתובת `https://YOUR-WORKER.workers.dev/health` מחזירה JSON שבו `kv` ו-`tokenConfigured` הם `true`.

### 2. התקן את Tampermonkey userscript
1. התקן את תוסף Tampermonkey בדפדפן.
2. צור סקריפט חדש והעתק אליו את הקובץ `read-emails.user.js`.
3. בראש הסקריפט, החלף את `PASTE_YOUR_CLOUDFLARE_WORKER_URL_HERE` בכתובת ה-Worker שלך.
4. החלף את `PASTE_YOUR_DASHBOARD_TOKEN_HERE` באותו secret שהגדרת ב-Cloudflare.
5. שמור ורענן את Gmail.

### 3. בדיקה
שלח לעצמך מייל ניסוי לכתובת אחרת או לחשבון אחר, פתח אותו ואפשר טעינת תמונות. בתפריט Tampermonkey בחר **Read-emails: הצג פתיחות שנרשמו**.

## קבצים
- `read-emails.user.js` — סקריפט Tampermonkey
- `worker.js` — endpoint לרישום פתיחות
- `wrangler.toml` — דוגמת תצורה לפריסה עם Wrangler

## פרטיות ואבטחה
אל תפרסם את DASHBOARD_TOKEN ואל תשתף את הקוד המוגדר שלך. אם המאגר פרטי, קישורי התקנה ציבוריים/אוטומטיים לא יהיו זמינים לכל אחד. אין צורך להפוך את המאגר לציבורי כדי להעתיק את הקוד ידנית.

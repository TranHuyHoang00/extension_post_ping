// PostPing – service worker
// Mỗi tab có trạng thái riêng trong chrome.storage.session (key `tab_<tabId>`),
// alarm riêng (`check_<tabId>`). Cấu hình (từ khóa, tần suất) lưu lâu dài theo
// group trong chrome.storage.local (key `cfg_<groupId>`).

const SEEN_LIMIT = 3000;
const LOG_LIMIT = 500;
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 1440;
const PENDING_TIMEOUT_MS = 90 * 1000;
const MAX_COMMENTS_PER_CHECK = 3;

const RESERVED_GROUP_PATHS = new Set([
  'feed', 'discover', 'joins', 'create', 'notifications', 'search', 'you', 'requests', 'learn'
]);

const stateKey = (tabId) => `tab_${tabId}`;
const alarmName = (tabId) => `check_${tabId}`;
const cfgKey = (groupId) => `cfg_${groupId}`;

// ---------- Helpers ----------

function parseGroup(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)facebook\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/groups\/([^/]+)\/?(.*)$/);
    if (!m) return null;
    const groupId = decodeURIComponent(m[1]);
    if (RESERVED_GROUP_PATHS.has(groupId.toLowerCase())) return null;
    const rest = m[2].replace(/\/+$/, '');
    return { groupId, isFeed: rest === '' };
  } catch {
    return null;
  }
}

function feedUrl(groupId) {
  return `https://www.facebook.com/groups/${encodeURIComponent(groupId)}/?sorting_setting=CHRONOLOGICAL`;
}

function cleanTitle(title) {
  return (title || '').replace(/^\(\d+\+?\)\s*/, '').replace(/\s*\|\s*Facebook\s*$/i, '').trim();
}

// Bỏ dấu, chữ thường: "Căn Hộ" -> "can ho"
function normalize(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function parseKeywords(raw) {
  return (raw || '')
    .split(/[,\n;]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

// ---------- IndexedDB: các bài đã bình luận ----------

const DB_NAME = 'postping';
const COMMENTED_STORE = 'commented';
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(COMMENTED_STORE, { keyPath: 'key' });
        store.createIndex('time', 'time');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

// Khóa chống trùng của một bài. ID thật (p_) là duy nhất toàn Facebook;
// khóa hash (h_) gắn thêm group để hai group khác nhau không đè lên nhau.
function commentKeys(groupId, post) {
  return post.keys.map((k) => (k.startsWith('p_') ? k : `${groupId}|${k}`));
}

// Giữ chỗ nguyên tử: false nếu BẤT KỲ khóa nào đã có, ngược lại ghi tất cả và trả true.
async function claimKeys(keys) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COMMENTED_STORE, 'readwrite');
    const store = tx.objectStore(COMMENTED_STORE);
    let dup = false;
    let pending = keys.length;
    keys.forEach((k) => {
      const r = store.get(k);
      r.onsuccess = () => {
        if (r.result) dup = true;
        if (--pending === 0 && !dup) {
          const now = Date.now();
          keys.forEach((kk) => store.put({ key: kk, time: now }));
        }
      };
    });
    tx.oncomplete = () => resolve(!dup);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

async function clearCommented() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(COMMENTED_STORE, 'readwrite');
    tx.objectStore(COMMENTED_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

// Comment thử vào bài đầu tiên trên feed của tab (không ghi vào lịch sử).
async function testComment(tabId, text) {
  if (!text) throw new Error('Chưa có nội dung bình luận.');
  let r;
  try {
    r = await chrome.tabs.sendMessage(tabId, { type: 'testComment', text });
  } catch {
    throw new Error('Không kết nối được trang. Hãy tải lại tab Facebook rồi thử lại.');
  }
  if (!r || !r.ok) throw new Error((r && r.error) || 'Không comment được.');
  return { message: `Đã comment thử vào bài ${r.author}: "${text}"` };
}

// Xóa các bản ghi cũ hơn `hours` giờ. hours = 0: không tự xóa.
async function purgeCommented(hours) {
  if (!(hours > 0)) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(COMMENTED_STORE, 'readwrite');
    const range = IDBKeyRange.upperBound(Date.now() - hours * 3600 * 1000);
    const req = tx.objectStore(COMMENTED_STORE).index('time').openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        cur.delete();
        cur.continue();
      }
    };
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

// Mỗi dòng là một bình luận.
function parseComments(raw) {
  return (raw || '')
    .split('\n')
    .map((c) => c.trim())
    .filter(Boolean);
}

function matchKeywords(text, keywords) {
  const hay = normalize(text);
  return keywords.filter((k) => {
    const needle = normalize(k).trim();
    return needle && hay.includes(needle);
  });
}

function makeLog(entry) {
  return { id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, time: Date.now(), ...entry };
}

function pushLog(st, entry) {
  st.logs.push(makeLog(entry));
  if (st.logs.length > LOG_LIMIT) st.logs.splice(0, st.logs.length - LOG_LIMIT);
}

function freshState(tabId) {
  return {
    tabId,
    groupId: null,
    groupTitle: '',
    running: false,
    keywords: '',
    comments: '',
    maxAgeMin: 0,
    clearHours: 0,
    delayMin: 0,
    delayMax: 0,
    busyUntil: 0,
    intervalMin: 5,
    baseline: true,
    pending: false,
    pendingSince: 0,
    seen: [],
    logs: [],
    lastCheck: null,
    nextCheck: null,
    stats: { checks: 0, newPosts: 0, commented: 0 }
  };
}

// Cập nhật trạng thái tuần tự theo từng tab để tránh ghi đè lẫn nhau.
const locks = new Map();
function updateTab(tabId, mutator) {
  const key = stateKey(tabId);
  const run = async () => {
    const cur = (await chrome.storage.session.get(key))[key] || null;
    const next = await mutator(cur);
    if (next === undefined) return cur;
    if (next === null) {
      await chrome.storage.session.remove(key);
      return null;
    }
    await chrome.storage.session.set({ [key]: next });
    return next;
  };
  const p = (locks.get(tabId) || Promise.resolve()).then(run, run);
  locks.set(tabId, p.catch(() => {}));
  return p;
}

async function getTabState(tabId) {
  const key = stateKey(tabId);
  return (await chrome.storage.session.get(key))[key] || null;
}

async function cleanupTab(tabId) {
  await chrome.alarms.clear(alarmName(tabId));
  await updateTab(tabId, () => null);
}

// ---------- Side panel: chỉ bật cho tab được bấm icon ----------

async function disableGlobalPanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    await chrome.sidePanel.setOptions({ enabled: false });
  } catch (e) {
    console.warn('[PostPing] sidePanel setup', e);
  }
}

chrome.runtime.onInstalled.addListener(disableGlobalPanel);
chrome.runtime.onStartup.addListener(async () => {
  await disableGlobalPanel();
  // Tab id thay đổi sau khi khởi động lại trình duyệt -> bỏ các alarm cũ.
  await chrome.alarms.clearAll();
});

chrome.action.onClicked.addListener((tab) => {
  // Không await: sidePanel.open phải chạy trong user gesture.
  chrome.sidePanel.setOptions({ tabId: tab.id, path: `sidepanel.html?tabId=${tab.id}`, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupTab(tabId);
});

// ---------- Vòng kiểm tra ----------

// Độ trễ ngẫu nhiên trong [min, max] giây, trả về mili giây.
function randomDelayMs(minSec, maxSec) {
  const lo = Math.max(0, Number(minSec) || 0);
  const hi = Math.max(lo, Number(maxSec) || 0);
  return Math.round((lo + Math.random() * (hi - lo)) * 1000);
}

async function triggerCheck(tabId, reason) {
  if (reason === 'alarm' || reason === 'manual') {
    const cur = await getTabState(tabId);
    if (cur && cur.busyUntil > Date.now()) {
      await updateTab(tabId, (s) => {
        if (!s) return undefined;
        pushLog(s, { type: 'check', text: reason === 'manual' ? 'Đang chờ bình luận, chưa thể kiểm tra thủ công.' : 'Bỏ qua lần kiểm tra này vì đang chờ bình luận.' });
        return s;
      });
      return;
    }
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    await cleanupTab(tabId);
    return;
  }

  const st = await updateTab(tabId, (s) => {
    if (!s || !s.running) return undefined;
    if (s.pending && Date.now() - s.pendingSince > PENDING_TIMEOUT_MS) {
      pushLog(s, {
        type: 'warn',
        text: 'Lần kiểm tra trước không đọc được feed (trang tải chậm, bị chuyển hướng hoặc chưa đăng nhập).'
      });
    }
    s.pending = true;
    s.pendingSince = Date.now();
    if (reason === 'manual') pushLog(s, { type: 'info', text: 'Kiểm tra thủ công…' });
    return s;
  });
  if (!st || !st.running) return;

  const url = feedUrl(st.groupId);
  try {
    if (tab.url === url) await chrome.tabs.reload(tabId);
    else await chrome.tabs.update(tabId, { url });
  } catch (e) {
    await updateTab(tabId, (s) => {
      if (!s) return undefined;
      s.pending = false;
      pushLog(s, { type: 'error', text: `Không tải lại được tab: ${e.message || e}` });
      return s;
    });
  }
  await refreshNextCheck(tabId);
}

async function refreshNextCheck(tabId) {
  const alarm = await chrome.alarms.get(alarmName(tabId));
  await updateTab(tabId, (s) => {
    if (!s) return undefined;
    s.nextCheck = s.running && alarm ? alarm.scheduledTime : null;
    return s;
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const m = alarm.name.match(/^check_(\d+)$/);
  if (!m) return;
  const tabId = Number(m[1]);
  const st = await getTabState(tabId);
  if (!st || !st.running) {
    await chrome.alarms.clear(alarm.name);
    return;
  }
  await triggerCheck(tabId, 'alarm');
});

// ---------- Xử lý kết quả quét từ content script ----------

async function handleReady(tabId, url) {
  const st = await getTabState(tabId);
  if (!st || !st.running) return { scan: false };
  const g = parseGroup(url);
  if (!g || !g.isFeed) return { scan: false };

  if (g.groupId !== st.groupId) {
    // Facebook có thể chuyển /groups/<id số> sang /groups/<tên>. Chỉ chấp nhận
    // khi chính extension vừa điều hướng (pending), còn lại là người dùng tự mở group khác.
    if (!st.pending) return { scan: false };
    // Lưu cấu hình theo cả id mới để lần sau mở group này vẫn tự điền lại.
    await chrome.storage.local.set({
      [cfgKey(g.groupId)]: { keywords: st.keywords, comments: st.comments, maxAgeMin: st.maxAgeMin, clearHours: st.clearHours, delayMin: st.delayMin, delayMax: st.delayMax, intervalMin: st.intervalMin }
    });
    await updateTab(tabId, (s) => {
      if (!s) return undefined;
      s.groupId = g.groupId;
      return s;
    });
  }
  return { scan: true };
}

async function handleScanResult(tabId, msg) {
  const posts = Array.isArray(msg.posts) ? msg.posts : [];
  let tabTitle = '';
  try {
    tabTitle = cleanTitle((await chrome.tabs.get(tabId)).title);
  } catch {}

  // Danh sách bài cần bình luận, trả về cho content script thực hiện.
  const toComment = [];

  await updateTab(tabId, async (s) => {
    if (!s || !s.running) return undefined;
    s.pending = false;
    s.lastCheck = Date.now();
    s.stats.checks += 1;
    if (tabTitle) s.groupTitle = tabTitle;

    if (msg.error) pushLog(s, { type: 'error', text: `Lỗi khi đọc feed: ${msg.error}` });

    if (posts.length === 0) {
      pushLog(s, {
        type: 'warn',
        text: 'Không tìm thấy bài nào trên feed (chưa đăng nhập, trang tải chậm hoặc Facebook đổi giao diện).'
      });
      return s;
    }

    const seen = new Set(s.seen);
    const isSeen = (p) => p.keys.some((k) => seen.has(k));
    const markSeen = (p) => p.keys.forEach((k) => seen.add(k));

    if (s.baseline) {
      posts.forEach(markSeen);
      s.baseline = false;
      pushLog(s, {
        type: 'info',
        text: `Đã ghi nhận ${posts.length} bài đang có trên feed. Từ giờ chỉ log bài mới.`
      });
    } else {
      const keywords = parseKeywords(s.keywords);
      // Feed xếp mới nhất trước -> đảo lại để log theo thứ tự cũ → mới.
      // Bài đăng quá maxAgeMin phút thì không tính là mới (không đọc được giờ đăng thì vẫn tính).
      const maxAge = Number(s.maxAgeMin) || 0;
      // Không đọc được giờ đăng thì không thể chắc bài còn mới -> coi là cũ khi đang bật giới hạn thời gian.
      const tooOld = (p) => maxAge > 0 && (typeof p.ageMin !== 'number' || p.ageMin > maxAge);
      const unseen = posts.filter((p) => !isSeen(p));
      const skippedOld = unseen.filter(tooOld);
      skippedOld.forEach(markSeen);
      const fresh = unseen.filter((p) => !tooOld(p)).reverse();
      const entries = [];
      const commentPool = parseComments(s.comments);
      const commentable = [];
      for (const p of fresh) {
        markSeen(p);
        const matched = keywords.length ? matchKeywords(`${p.text}`, keywords) : [];
        if (keywords.length && matched.length === 0) continue;
        if (commentPool.length) commentable.push(p);
        entries.push({ type: 'post', text: `Tìm thấy bài mới ${p.author || 'Không rõ'}`, url: p.url });
      }
      s.stats.newPosts += fresh.length;
      pushLog(s, {
        type: 'check',
        text: fresh.length
          ? `Kiểm tra: ${fresh.length} bài mới, ${entries.length} bài ${keywords.length ? 'khớp từ khóa' : 'được ghi'}.`
          : 'Kiểm tra: không có bài mới.'
      });
      if (skippedOld.length) {
        pushLog(s, { type: 'check', text: `Bỏ qua ${skippedOld.length} bài đăng quá ${maxAge} phút.` });
      }
      entries.forEach((e) => pushLog(s, e));

      // Chống trùng bằng IndexedDB (dùng chung mọi tab, còn sau khi tắt trình duyệt):
      // "giữ chỗ" các khóa của bài trước khi bình luận, bài đã có khóa thì bỏ qua.
      // Duyệt từ bài mới nhất, tối đa MAX_COMMENTS_PER_CHECK bình luận mỗi lần kiểm tra.
      await purgeCommented(Number(s.clearHours) || 0);
      let duplicates = 0;
      let examined = 0;
      for (const p of [...commentable].reverse()) {
        if (toComment.length >= MAX_COMMENTS_PER_CHECK) break;
        examined++;
        if (!(await claimKeys(commentKeys(s.groupId, p)))) {
          duplicates++;
          continue;
        }
        toComment.push({
          key: p.keys[0],
          author: p.author || 'Không rõ',
          text: commentPool[Math.floor(Math.random() * commentPool.length)],
          delayMs: randomDelayMs(s.delayMin, s.delayMax)
        });
      }
      if (toComment.length) {
        // Báo cho vòng kiểm tra sau biết đang bận bình luận (tránh reload tab giữa chừng).
        const totalDelay = toComment.reduce((n, c) => n + c.delayMs, 0);
        s.busyUntil = Date.now() + totalDelay + toComment.length * 30000;
        pushLog(s, {
          type: 'info',
          text: `Sẽ comment ${toComment.length} bài, bài đầu sau ${Math.round(toComment[0].delayMs / 1000)} giây.`
        });
      }
      if (duplicates) {
        pushLog(s, { type: 'check', text: `Bỏ qua ${duplicates} bài đã bình luận trước đó.` });
      }
      const limited = commentable.length - examined;
      if (limited > 0) {
        pushLog(s, {
          type: 'warn',
          text: `Chưa bình luận ${limited} bài khớp (giới hạn ${MAX_COMMENTS_PER_CHECK} bài mỗi lần kiểm tra).`
        });
      }
    }

    s.seen = [...seen].slice(-SEEN_LIMIT);
    return s;
  });
  return toComment;
}

async function handleCommentResult(tabId, msg) {
  const results = Array.isArray(msg.results) ? msg.results : [];
  await updateTab(tabId, (s) => {
    if (!s) return undefined;
    s.busyUntil = 0;
    for (const r of results) {
      if (r.ok) s.stats.commented = (s.stats.commented || 0) + 1;
      pushLog(
        s,
        r.ok
          ? { type: 'info', text: `Đã comment bài ${r.author}: "${r.text}"` }
          : { type: 'error', text: `Không comment được bài ${r.author}: ${r.error}` }
      );
    }
    return s;
  });
}

// ---------- Lệnh từ side panel ----------

async function startWatching(tabId, keywords, comments, maxAgeMin, clearHours, delayMin, delayMax, intervalMin) {
  const tab = await chrome.tabs.get(tabId);
  const g = parseGroup(tab.url);
  if (!g) throw new Error('Tab này không phải trang Facebook Group.');

  const interval = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(Number(intervalMin) || 0)));
  const maxAge = Math.max(0, Math.round(Number(maxAgeMin) || 0));
  const clearH = Math.max(0, Number(clearHours) || 0);
  const dMin = Math.max(0, Math.round(Number(delayMin) || 0));
  const dMax = Math.max(dMin, Math.round(Number(delayMax) || 0));
  await chrome.storage.local.set({
    [cfgKey(g.groupId)]: { keywords, comments, maxAgeMin: maxAge, clearHours: clearH, delayMin: dMin, delayMax: dMax, intervalMin: interval }
  });

  await updateTab(tabId, (cur) => {
    const s = cur || freshState(tabId);
    Object.assign(s, {
      groupId: g.groupId,
      groupTitle: cleanTitle(tab.title) || s.groupTitle,
      running: true,
      keywords,
      comments,
      maxAgeMin: maxAge,
      clearHours: clearH,
      delayMin: dMin,
      delayMax: dMax,
      intervalMin: interval,
      baseline: true,
      pending: false,
      seen: [],
      stats: { checks: 0, newPosts: 0, commented: 0 }
    });
    const kw = parseKeywords(keywords);
    const cm = parseComments(comments);
    pushLog(s, {
      type: 'info',
      text: `Bắt đầu theo dõi · mỗi ${interval} phút · ${kw.length ? `từ khóa: ${kw.join(', ')}` : 'không lọc từ khóa'} · ${cm.length ? `${cm.length} mẫu bình luận` : 'không tự bình luận'} · ${maxAge ? `chỉ bài đăng trong ${maxAge} phút` : 'không giới hạn tuổi bài'}`
    });
    return s;
  });

  await chrome.alarms.create(alarmName(tabId), { delayInMinutes: interval, periodInMinutes: interval });
  await triggerCheck(tabId, 'start');
}

async function stopWatching(tabId) {
  await chrome.alarms.clear(alarmName(tabId));
  await updateTab(tabId, (s) => {
    if (!s) return undefined;
    s.running = false;
    s.pending = false;
    s.nextCheck = null;
    pushLog(s, { type: 'info', text: 'Đã dừng theo dõi.' });
    return s;
  });
}

async function panelInfo(tabId) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {}
  const group = tab ? parseGroup(tab.url) : null;
  const state = await getTabState(tabId);
  const groupId = state?.running ? state.groupId : group?.groupId;
  let config = null;
  if (groupId) config = (await chrome.storage.local.get(cfgKey(groupId)))[cfgKey(groupId)] || null;
  return {
    tab: tab ? { url: tab.url, title: cleanTitle(tab.title) } : null,
    group,
    state,
    config
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const respond = (p) => {
    p.then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  };

  // Từ content script
  if (sender.tab && msg.type === 'ready') return respond(handleReady(sender.tab.id, msg.url));
  if (sender.tab && msg.type === 'scanResult') {
    return respond(handleScanResult(sender.tab.id, msg).then((toComment) => ({ toComment })));
  }
  if (sender.tab && msg.type === 'commentResult') {
    return respond(handleCommentResult(sender.tab.id, msg).then(() => ({})));
  }

  // Từ side panel
  switch (msg.type) {
    case 'panelInfo':
      return respond(panelInfo(msg.tabId));
    case 'start':
      return respond(startWatching(msg.tabId, msg.keywords || '', msg.comments || '', msg.maxAgeMin, msg.clearHours, msg.delayMin, msg.delayMax, msg.intervalMin).then(() => ({})));
    case 'stop':
      return respond(stopWatching(msg.tabId).then(() => ({})));
    case 'checkNow':
      return respond(triggerCheck(msg.tabId, 'manual').then(() => ({})));
    case 'clearHistory':
      return respond(clearCommented().then(() => ({ message: 'Đã xóa lịch sử bình luận.' })));
    case 'testComment':
      return respond(testComment(msg.tabId, msg.text));
    case 'clearLog':
      return respond(
        updateTab(msg.tabId, (s) => {
          if (!s) return undefined;
          s.logs = [];
          return s;
        }).then(() => ({}))
      );
    default:
      return false;
  }
});

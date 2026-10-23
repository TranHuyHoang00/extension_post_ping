// PostPing – service worker
// Mỗi tab có trạng thái riêng trong chrome.storage.session (key `tab_<tabId>`),
// alarm riêng (`check_<tabId>`). Cấu hình (từ khóa, tần suất) lưu lâu dài theo
// group trong chrome.storage.local (key `cfg_<groupId>`).

const SEEN_LIMIT = 3000;
const LOG_LIMIT = 500;
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 1440;
const PENDING_TIMEOUT_MS = 90 * 1000;

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
    intervalMin: 5,
    baseline: true,
    pending: false,
    pendingSince: 0,
    seen: [],
    logs: [],
    lastCheck: null,
    nextCheck: null,
    stats: { checks: 0, newPosts: 0, matched: 0 }
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

async function triggerCheck(tabId, reason) {
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
      [cfgKey(g.groupId)]: { keywords: st.keywords, intervalMin: st.intervalMin }
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

  await updateTab(tabId, (s) => {
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
      const fresh = posts.filter((p) => !isSeen(p)).reverse();
      const entries = [];
      for (const p of fresh) {
        markSeen(p);
        const matched = keywords.length ? matchKeywords(`${p.text}`, keywords) : [];
        if (keywords.length && matched.length === 0) continue;
        entries.push({
          type: 'post',
          author: p.author || 'Không rõ',
          text: p.text || '(Bài không có nội dung chữ)',
          keywords: matched,
          url: p.url
        });
      }
      s.stats.newPosts += fresh.length;
      s.stats.matched += entries.length;
      pushLog(s, {
        type: 'check',
        text: fresh.length
          ? `Kiểm tra: ${fresh.length} bài mới, ${entries.length} bài ${keywords.length ? 'khớp từ khóa' : 'được ghi'}.`
          : 'Kiểm tra: không có bài mới.'
      });
      entries.forEach((e) => pushLog(s, e));
    }

    s.seen = [...seen].slice(-SEEN_LIMIT);
    return s;
  });
}

// ---------- Lệnh từ side panel ----------

async function startWatching(tabId, keywords, intervalMin) {
  const tab = await chrome.tabs.get(tabId);
  const g = parseGroup(tab.url);
  if (!g) throw new Error('Tab này không phải trang Facebook Group.');

  const interval = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(Number(intervalMin) || 0)));
  await chrome.storage.local.set({ [cfgKey(g.groupId)]: { keywords, intervalMin: interval } });

  await updateTab(tabId, (cur) => {
    const s = cur || freshState(tabId);
    Object.assign(s, {
      groupId: g.groupId,
      groupTitle: cleanTitle(tab.title) || s.groupTitle,
      running: true,
      keywords,
      intervalMin: interval,
      baseline: true,
      pending: false,
      seen: [],
      stats: { checks: 0, newPosts: 0, matched: 0 }
    });
    const kw = parseKeywords(keywords);
    pushLog(s, {
      type: 'info',
      text: `Bắt đầu theo dõi · mỗi ${interval} phút · ${kw.length ? `từ khóa: ${kw.join(', ')}` : 'không lọc từ khóa'}`
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
  if (sender.tab && msg.type === 'scanResult') return respond(handleScanResult(sender.tab.id, msg).then(() => ({})));

  // Từ side panel
  switch (msg.type) {
    case 'panelInfo':
      return respond(panelInfo(msg.tabId));
    case 'start':
      return respond(startWatching(msg.tabId, msg.keywords || '', msg.intervalMin).then(() => ({})));
    case 'stop':
      return respond(stopWatching(msg.tabId).then(() => ({})));
    case 'checkNow':
      return respond(triggerCheck(msg.tabId, 'manual').then(() => ({})));
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

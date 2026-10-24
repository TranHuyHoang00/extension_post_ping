// PostPing – side panel (mỗi tab một panel riêng, tabId truyền qua query string)

const tabId = Number(new URLSearchParams(location.search).get("tabId"));
const $ = (id) => document.getElementById(id);

// Giá trị mặc định cho các ô nhập (dùng khi group chưa có cấu hình đã lưu).
const DEFAULTS = {
  keywords: "",
  comments:
    "Vào proxyzing .com mà mua cho rẻ\nTham khảo bên proxyzing .com ấy\nQua proxyzing .com mà mua\nThấy bên proxyzing .com cũng ok\nT hay mua bên proxyzing .com\nThử bên proxyzing .com đi\nproxyzing .com giá cũng ổn á\nThử mua bên proxyzing .com xem sao\nproxyzing .com cũng được\nVào proxyzing .com mà mua",
  intervalMin: 5,
  maxAgeMin: 15,
  clearHours: 24,
  delayMin: 60,
  delayMax: 180,
};

const els = {
  groupName: $("groupName"),
  pill: $("statusPill"),
  notice: $("notice"),
  keywords: $("keywords"),
  comments: $("comments"),
  interval: $("interval"),
  maxAge: $("maxAge"),
  clearHours: $("clearHours"),
  delayMin: $("delayMin"),
  delayMax: $("delayMax"),
  toggleBtn: $("toggleBtn"),
  checkBtn: $("checkBtn"),
  testBtn: $("testBtn"),
  historyBtn: $("historyBtn"),
  lastCheck: $("lastCheck"),
  nextCheck: $("nextCheck"),
  stats: $("stats"),
  log: $("log"),
  emptyLog: $("emptyLog"),
  clearBtn: $("clearBtn"),
};

let current = { state: null, group: null, tab: null };
let formFilled = false;
let renderedIds = [];
let busy = false;
let errorText = "";

function send(msg) {
  return chrome.runtime.sendMessage({ ...msg, tabId });
}

const pad = (n) => String(n).padStart(2, "0");
function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtCountdown(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function showNotice(text) {
  els.notice.textContent = text || "";
  els.notice.hidden = !text;
}

// ---------- Render ----------

function renderStatus() {
  const { state, group, tab } = current;
  const running = !!state?.running;

  els.groupName.textContent =
    (running && state.groupTitle) ||
    tab?.title ||
    (group ? `Group ${group.groupId}` : "Không phải trang group");
  els.groupName.title = els.groupName.textContent;

  els.pill.textContent = running ? "Đang theo dõi" : "Đã dừng";
  els.pill.classList.toggle("running", running);

  els.toggleBtn.textContent = running ? "Dừng" : "Bắt đầu";
  els.toggleBtn.classList.toggle("stop", running);
  els.toggleBtn.disabled = busy || (!running && !group);
  const commenting = running && state.busyUntil > Date.now();
  els.checkBtn.disabled = busy || !running || commenting;
  els.checkBtn.title = commenting ? "Đang chờ comment, không thể kiểm tra lúc này" : "";
  els.testBtn.disabled = busy || !group;
  els.historyBtn.disabled = busy;
  els.keywords.disabled = running;
  els.comments.disabled = running;
  els.interval.disabled = running;
  els.maxAge.disabled = running;
  els.clearHours.disabled = running;
  els.delayMin.disabled = running;
  els.delayMax.disabled = running;

  if (errorText) showNotice(errorText);
  else if (!tab) showNotice("Tab này đã đóng.");
  else if (!running && !group)
    showNotice("Hãy mở một Facebook Group trong tab này để bắt đầu theo dõi.");
  else showNotice("");

  els.lastCheck.textContent = fmtTime(state?.lastCheck);
  els.nextCheck.textContent = running ? fmtCountdown(state?.nextCheck) : "—";
  els.stats.textContent = state
    ? `${state.stats.newPosts} / ${state.stats.commented || 0}`
    : "0 / 0";
}

function fillForm() {
  const { state, config } = current;
  if (formFilled && !state?.running) return;
  // Group đã có cấu hình lưu thì dùng cấu hình đó, chưa có thì dùng DEFAULTS.
  const src = { ...DEFAULTS, ...(state?.running ? state : config) };
  els.keywords.value = src.keywords;
  els.comments.value = src.comments;
  els.interval.value = src.intervalMin;
  els.maxAge.value = src.maxAgeMin;
  els.clearHours.value = src.clearHours;
  els.delayMin.value = src.delayMin;
  els.delayMax.value = src.delayMax;
  formFilled = true;
}

function lineEl(entry) {
  const line = document.createElement("div");
  line.className = `line ${entry.type}`;
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = `[${fmtTime(entry.time)}] `;
  const prefix =
    { info: "› ", check: "· ", warn: "! ", error: "✖ " }[entry.type] || "";
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = prefix + entry.text;
  line.append(ts, msg);
  if (entry.url) {
    const a = document.createElement("a");
    a.className = "open-link";
    a.href = entry.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = " => Mở bài ↗";
    line.append(a);
  }
  return line;
}

function renderLogs() {
  const logs = current.state?.logs || [];
  const ids = logs.map((l) => l.id);
  const nearBottom =
    els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 40;

  const canAppend =
    renderedIds.length <= ids.length &&
    renderedIds.every((id, i) => ids[i] === id);

  if (!canAppend) {
    els.log.querySelectorAll(".line").forEach((n) => n.remove());
    renderedIds = [];
  }
  for (const entry of logs.slice(renderedIds.length)) {
    els.log.appendChild(lineEl(entry));
  }
  renderedIds = ids;
  els.emptyLog.hidden = logs.length > 0;
  if (nearBottom || !canAppend) els.log.scrollTop = els.log.scrollHeight;
}

function render() {
  fillForm();
  renderStatus();
  renderLogs();
}

// ---------- Data ----------

async function refresh() {
  const res = await send({ type: "panelInfo" });
  if (!res?.ok) return;
  current = res;
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  const ch = changes[`tab_${tabId}`];
  if (!ch) return;
  current.state = ch.newValue || null;
  renderStatus();
  renderLogs();
});

chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === tabId && (info.url || info.title)) refresh();
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id === tabId) {
    current.tab = null;
    renderStatus();
  }
});

// ---------- Actions ----------

async function act(msg) {
  busy = true;
  renderStatus();
  try {
    const res = await send(msg);
    errorText = res && !res.ok ? res.error : (res && res.message) || "";
  } finally {
    busy = false;
    await refresh();
  }
}

els.toggleBtn.addEventListener("click", () => {
  if (current.state?.running) return act({ type: "stop" });

  const interval = Number(els.interval.value);
  if (!Number.isFinite(interval) || interval < 1) {
    els.interval.focus();
    errorText = "Tần suất kiểm tra tối thiểu là 1 phút.";
    return renderStatus();
  }
  act({
    type: "start",
    keywords: els.keywords.value.trim(),
    comments: els.comments.value.trim(),
    maxAgeMin: Math.max(0, Math.round(Number(els.maxAge.value) || 0)),
    clearHours: Math.max(0, Number(els.clearHours.value) || 0),
    delayMin: Math.max(0, Number(els.delayMin.value) || 0),
    delayMax: Math.max(0, Number(els.delayMax.value) || 0),
    intervalMin: Math.round(interval),
  });
});

els.checkBtn.addEventListener("click", () => act({ type: "checkNow" }));
els.clearBtn.addEventListener("click", () => send({ type: "clearLog" }));

els.historyBtn.addEventListener("click", () => {
  if (
    confirm(
      "Xóa hết lịch sử bài đã bình luận? Các bài cũ có thể bị bình luận lại.",
    )
  ) {
    act({ type: "clearHistory" });
  }
});

els.testBtn.addEventListener("click", () => {
  const lines = els.comments.value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) {
    els.comments.focus();
    errorText = "Hãy nhập ít nhất một dòng bình luận để test.";
    return renderStatus();
  }
  act({
    type: "testComment",
    text: lines[Math.floor(Math.random() * lines.length)],
  });
});

setInterval(() => {
  if (current.state?.running) {
    els.nextCheck.textContent = fmtCountdown(current.state.nextCheck);
    renderStatus(); // cập nhật nút Kiểm tra ngay khi hết thời gian chờ comment
  }
}, 1000);

if (!Number.isInteger(tabId)) {
  showNotice("Hãy mở PostPing bằng cách bấm icon extension trên tab group.");
} else {
  refresh();
}

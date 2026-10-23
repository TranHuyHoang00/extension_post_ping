// PostPing – side panel (mỗi tab một panel riêng, tabId truyền qua query string)

const tabId = Number(new URLSearchParams(location.search).get('tabId'));
const $ = (id) => document.getElementById(id);

const els = {
  groupName: $('groupName'),
  pill: $('statusPill'),
  notice: $('notice'),
  keywords: $('keywords'),
  interval: $('interval'),
  toggleBtn: $('toggleBtn'),
  checkBtn: $('checkBtn'),
  lastCheck: $('lastCheck'),
  nextCheck: $('nextCheck'),
  stats: $('stats'),
  log: $('log'),
  emptyLog: $('emptyLog'),
  clearBtn: $('clearBtn')
};

let current = { state: null, group: null, tab: null };
let formFilled = false;
let renderedIds = [];
let busy = false;
let errorText = '';

function send(msg) {
  return chrome.runtime.sendMessage({ ...msg, tabId });
}

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtCountdown(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function showNotice(text) {
  els.notice.textContent = text || '';
  els.notice.hidden = !text;
}

// ---------- Render ----------

function renderStatus() {
  const { state, group, tab } = current;
  const running = !!state?.running;

  els.groupName.textContent =
    (running && state.groupTitle) || tab?.title || (group ? `Group ${group.groupId}` : 'Không phải trang group');
  els.groupName.title = els.groupName.textContent;

  els.pill.textContent = running ? 'Đang theo dõi' : 'Đã dừng';
  els.pill.classList.toggle('running', running);

  els.toggleBtn.textContent = running ? 'Dừng' : 'Bắt đầu';
  els.toggleBtn.classList.toggle('stop', running);
  els.toggleBtn.disabled = busy || (!running && !group);
  els.checkBtn.disabled = busy || !running;
  els.keywords.disabled = running;
  els.interval.disabled = running;

  if (errorText) showNotice(errorText);
  else if (!tab) showNotice('Tab này đã đóng.');
  else if (!running && !group) showNotice('Hãy mở một Facebook Group trong tab này để bắt đầu theo dõi.');
  else showNotice('');

  els.lastCheck.textContent = fmtTime(state?.lastCheck);
  els.nextCheck.textContent = running ? fmtCountdown(state?.nextCheck) : '—';
  els.stats.textContent = state ? `${state.stats.newPosts} / ${state.stats.matched}` : '0 / 0';
}

function fillForm() {
  const { state, config } = current;
  if (formFilled && !state?.running) return;
  const src = state?.running ? state : config;
  if (src) {
    els.keywords.value = src.keywords || '';
    els.interval.value = src.intervalMin || 5;
  }
  formFilled = true;
}

function lineEl(entry) {
  if (entry.type === 'post') {
    const box = document.createElement('div');
    box.className = 'post';

    const head = document.createElement('div');
    head.className = 'head';
    head.innerHTML = `<span class="ts"></span> ✚ <span class="who"></span>`;
    head.querySelector('.ts').textContent = `[${fmtTime(entry.time)}]`;
    head.querySelector('.who').textContent = entry.author;

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = entry.text;
    body.title = 'Bấm để mở rộng / thu gọn';
    body.addEventListener('click', () => body.classList.toggle('open'));

    const foot = document.createElement('div');
    foot.className = 'foot';
    for (const k of entry.keywords || []) {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = `#${k}`;
      foot.appendChild(t);
    }
    const a = document.createElement('a');
    a.href = entry.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Mở bài ↗';
    foot.appendChild(a);

    box.append(head, body, foot);
    return box;
  }

  const line = document.createElement('div');
  line.className = `line ${entry.type}`;
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = `[${fmtTime(entry.time)}] `;
  const prefix = { info: '› ', check: '· ', warn: '! ', error: '✖ ' }[entry.type] || '';
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = prefix + entry.text;
  line.append(ts, msg);
  return line;
}

function renderLogs() {
  const logs = current.state?.logs || [];
  const ids = logs.map((l) => l.id);
  const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 40;

  const canAppend =
    renderedIds.length <= ids.length && renderedIds.every((id, i) => ids[i] === id);

  if (!canAppend) {
    els.log.querySelectorAll('.line, .post').forEach((n) => n.remove());
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
  const res = await send({ type: 'panelInfo' });
  if (!res?.ok) return;
  current = res;
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
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
    errorText = res && !res.ok ? res.error : '';
  } finally {
    busy = false;
    await refresh();
  }
}

els.toggleBtn.addEventListener('click', () => {
  if (current.state?.running) return act({ type: 'stop' });

  const interval = Number(els.interval.value);
  if (!Number.isFinite(interval) || interval < 1) {
    els.interval.focus();
    errorText = 'Tần suất kiểm tra tối thiểu là 1 phút.';
    return renderStatus();
  }
  act({ type: 'start', keywords: els.keywords.value.trim(), intervalMin: Math.round(interval) });
});

els.checkBtn.addEventListener('click', () => act({ type: 'checkNow' }));
els.clearBtn.addEventListener('click', () => send({ type: 'clearLog' }));

setInterval(() => {
  if (current.state?.running) els.nextCheck.textContent = fmtCountdown(current.state.nextCheck);
}, 1000);

if (!Number.isInteger(tabId)) {
  showNotice('Hãy mở PostPing bằng cách bấm icon extension trên tab group.');
} else {
  refresh();
}

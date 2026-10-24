// PostPing – content script (chạy trên https://*.facebook.com/groups/*)
// Khi trang tải xong, hỏi background xem tab này có đang được theo dõi không.
// Nếu có: đợi feed hiện ra, đọc các bài viết và gửi danh sách về background.

(() => {
  if (window.__postPingLoaded) return;
  window.__postPingLoaded = true;

  const FEED_TIMEOUT_MS = 25000;
  const EXTRA_SCROLLS = 3;
  const MAX_POSTS = 30;
  const TEXT_LIMIT = 1500;

  // Tốc độ gõ (ms mỗi ký tự)
  const TYPE_MIN_MS = 60;
  const TYPE_MAX_MS = 180;
  // Thời gian chờ xác nhận bình luận đã gửi
  const SEND_CONFIRM_MS = 6000;

  const TEXTBOX_SEL = '[contenteditable="true"][role="textbox"]';

  const postEls = new Map(); // key bài -> phần tử DOM, dùng để bình luận sau khi quét

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => min + Math.random() * (max - min);
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  async function waitFor(fn, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(500);
    }
    return null;
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++)
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function isLoadingPlaceholder(el) {
    if (el.getAttribute("aria-busy") === "true") return true;
    const label = el.getAttribute("aria-label") || "";
    return /loading|đang tải/i.test(label);
  }

  function isCommentArticle(el) {
    const label = el.getAttribute("aria-label") || "";
    return /comment|bình luận|phản hồi|reply/i.test(label);
  }

  // Các phần tử bài viết cấp cao nhất trong feed
  function findPosts(feed) {
    const sel = '[aria-posinset], [role="article"]';
    let posts = [...feed.querySelectorAll(sel)].filter((el) => {
      if (isLoadingPlaceholder(el) || isCommentArticle(el)) return false;
      const anc = el.parentElement && el.parentElement.closest(sel);
      return !anc || !feed.contains(anc);
    });
    if (posts.length === 0) {
      posts = [...feed.children].filter(
        (el) => (el.innerText || "").trim().length > 20,
      );
    }
    return posts.filter((el) => (el.innerText || "").trim().length > 0);
  }

  function getFeed() {
    const feed = document.querySelector('[role="feed"]');
    return feed && findPosts(feed).length ? feed : null;
  }

  const POST_ID_PATTERNS = [
    /\/groups\/[^/]+\/(?:posts|permalink)\/(\d+|pfbid[0-9A-Za-z]+)/,
    /[?&]story_fbid=(\d+|pfbid[0-9A-Za-z]+)/,
    /[?&]multi_permalinks=(\d+)/,
    /[?&]set=pcb\.(\d+)/,
  ];

  function findPostId(root) {
    for (const a of root.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      for (const re of POST_ID_PATTERNS) {
        const m = href.match(re);
        if (m) return m[1];
      }
    }
    return null;
  }

  // Link thời gian của Facebook thường chỉ có href thật khi rê chuột vào.
  async function revealPermalink(root) {
    const anchors = [...root.querySelectorAll('a[role="link"], a[href]')]
      .filter((a) => {
        if (a.closest('[role="article"]') !== root.closest('[role="article"]'))
          return false;
        const href = a.getAttribute("href") || "";
        return href === "#" || href === "" || /__cft__/.test(href);
      })
      .slice(0, 8);
    for (const a of anchors) {
      a.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, view: window }),
      );
      a.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    }
    if (anchors.length) await sleep(400);
    for (const a of anchors) {
      a.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, view: window }),
      );
      a.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
  }

  async function expandSeeMore(root) {
    const btns = [
      ...root.querySelectorAll('div[role="button"], span[role="button"]'),
    ].filter((b) => /^(xem thêm|see more)$/i.test((b.innerText || "").trim()));
    for (const b of btns.slice(0, 3)) {
      try {
        b.click();
      } catch {}
    }
    if (btns.length) await sleep(400);
  }

  function getAuthor(root) {
    const h = root.querySelector("h2, h3, h4");
    let name = h ? (h.innerText || "").split("\n")[0] : "";
    if (!name) {
      const strong = root.querySelector("strong");
      name = strong ? strong.innerText : "";
    }
    return name.split("·")[0].replace(/\s+/g, " ").trim();
  }

  function cleanText(t) {
    return (t || "")
      .replace(/\s*(…\s*)?(Xem thêm|See more|Ẩn bớt|See less)\s*$/i, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getText(root) {
    const msgEls = root.querySelectorAll(
      '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]',
    );
    if (msgEls.length) {
      return cleanText([...msgEls].map((e) => e.innerText).join("\n")).slice(
        0,
        TEXT_LIMIT,
      );
    }
    // Dự phòng: gom các khối dir="auto" của chính bài viết (bỏ tiêu đề, bình luận, nút bấm)
    const parts = [];
    for (const d of root.querySelectorAll(
      'div[dir="auto"], span[dir="auto"]',
    )) {
      if (d.closest('h2, h3, h4, [role="button"]')) continue;
      const art = d.closest('[role="article"]');
      if (art && art !== root && root.contains(art)) continue;
      if (
        d.parentElement &&
        d.parentElement.closest('div[dir="auto"], span[dir="auto"]')
      )
        continue;
      const t = (d.innerText || "").trim();
      if (t && !parts.includes(t)) parts.push(t);
    }
    return cleanText(parts.join("\n")).slice(0, TEXT_LIMIT);
  }

  // Đọc link thời gian dưới tên người đăng ("5 phút", "2 giờ", "Hôm qua lúc...") -> số phút trước.
  // Trả về null nếu không đọc được.
  function parseAgeText(raw) {
    const t = (raw || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!t || t.length > 40) return null;
    if (/^(vừa xong|just now|now)$/.test(t)) return 0;
    let m = t.match(/^(\d+)\s*(giây|s|sec|secs|seconds?)$/);
    if (m) return Number(m[1]) / 60;
    m = t.match(/^(\d+)\s*(phút|m|min|mins|minutes?)$/);
    if (m) return Number(m[1]);
    m = t.match(/^(\d+)\s*(giờ|h|hr|hrs|hours?)$/);
    if (m) return Number(m[1]) * 60;
    m = t.match(/^(\d+)\s*(ngày|d|days?)$/);
    if (m) return Number(m[1]) * 1440;
    m = t.match(/^(\d+)\s*(tuần|w|wks?|weeks?)$/);
    if (m) return Number(m[1]) * 10080;
    if (/^(hôm qua|yesterday)/.test(t)) return 1440;
    if (
      /^\d+\s*(tháng|năm)|^(tháng|january|february|march|april|may|june|july|august|september|october|november|december)/.test(
        t,
      )
    ) {
      return 43200; // ngày tháng cụ thể -> coi là cũ
    }
    return null;
  }

  function getAgeMin(root) {
    const art = root.closest('[role="article"]') || root;
    for (const a of [...root.querySelectorAll('a[role="link"], a[href]')].slice(
      0,
      20,
    )) {
      if (a.closest('[role="article"]') !== art) continue;
      const age = parseAgeText(a.innerText);
      if (age !== null) return age;
    }
    return null;
  }

  function currentGroupSlug() {
    const m = location.pathname.match(/^\/groups\/([^/]+)/);
    return m ? m[1] : "";
  }

  function articleRoot(el) {
    if (el.matches('[role="article"]')) return el;
    const art = [...el.querySelectorAll('[role="article"]')].find(
      (a) => !isCommentArticle(a),
    );
    return art || el;
  }

  async function extract(el) {
    const root = articleRoot(el);
    await expandSeeMore(root);
    let postId = findPostId(root);
    if (!postId) {
      await revealPermalink(root);
      postId = findPostId(root);
    }
    const author = getAuthor(root);
    const text = getText(root);
    if (!author && !text) return null;

    const keys = [`h_${hash(`${author}|${text.slice(0, 300)}`)}`];
    if (postId) keys.unshift(`p_${postId}`);
    const slug = currentGroupSlug();
    const url = postId
      ? `https://www.facebook.com/groups/${slug}/posts/${postId}/`
      : `https://www.facebook.com/groups/${slug}/`;
    // Lưu theo mọi key để background gửi key nào cũng tìm được bài
    for (const k of keys) postEls.set(k, root);
    return { keys, author, text, url, ageMin: getAgeMin(root) };
  }

  // ───────────────────────── Bình luận ─────────────────────────

  // Ô bình luận chính của bài: bỏ qua ô trả lời nằm trong bình luận con
  function findCommentBox(root) {
    const boxes = [...root.querySelectorAll(TEXTBOX_SEL)];
    return (
      boxes.find((b) => {
        const art = b.closest('[role="article"]');
        return !art || art === root || !root.contains(art);
      }) || null
    );
  }

  const COMMENT_BTN_RE =
    /^(bình luận|comment|viết bình luận|leave a comment)$/i;

  async function openCommentBox(root) {
    const existing = findCommentBox(root);
    if (existing) return existing;

    const btn = [
      ...root.querySelectorAll('div[role="button"], span[role="button"]'),
    ].find(
      (b) =>
        COMMENT_BTN_RE.test((b.getAttribute("aria-label") || "").trim()) ||
        COMMENT_BTN_RE.test((b.innerText || "").trim()),
    );

    const focusedBefore = document.activeElement;
    if (btn) btn.click();

    return waitFor(() => {
      const b = findCommentBox(root);
      if (b) return b;
      // Ô bình luận có thể mở trong hộp thoại riêng, ngoài root:
      // nhận ô đang được focus nếu nó vừa được focus sau khi bấm nút
      const a = document.activeElement;
      if (
        btn &&
        a &&
        a !== focusedBefore &&
        a.matches &&
        a.matches(TEXTBOX_SEL) &&
        (root.contains(a) || a.closest('[role="dialog"]'))
      )
        return a;
      return null;
    }, 4000);
  }

  // Tách chuỗi theo "ký tự hiển thị" để emoji ghép không bị cắt đôi
  function splitChars(text) {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      return Array.from(seg.segment(text), (s) => s.segment);
    }
    return Array.from(text);
  }

  async function typeText(
    box,
    text,
    { min = TYPE_MIN_MS, max = TYPE_MAX_MS } = {},
  ) {
    box.focus();
    await sleep(rand(200, 400));

    // Xoá bản nháp cũ để không bị nối chữ
    if (box.innerText.trim()) {
      const range = document.createRange();
      range.selectNodeContents(box);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("delete", false, null);
    }

    const chars = splitChars(text);
    for (const ch of chars) {
      if (!box.isConnected) throw new Error("ô bình luận biến mất khi đang gõ");
      if (document.activeElement !== box) box.focus();

      if (ch === "\n" || ch === "\r\n") {
        // Xuống dòng trong ô, không gửi bình luận
        document.execCommand("insertLineBreak", false, null);
      } else {
        document.execCommand("insertText", false, ch);
      }

      let delay = rand(min, max);
      if (/[\s.,!?;:]/.test(ch)) delay += rand(40, 160);
      await sleep(delay);
    }
  }

  function pressKey(el, key, code, keyCode) {
    const opts = {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  // Đóng menu gợi ý (@tag, #hashtag, emoji) để Enter không chọn gợi ý thay vì gửi
  async function closeSuggestions(box) {
    const ctrl = box.getAttribute("aria-controls");
    const open =
      box.getAttribute("aria-expanded") === "true" ||
      (ctrl && document.getElementById(ctrl));
    if (!open) return;
    pressKey(box, "Escape", "Escape", 27);
    await sleep(300);
    if (document.activeElement !== box) box.focus();
  }

  async function postComment(root, text) {
    if (!root.isConnected) throw new Error("bài viết không còn trên trang");
    if (!norm(text)) throw new Error("nội dung bình luận trống");

    root.scrollIntoView({ block: "center" });
    await sleep(800);

    const box = await openCommentBox(root);
    if (!box) throw new Error("không tìm thấy ô bình luận");

    await typeText(box, text);
    await sleep(rand(400, 900));

    if (norm(box.innerText) !== norm(text))
      throw new Error("nội dung nhập vào không khớp");

    await closeSuggestions(box);
    pressKey(box, "Enter", "Enter", 13);

    // Gửi thành công khi ô trống (hoặc bị thay bằng ô mới trống) VÀ nội dung đã hiện trên trang
    const want = norm(text);
    const sent = await waitFor(() => {
      let empty;
      if (box.isConnected) empty = !norm(box.innerText);
      else {
        const nb = findCommentBox(root);
        empty = !!nb && !norm(nb.innerText);
      }
      return empty && norm(document.body.innerText).includes(want);
    }, SEND_CONFIRM_MS);
    if (!sent) throw new Error("đã nhập nhưng chưa gửi");
  }

  async function runComments(toComment) {
    const results = [];
    for (const c of toComment) {
      const root = postEls.get(c.key);
      try {
        if (!root) throw new Error("không tìm thấy bài trên trang");
        await sleep(c.delayMs || 0);
        await postComment(root, c.text);
        results.push({ ok: true, author: c.author, text: c.text });
      } catch (e) {
        results.push({
          ok: false,
          author: c.author,
          text: c.text,
          error: String((e && e.message) || e),
        });
      }
    }
    return results;
  }

  // ───────────────────────── Quét feed ─────────────────────────

  async function scan() {
    const feed = await waitFor(getFeed, FEED_TIMEOUT_MS);
    if (!feed) return [];
    await sleep(1500);

    for (let i = 0; i < EXTRA_SCROLLS; i++) {
      window.scrollBy(0, window.innerHeight * 1.5);
      await sleep(1500);
    }
    window.scrollTo(0, 0);
    await sleep(300);

    const posts = [];
    for (const el of findPosts(feed).slice(0, MAX_POSTS)) {
      try {
        const p = await extract(el);
        if (p) posts.push(p);
      } catch (e) {
        console.warn("[PostPing] extract error", e);
      }
    }
    return posts;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== "testComment") return false;
    (async () => {
      try {
        const feed = document.querySelector('[role="feed"]');
        const el = feed && findPosts(feed)[0];
        if (!el) throw new Error("Không tìm thấy bài nào trên feed.");
        const root = articleRoot(el);
        await postComment(root, msg.text);
        sendResponse({ ok: true, author: getAuthor(root) || "Không rõ" });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  });

  async function main() {
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "ready",
        url: location.href,
      });
    } catch {
      return; // extension vừa được reload, content script cũ không còn kết nối
    }
    if (!resp || !resp.ok || !resp.scan) return;

    let posts = [];
    let error = null;
    try {
      posts = await scan();
    } catch (e) {
      error = String((e && e.message) || e);
    }
    let toComment = [];
    try {
      const r = await chrome.runtime.sendMessage({
        type: "scanResult",
        url: location.href,
        posts,
        error,
      });
      toComment = (r && r.toComment) || [];
    } catch {}

    if (toComment.length) {
      const results = await runComments(toComment);
      try {
        await chrome.runtime.sendMessage({ type: "commentResult", results });
      } catch {}
    }
  }

  main();
})();

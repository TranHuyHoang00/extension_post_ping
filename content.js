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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function isLoadingPlaceholder(el) {
    if (el.getAttribute('aria-busy') === 'true') return true;
    const label = el.getAttribute('aria-label') || '';
    return /loading|đang tải/i.test(label);
  }

  function isCommentArticle(el) {
    const label = el.getAttribute('aria-label') || '';
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
      posts = [...feed.children].filter((el) => (el.innerText || '').trim().length > 20);
    }
    return posts.filter((el) => (el.innerText || '').trim().length > 0);
  }

  function getFeed() {
    const feed = document.querySelector('[role="feed"]');
    return feed && findPosts(feed).length ? feed : null;
  }

  const POST_ID_PATTERNS = [
    /\/groups\/[^/]+\/(?:posts|permalink)\/(\d+|pfbid[0-9A-Za-z]+)/,
    /[?&]story_fbid=(\d+|pfbid[0-9A-Za-z]+)/,
    /[?&]multi_permalinks=(\d+)/,
    /[?&]set=pcb\.(\d+)/
  ];

  function findPostId(root) {
    for (const a of root.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
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
        if (a.closest('[role="article"]') !== root.closest('[role="article"]')) return false;
        const href = a.getAttribute('href') || '';
        return href === '#' || href === '' || /__cft__/.test(href);
      })
      .slice(0, 8);
    for (const a of anchors) {
      a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
      a.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    }
    if (anchors.length) await sleep(400);
    for (const a of anchors) {
      a.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, view: window }));
      a.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    }
  }

  async function expandSeeMore(root) {
    const btns = [...root.querySelectorAll('div[role="button"], span[role="button"]')].filter((b) =>
      /^(xem thêm|see more)$/i.test((b.innerText || '').trim())
    );
    for (const b of btns.slice(0, 3)) {
      try {
        b.click();
      } catch {}
    }
    if (btns.length) await sleep(400);
  }

  function getAuthor(root) {
    const h = root.querySelector('h2, h3, h4');
    let name = h ? (h.innerText || '').split('\n')[0] : '';
    if (!name) {
      const strong = root.querySelector('strong');
      name = strong ? strong.innerText : '';
    }
    return name.split('·')[0].replace(/\s+/g, ' ').trim();
  }

  function cleanText(t) {
    return (t || '')
      .replace(/\s*(…\s*)?(Xem thêm|See more|Ẩn bớt|See less)\s*$/i, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function getText(root) {
    const msgEls = root.querySelectorAll(
      '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]'
    );
    if (msgEls.length) {
      return cleanText([...msgEls].map((e) => e.innerText).join('\n')).slice(0, TEXT_LIMIT);
    }
    // Dự phòng: gom các khối dir="auto" của chính bài viết (bỏ tiêu đề, bình luận, nút bấm)
    const parts = [];
    for (const d of root.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
      if (d.closest('h2, h3, h4, [role="button"]')) continue;
      const art = d.closest('[role="article"]');
      if (art && art !== root && root.contains(art)) continue;
      if (d.parentElement && d.parentElement.closest('div[dir="auto"], span[dir="auto"]')) continue;
      const t = (d.innerText || '').trim();
      if (t && !parts.includes(t)) parts.push(t);
    }
    return cleanText(parts.join('\n')).slice(0, TEXT_LIMIT);
  }

  function currentGroupSlug() {
    const m = location.pathname.match(/^\/groups\/([^/]+)/);
    return m ? m[1] : '';
  }

  async function extract(el) {
    const root = el.matches('[role="article"]') ? el : el.querySelector('[role="article"]') || el;
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
    return { keys, author, text, url };
  }

  async function scan() {
    const feed = await waitFor(getFeed, FEED_TIMEOUT_MS);
    if (!feed) return [];
    await sleep(1500);

    // Cuộn thêm vài lần để Facebook tải thêm bài, rồi quay lại đầu trang.
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
        console.warn('[PostPing] extract error', e);
      }
    }
    return posts;
  }

  async function main() {
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'ready', url: location.href });
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
    try {
      await chrome.runtime.sendMessage({ type: 'scanResult', url: location.href, posts, error });
    } catch {}
  }

  main();
})();

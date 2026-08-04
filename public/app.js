"use strict";

const APP_VERSION = "1.5.3";

const $ = (id) => document.getElementById(id);
const listEl = $("list");
const tabsEl = $("tabs");
const statusEl = $("status");
const updatedEl = $("updated");
const moreBtn = $("more");

const PAGE_SIZE = 120;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const READ_MAX = 3000;

// ---- 永続化 (localStorage) ----
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

let readList = store.get("read", []); // 既読URL (新しい順)
const readSet = new Set(readList);
let ngWords = store.get("ngWords", []);
let hiddenSites = new Set(store.get("hiddenSites", []));
let hideRead = store.get("hideRead", false);
let inAppReader = store.get("inAppReader", true);
let favs = store.get("favs", []); // [title, url, ts, hash] 新しい順
const favSet = new Set(favs.map((f) => f[1]));
const FAV_CAT = "★お気に入り";

function toggleFav(info) {
  if (favSet.has(info.url)) {
    favSet.delete(info.url);
    favs = favs.filter((f) => f[1] !== info.url);
  } else {
    favSet.add(info.url);
    favs.unshift([info.title, info.url, info.ts ?? null, info.hash ?? null]);
  }
  store.set("favs", favs);
}

// ---- 状態 ----
let data = null; // { updated, sites:[{name,category}], items:[[siteIdx,title,url,ts]] }
let activeCategory = "すべて";
let searchQuery = "";
let renderLimit = PAGE_SIZE;
let lastFetched = 0;

// ---- データ取得 ----
async function loadData(manual = false) {
  const btn = $("btn-refresh");
  btn.classList.add("spinning");
  try {
    const res = await fetch(`./data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    lastFetched = Date.now();
    renderTabs();
    render();
  } catch (err) {
    if (!data) {
      showStatus(
        "まだ記事データがありません。\nGitHub Actions の初回実行が完了すると表示されます。\n(手動実行: リポジトリの Actions → update → Run workflow)"
      );
    } else if (manual) {
      showStatus("更新に失敗しました。通信環境を確認してください。");
      setTimeout(() => { statusEl.hidden = true; }, 2500);
    }
  } finally {
    btn.classList.remove("spinning");
  }
}

function showStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
}

// ---- 表示 ----
function categories() {
  const set = new Set();
  for (const s of data.sites) set.add(s.category);
  return ["すべて", ...set];
}

function renderTabs() {
  tabsEl.textContent = "";
  for (const cat of [...categories(), FAV_CAT]) {
    const b = document.createElement("button");
    b.textContent = cat;
    if (cat === activeCategory) b.classList.add("active");
    b.onclick = () => {
      activeCategory = cat;
      renderLimit = PAGE_SIZE;
      renderTabs();
      render();
      window.scrollTo({ top: 0 });
    };
    tabsEl.appendChild(b);
  }
}

function matchesNg(title) {
  return ngWords.some((w) => w && title.includes(w));
}

function filteredItems() {
  const q = searchQuery.toLowerCase();
  const out = [];
  if (activeCategory === FAV_CAT) {
    for (const [title, url, ts, hash] of favs) {
      if (q && !title.toLowerCase().includes(q)) continue;
      if (matchesNg(title)) continue;
      out.push([null, title, url, ts, hash]);
    }
    return out;
  }
  for (const item of data.items) {
    const [siteIdx, title, url] = item;
    const site = data.sites[siteIdx];
    if (!site) continue;
    if (hiddenSites.has(site.name)) continue;
    if (activeCategory !== "すべて" && site.category !== activeCategory) continue;
    if (q && !title.toLowerCase().includes(q)) continue;
    if (matchesNg(title)) continue;
    if (hideRead && readSet.has(url)) continue;
    out.push(item);
  }
  return out;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function render() {
  const items = filteredItems();
  listEl.textContent = "";
  statusEl.hidden = true;

  if (items.length === 0) {
    showStatus("該当する記事がありません");
  }

  const frag = document.createDocumentFragment();
  for (const [, title, url, ts, articleHash] of items.slice(0, renderLimit)) {
    const li = document.createElement("li");
    if (readSet.has(url)) li.classList.add("read");

    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    const t = document.createElement("div");
    t.className = "item-title";
    t.textContent = title;

    const meta = document.createElement("div");
    meta.className = "item-meta";
    const time = document.createElement("span");
    time.textContent = fmtDate(ts);
    meta.append(time);

    a.append(t, meta);
    a.addEventListener("click", (e) => {
      markRead(url, li);
      if (inAppReader && articleHash) {
        e.preventDefault();
        openReader({ title, url, ts, hash: articleHash });
      }
    });

    const star = document.createElement("button");
    star.className = "fav-btn" + (favSet.has(url) ? " on" : "");
    star.textContent = favSet.has(url) ? "★" : "☆";
    star.setAttribute("aria-label", "お気に入り");
    star.onclick = () => {
      toggleFav({ title, url, ts, hash: articleHash });
      if (activeCategory === FAV_CAT) {
        render();
      } else {
        const on = favSet.has(url);
        star.textContent = on ? "★" : "☆";
        star.classList.toggle("on", on);
      }
    };

    li.append(a, star);
    frag.appendChild(li);
  }
  listEl.appendChild(frag);

  moreBtn.hidden = items.length <= renderLimit;
  updatedEl.textContent = data
    ? `最終取得: ${new Date(data.updated).toLocaleString("ja-JP")}`
    : "";
}

function markRead(url, li) {
  if (li) li.classList.add("read");
  if (readSet.has(url)) return;
  readSet.add(url);
  readList.unshift(url);
  if (readList.length > READ_MAX) {
    for (const removed of readList.splice(READ_MAX)) readSet.delete(removed);
  }
  store.set("read", readList);
}

// ---- アプリ内リーダー ----
const readerEl = $("reader");
let readerOpen = false;
let readerStack = []; // 関連記事から開いた履歴 (戻るで1つ前の記事へ)

async function urlHash(u) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(u));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function updateReaderFav() {
  const info = readerStack[readerStack.length - 1];
  const btn = $("reader-fav");
  const on = !!info && favSet.has(info.url);
  btn.textContent = on ? "★" : "☆";
  btn.classList.toggle("on", on);
}

async function openReader(info, replace = false) {
  if (!replace) {
    history.pushState({ reader: true }, "");
    readerStack.push(info);
  }
  readerOpen = true;
  readerEl.hidden = false;
  document.body.classList.add("noscroll");
  $("reader-title").textContent = info.title;
  $("reader-meta").textContent = info.ts ? fmtDate(info.ts) : "";
  $("reader-open").href = info.url;
  updateReaderFav();
  const box = $("reader-content");
  $("reader-related").textContent = "";
  box.innerHTML = '<p class="reader-loading">読み込み中…</p>';
  $("reader-scroll").scrollTop = 0;
  try {
    const res = await fetch(`./articles/${info.hash}.json`);
    if (!res.ok) throw new Error();
    const article = await res.json();
    box.innerHTML = article.html;
    renderRelated(article.related);
  } catch {
    box.innerHTML =
      '<p class="reader-loading">本文を取得できませんでした。右上の「元記事」から開いてください。</p>';
  }
}

// 関連記事リンク。アプリ内で読めるものはリーダーで、それ以外はブラウザで開く
function renderRelated(list) {
  const wrap = $("reader-related");
  wrap.textContent = "";
  if (!Array.isArray(list) || list.length === 0) return;
  const h3 = document.createElement("h3");
  h3.textContent = "関連記事";
  const ul = document.createElement("ul");
  wrap.append(h3, ul);
  for (const [title, url, thumb] of list) {
    if (matchesNg(title)) continue;
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    if (thumb) {
      const img = document.createElement("img");
      img.className = "rel-thumb";
      img.src = thumb;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      a.appendChild(img);
    }
    const span = document.createElement("span");
    span.textContent = title;
    a.appendChild(span);
    a.addEventListener("click", () => markRead(url, null));
    li.appendChild(a);
    ul.appendChild(li);
  }
  for (const a of ul.querySelectorAll("a")) {
    (async () => {
      const h = await urlHash(a.href);
      try {
        const res = await fetch(`./articles/${h}.json`, { method: "HEAD" });
        if (!res.ok) return;
      } catch {
        return;
      }
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openReader({ title: a.querySelector("span")?.textContent ?? a.textContent, url: a.href, ts: null, hash: h });
      });
    })();
  }
}

function closeReader() {
  readerEl.hidden = true;
  readerOpen = false;
  readerStack = [];
  document.body.classList.remove("noscroll");
  $("reader-content").innerHTML = "";
  $("reader-related").textContent = "";
}

window.addEventListener("popstate", () => {
  if (!readerOpen) return;
  readerStack.pop();
  if (readerStack.length > 0) {
    openReader(readerStack[readerStack.length - 1], true);
  } else {
    closeReader();
  }
});
$("reader-close").onclick = () => history.back();
$("reader-fav").onclick = () => {
  const info = readerStack[readerStack.length - 1];
  if (!info) return;
  toggleFav(info);
  updateReaderFav();
  if (data && activeCategory === FAV_CAT) render();
};

// ---- ヘッダー操作 ----
$("btn-refresh").onclick = () => loadData(true);

$("btn-search").onclick = () => {
  const bar = $("searchbar");
  bar.hidden = !bar.hidden;
  if (!bar.hidden) $("search").focus();
  else {
    searchQuery = "";
    $("search").value = "";
    render();
  }
};

$("search").addEventListener("input", (e) => {
  searchQuery = e.target.value.trim();
  renderLimit = PAGE_SIZE;
  render();
});

moreBtn.onclick = () => {
  renderLimit += PAGE_SIZE;
  render();
};

// ---- 設定 ----
const modal = $("settings-modal");

$("btn-settings").onclick = () => {
  $("ng-words").value = ngWords.join(", ");
  $("opt-hide-read").checked = hideRead;
  $("opt-reader").checked = inAppReader;
  renderSiteToggles();
  modal.hidden = false;
};

function closeSettings() {
  ngWords = $("ng-words").value.split(/[,、\n]/).map((w) => w.trim()).filter(Boolean);
  hideRead = $("opt-hide-read").checked;
  inAppReader = $("opt-reader").checked;
  store.set("ngWords", ngWords);
  store.set("hideRead", hideRead);
  store.set("inAppReader", inAppReader);
  store.set("hiddenSites", [...hiddenSites]);
  modal.hidden = true;
  renderLimit = PAGE_SIZE;
  if (data) render();
}

$("btn-close-settings").onclick = closeSettings;
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeSettings();
});

function renderSiteToggles() {
  const box = $("site-toggles");
  box.textContent = "";
  if (!data) return;
  for (const site of data.sites) {
    const label = document.createElement("label");
    label.className = "row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !hiddenSites.has(site.name);
    cb.onchange = () => {
      if (cb.checked) hiddenSites.delete(site.name);
      else hiddenSites.add(site.name);
    };
    const name = document.createElement("span");
    name.textContent = site.name;
    const cat = document.createElement("span");
    cat.className = "cat";
    cat.textContent = site.category;
    label.append(cb, name, cat);
    box.appendChild(label);
  }
}

$("btn-clear-read").onclick = () => {
  readList = [];
  readSet.clear();
  store.set("read", readList);
  if (data) render();
};

// ---- プルリフレッシュ ----
(() => {
  const ptr = $("ptr");
  let startY = null;
  let pulled = false;

  window.addEventListener("touchstart", (e) => {
    if (window.scrollY === 0 && modal.hidden && !readerOpen) {
      startY = e.touches[0].clientY;
      pulled = false;
    } else {
      startY = null;
    }
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 70) {
      pulled = true;
      ptr.classList.add("visible");
    } else {
      ptr.classList.remove("visible");
      pulled = false;
    }
  }, { passive: true });

  window.addEventListener("touchend", async () => {
    if (pulled) {
      ptr.classList.add("loading");
      await loadData(true);
      ptr.classList.remove("loading", "visible");
    } else {
      ptr.classList.remove("visible");
    }
    startY = null;
    pulled = false;
  });
})();

// ---- 自動更新 ----
setInterval(() => {
  if (document.visibilityState === "visible") loadData();
}, AUTO_REFRESH_MS);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastFetched > AUTO_REFRESH_MS) {
    loadData();
  }
});

// ---- Service Worker (自動更新付き) ----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .then((reg) => {
      // 起動時・フォアグラウンド復帰時・定期的に新バージョンを確認する
      reg.update().catch(() => {});
      setInterval(() => reg.update().catch(() => {}), AUTO_REFRESH_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    })
    .catch(() => {});

  // 新しいService Workerが有効化されたら自動リロードして即時反映
  // (初回インストール時のcontrollerchangeではリロードしない)
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    location.reload();
  });
}

$("app-ver").textContent = `v${APP_VERSION}`;
loadData();

"use strict";

// リユースのタブ: リユース業界のニュース (reuse.json。scripts/fetch-reuse.mjs が30分ごとに作る) を新しい順に並べる。
// 分類で絞り込めて、前に見たときより新しい記事には NEW の印を付ける。見出しを押すと元の記事が開く
(() => {
  const $ = (id) => document.getElementById(id);
  const body = $("ru-body");
  const STALE_MS = 5 * 60 * 1000;
  const WEEK = "日月火水木金土";
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
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

  let data = null;
  let loadedAt = 0;
  let loading = null;
  let cat = store.get("reuseCat", "all");
  // 前に見たときの一番新しい記事の時刻。これより新しい記事が NEW (このタブを開いている間は変えない)
  let seenUntil = store.get("reuseSeen", 0);

  const pad = (n) => String(n).padStart(2, "0");
  const dayKey = (ts) => {
    const d = new Date(ts);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  };
  function dayLabel(ts) {
    const d = new Date(ts);
    const diff = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
    const date = `${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
    return diff === 0 ? `今日 <small>${date}</small>` : diff === 1 ? `昨日 <small>${date}</small>` : date;
  }
  const timeOf = (ts) => {
    const d = new Date(ts);
    return `${d.getHours()}:${pad(d.getMinutes())}`;
  };

  function render() {
    if (!data) return;
    const cats = [{ id: "all", name: "すべて" }, ...data.cats];
    if (!cats.some((c) => c.id === cat)) cat = "all";
    const count = (id) => data.items.filter((it) => id === "all" || it.c === id).length;
    const name = Object.fromEntries(data.cats.map((c) => [c.id, c.name]));
    const items = data.items.filter((it) => cat === "all" || it.c === cat);
    const fresh = data.items.filter((it) => it.ts > seenUntil).length;
    const u = new Date(data.updated);
    $("ru-sub").textContent = `${u.getMonth() + 1}/${u.getDate()} ${timeOf(data.updated)} 更新 · 直近7日の${data.items.length}件${seenUntil && fresh ? ` · 新着${fresh}件` : ""}`;

    let html = `<div class="ru-chips" role="group" aria-label="分類">${cats
      .map((c) => `<button type="button" class="ru-chip" data-cat="${esc(c.id)}" aria-pressed="${c.id === cat}">${esc(c.name)}<small>${count(c.id)}</small></button>`)
      .join("")}</div>`;
    if (!items.length) html += `<p class="ru-empty">この分類の記事は、直近7日にはありません。</p>`;
    let day = 0;
    for (const it of items) {
      if (dayKey(it.ts) !== day) {
        if (day) html += "</ul></section>";
        day = dayKey(it.ts);
        html += `<section class="ru-day"><h2>${dayLabel(it.ts)}</h2><ul class="ru-list">`;
      }
      const isNew = seenUntil && it.ts > seenUntil;
      html += `<li><a href="${esc(it.u)}" target="_blank" rel="noopener noreferrer">
        <span class="ru-title">${isNew ? '<b class="ru-new">NEW</b>' : ""}${esc(it.t)}</span>
        <span class="ru-meta"><span class="ru-src">${esc(it.s)}</span><span>${timeOf(it.ts)}</span>${cat === "all" ? `<span class="ru-cat c-${esc(it.c)}">${esc(name[it.c] ?? "")}</span>` : ""}${it.n > 1 ? `<span>${it.n}媒体</span>` : ""}</span>
      </a></li>`;
    }
    if (day) html += "</ul></section>";
    html += `<p class="ru-credit">Google ニュースの検索結果から集めています。見出しを押すと、元の記事が開きます。</p>`;
    body.innerHTML = html;
  }

  function load(manual = false) {
    if (loading) return loading;
    loading = (async () => {
      if (!data) body.innerHTML = `<p class="ru-empty">読み込み中…</p>`;
      try {
        const res = await fetch(`./reuse.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = await res.json();
        if (!Array.isArray(next.items) || !Array.isArray(next.cats)) throw new Error("bad data");
        // リンクは https のものだけを使う
        next.items = next.items.filter((it) => typeof it.u === "string" && /^https:\/\//.test(it.u) && typeof it.t === "string");
        data = next;
        loadedAt = Date.now();
        render();
        // 次に開いたときのために、ここまで見たことを覚える (今回の NEW の印はそのまま)
        if (data.items.length) store.set("reuseSeen", Math.max(seenUntil, data.items[0].ts));
      } catch {
        if (!data) body.innerHTML = `<p class="ru-empty">ニュースを読み込めませんでした。通信環境を確認して、下に引っ張って更新してください。</p>`;
        else if (manual) $("ru-sub").textContent = "更新できませんでした。通信環境を確認してください";
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  body.addEventListener("click", (e) => {
    const chip = e.target.closest(".ru-chip");
    if (!chip) return;
    cat = chip.dataset.cat;
    store.set("reuseCat", cat);
    render();
  });

  const onShow = () => {
    if (!data || Date.now() - loadedAt > STALE_MS) load();
  };
  document.addEventListener("viewchange", (e) => {
    if (e.detail === "reuse") onShow();
    else if (data?.items.length) seenUntil = Math.max(seenUntil, data.items[0].ts); // タブを離れたら、見た分の NEW を外す
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && window.World?.view() === "reuse") onShow();
  });
  if (window.World?.view() === "reuse") onShow();

  window.Reuse = { refresh: () => load(true) };
})();

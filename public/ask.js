"use strict";

// ワールドの記事の「AIに質問」。world.js が記事の画面に箱を作り、Ask.mount(箱, 記事) で中身を入れる。
// 読む人が自分で用意した Claude の APIキー (設定の画面で入れる) を使い、ブラウザから直接 Anthropic の API に質問する。
// キーはこの端末の localStorage にだけ置き、送り先は api.anthropic.com だけ (公式の SDK を使う)
(() => {
  // 公式の SDK (@anthropic-ai/sdk) をブラウザ用に1つのファイルにまとめたもの。質問するときに初めて読み込む
  const SDK_URL = "./vendor/anthropic-sdk-1.3.0.js";
  // 料金はドル / 100万トークン (cw は5分のキャッシュに書き込む分、cr はキャッシュから読む分)
  const MODELS = {
    opus: { id: "claude-opus-5-5", name: "Claude Opus 5.5", short: "Opus 5.5", price: { in: 4, out: 20, cw: 5, cr: 0.2 } },
    haiku: { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", short: "Haiku 5.5", price: { in: 0.1, out: 0.5, cw: 0.125, cr: 0.01 } },
  };
  const YEN = 150; // 料金の目安を円で出すときの1ドル
  const SEARCH_USD = 0.01; // ウェブ検索1回の料金 (1000回で10ドル)
  const MAX_TOKENS = 12000; // 1回の答えの上限 (考える分もふくむ)
  const KEEP_TURNS = 6; // 続けて聞くときに一緒に送る、前のやりとりの数
  const KEEP_ARTICLES = 40; // 質問の履歴を残す記事の数
  const MAX_Q = 600; // 自由な質問の長さの上限 (文字)
  const LOCATION = { type: "approximate", country: "JP", timezone: "Asia/Tokyo" }; // ウェブ検索で日本の結果を優先してもらう

  // 選ぶだけで聞ける質問。label がボタンと画面に出る文、q が実際に送る文。
  // only / not は地域で出し分ける (日本の記事には「日本への影響」の代わりに「海外から見ると」を出す)
  const PRESETS = [
    { label: "どんな影響がある？", q: "このニュースによって、どんな影響が考えられますか？関係する人や業界、国などへの影響を、わかりやすく整理してください。" },
    { label: "世の中・暮らしへの影響は？", q: "このニュースは、世の中や私たちのふだんの暮らしに、どんな影響がありそうですか？身近な例を挙げて教えてください。" },
    { label: "日本への影響は？", not: "japan", q: "このニュースは、日本や日本に住む人に、どんな影響がありそうですか？" },
    { label: "海外から見ると？", only: "japan", q: "このニュースは、海外からどう見られそうですか？海外への影響や、ほかの国の似た例があれば教えてください。" },
    { label: "なぜ起きた？背景は？", q: "このニュースの背景を教えてください。なぜ今こうなったのか、これまでの流れもふくめて説明してください。" },
    { label: "今後どうなる？", q: "今後どうなりそうですか？考えられる展開と、これから注目すべき点を教えてください。" },
    { label: "賛成・反対の意見は？", q: "このニュースについて、どんな賛成の意見と、反対や心配の意見がありますか？立場ごとに公平に整理してください。" },
    { label: "やさしく説明して", q: "このニュースを、中学生にもわかるように、やさしい言葉で説明してください。難しい言葉の意味も教えてください。" },
    { label: "私たちにできることは？", q: "このニュースに関して、私たち一人ひとりが知っておくとよいことや、できること・備えておくとよいことはありますか？" },
  ];

  // AIへの指示 (どの記事でも同じ)。記事の中身は別のブロックで渡す
  const RULES = [
    "あなたは、ニュースアプリ「わろたんてな」の中で、記事を読んだ人の質問に答える解説役です。読む人は専門家ではない一般の人で、スマートフォンで読みます。",
    "",
    "答え方:",
    "- やさしい日本語で答えてください。専門用語を使うときは、短い説明を添えてください。",
    "- はじめの1〜2文で質問への答え（結論）を言い、そのあとに理由や具体例を続けてください。",
    "- 長さは400〜800字くらいを目安にしてください。くわしく聞かれたときは、長くしてもかまいません。",
    "- 短い段落と箇条書きで書いてください。見出しは「## 」、強調は「**」で書き、表は使わないでください。",
    "- 記事に書いてあることと、あなたの推測や一般的な見方を分けて書いてください（例:「記事によると〜」「〜と考えられます」）。",
    "- 影響や今後の見通しは、決まったことのように言い切らず、考えられる可能性として書いてください。",
    "- 意見が分かれる話題では、どちらかに肩入れせず、主な立場をそれぞれ公平に紹介してください。",
    "- わからないことは、わからないと書いてください。数字や名前、出来事を作らないでください。",
    "- あなたの知識は、学習した時点までのものです。それより新しい出来事は、記事やウェブ検索の結果を正しいものとして扱ってください。記事があなたの知識と食い違うときは、記事のほうが新しい情報だと考えてください。",
    "- ウェブ検索が使えるときは、記事より新しい情報や、確かめたい事実を調べるのに使ってください。",
    "- 前置きやあいさつ、質問の言いかえは省いてください。",
  ].join("\n");

  const ICONS = {
    spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>',
  };

  // ---- 保存 (この端末の localStorage) ----

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
        return true;
      } catch {
        return false;
      }
    },
    del(key) {
      try {
        localStorage.removeItem(key);
      } catch {}
    },
  };
  const getKey = () => {
    const k = store.get("askKey", "");
    return typeof k === "string" ? k : "";
  };
  const getModel = () => (store.get("askModel", "opus") === "haiku" ? "haiku" : "opus");

  // 質問の履歴: { 記事ID: { title, at, turns: [{ q, p, a, src, sk, m, by, ns, usd, at, end }] } }
  // q はボタンの文 (画面に出す)、p は送った文、a は答え、src は参考にしたページ
  function allHist() {
    const v = store.get("askHist", {});
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }
  function turnsOf(id) {
    const t = allHist()[id]?.turns;
    return Array.isArray(t) ? t.filter((x) => x && typeof x.q === "string" && typeof x.a === "string") : [];
  }
  function saveTurn(id, title, turn) {
    const all = allHist();
    const rec = all[id] && Array.isArray(all[id].turns) ? all[id] : { turns: [] };
    rec.turns = [...rec.turns, turn].slice(-20);
    rec.title = title;
    rec.at = Date.now();
    all[id] = rec;
    // 長く開いていない記事の履歴から消す (入りきらないときは半分まで減らす)
    const ids = Object.keys(all).sort((a, b) => (all[b]?.at || 0) - (all[a]?.at || 0));
    for (const old of ids.slice(KEEP_ARTICLES)) delete all[old];
    if (!store.set("askHist", all)) {
      for (const old of ids.slice(KEEP_ARTICLES / 4)) if (old !== id) delete all[old];
      store.set("askHist", all);
    }
  }

  // 今月使った金額の目安 (この端末から質問した分)
  const thisMonth = () => {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}`;
  };
  function spend() {
    const s = store.get("askSpend", null);
    return s && s.m === thisMonth() && Number.isFinite(s.usd) ? s : { m: thisMonth(), usd: 0, n: 0 };
  }
  function addSpend(usd) {
    const s = spend();
    s.usd += usd;
    s.n += 1;
    store.set("askSpend", s);
    showSpend();
  }

  // ---- 小さな道具 ----

  const $ = (id) => document.getElementById(id);
  // 要素を作る。文字列の子要素はテキストとして入る (AIの答えをHTMLとして解釈しない)
  function h(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v; // こちらで用意したアイコンだけに使う
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c);
    return e;
  }
  const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
  const host = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const smooth = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
  const pad = (n) => String(n).padStart(2, "0");
  const WEEK = "日月火水木金土";
  const dateJa = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
  const when = (ts) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  function yen(usd) {
    const y = usd * YEN;
    if (y < 0.1) return "0.1円未満";
    return y < 10 ? `約${y.toFixed(1)}円` : `約${Math.round(y)}円`;
  }
  // 答えたモデルの名前 (ふだんは選んだモデル。安全のための仕組みで別のモデルが答えたときはその名前)
  function modelName(id) {
    const known = Object.values(MODELS).find((m) => m.id === id);
    if (known) return known.short;
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id || "");
    return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id || "";
  }

  // SDK は最初に使うときに読み込む (失敗したら次にまた試す)
  let sdkReq = null;
  const sdk = () =>
    (sdkReq ??= import(SDK_URL)
      .then((m) => m.default)
      .catch((err) => {
        sdkReq = null;
        throw err;
      }));

  // ---- AIの答え (かんたんなマークダウン) を要素にする ----
  // HTMLとして解釈せずに、見出し・箇条書き・太字・リンクだけを生かす

  function inline(s) {
    const out = [];
    const re = /\*\*([^*]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      if (m[1] != null) out.push(h("strong", {}, m[1]));
      else out.push(h("a", { href: m[3], target: "_blank", rel: "noopener noreferrer" }, m[2]));
      last = re.lastIndex;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  }

  function md(text) {
    const frag = document.createDocumentFragment();
    let list = null; // 作っている途中の箇条書き { el, ordered }
    let para = null; // 作っている途中の段落
    for (const raw of String(text || "").replace(/\r/g, "").split("\n")) {
      const line = raw.trim();
      if (!line) {
        list = para = null;
        continue;
      }
      let m;
      if ((m = /^#{1,6}\s+(.+)$/.exec(line))) {
        list = para = null;
        frag.append(h("h4", {}, inline(m[1].replace(/\*\*/g, ""))));
      } else if ((m = /^(?:[-*・•]|(\d+)[.)．])\s+(.+)$/.exec(line))) {
        const ordered = m[1] != null;
        if (!list || list.ordered !== ordered) {
          list = { el: h(ordered ? "ol" : "ul", {}), ordered };
          frag.append(list.el);
        }
        list.el.append(h("li", {}, inline(m[2])));
        para = null;
      } else if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
        list = para = null; // 区切り線は出さない
      } else if (list && /^\s{2,}/.test(raw)) {
        list.el.lastElementChild.append(" ", ...inline(line)); // 箇条書きの続きの行
      } else {
        list = null;
        if (para) para.append(h("br"));
        else frag.append((para = h("p", {})));
        para.append(...inline(line.replace(/^>\s?/, "")));
      }
    }
    return frag;
  }

  // ---- 記事の中身 (AIに渡す) ----

  function articleText({ item: it, region, rank }) {
    const d = it.digest;
    const parts = [
      `今日は${dateJa(new Date())}です。読む人は、ニュースアプリの「${region.name}」の話題（${rank}位）にある、次の記事を開いています。`,
      "",
      "<article>",
      `見出し: ${it.title}`,
      `配信: ${it.source}（${dateJa(new Date(it.ts))} ${when(it.ts).split(" ")[1]}）`,
      it.outlets > 1 ? `このニュースを伝えたメディアの数: ${it.outlets}` : "",
    ];
    if (d?.lead) {
      parts.push(
        `要約（各社の記事の本文から${d.by === "ai" ? "AIが" : ""}まとめたもの）: ${d.lead}`,
        d.points?.length ? `ポイント:\n${d.points.map((p) => `- ${p}`).join("\n")}` : "",
        d.background ? `背景・用語: ${d.background}` : "",
        d.next ? `今後: ${d.next}` : "",
      );
    } else if (it.summary) {
      parts.push(`概要: ${it.summary}`);
    }
    if (it.coverage?.length) parts.push(`ほかのメディアの見出し:\n${it.coverage.slice(0, 8).map((c) => `- ${c.s}: ${c.t}`).join("\n")}`);
    if (it.url) parts.push(`元記事: ${it.url}`);
    parts.push("</article>");
    return parts.filter((s) => s !== "").join("\n");
  }

  // ---- 答えの読み取り ----

  // 文のブロックをつなげる (ウェブ検索をはさんだときは段落を分ける)
  function textOf(blocks) {
    let out = "";
    let gap = false;
    for (const b of blocks) {
      if (b.type === "text") {
        if (gap && out && !/\s$/.test(out)) out += "\n\n";
        out += b.text || "";
        gap = false;
      } else if (b.type !== "fallback") gap = true;
    }
    return out;
  }
  // 参考にしたページ (答えの中で引用したもの。なければ検索で見つかったもの)
  function sourcesOf(blocks) {
    const cited = new Map();
    for (const b of blocks)
      if (b.type === "text") for (const c of b.citations ?? []) if (safeUrl(c.url) && !cited.has(c.url)) cited.set(c.url, c.title || "");
    if (cited.size) return { kind: "cite", list: [...cited].slice(0, 8).map(([u, t]) => ({ u, t })) };
    const found = new Map();
    for (const b of blocks)
      if (b.type === "web_search_tool_result" && Array.isArray(b.content))
        for (const r of b.content) if (r.type === "web_search_result" && safeUrl(r.url) && !found.has(r.url)) found.set(r.url, r.title || "");
    return { kind: "found", list: [...found].slice(0, 5).map(([u, t]) => ({ u, t })) };
  }
  // いま何をしているか (答えの文が出てくるまでの表示)
  function phase(content) {
    const last = content.at(-1);
    if (!last || last.type === "thinking" || last.type === "redacted_thinking" || last.type === "fallback") return "考えています…";
    if (last.type === "server_tool_use") {
      const q = last.name === "web_search" && typeof last.input?.query === "string" ? last.input.query.trim() : "";
      return q ? `「${q}」を検索しています…` : "ウェブで調べています…";
    }
    return last.type === "text" ? "" : "調べた結果を読んでいます…";
  }
  // 途中で止まった (pause_turn) 答えの続きを頼むときに送り返すブロック。
  // 安全のための仕組みで途中から別のモデルに替わったときは、替わる前の考えの途中などを省く
  function echoable(blocks) {
    const cut = blocks.map((b) => b.type).lastIndexOf("fallback");
    if (cut < 0) return blocks;
    const answered = new Set(blocks.map((b) => b.tool_use_id).filter(Boolean));
    return blocks.filter((b, i) => {
      if (i > cut) return true;
      if (["fallback", "thinking", "redacted_thinking", "tool_use"].includes(b.type)) return false;
      if (b.type === "server_tool_use") return answered.has(b.id);
      return true;
    });
  }
  const usageParts = (usage) => usage.flatMap((u) => (Array.isArray(u?.iterations) && u.iterations.length ? u.iterations : [u ?? {}]));
  const searchesOf = (usage) => usage.reduce((n, u) => n + (u?.server_tool_use?.web_search_requests || 0), 0);
  function costOf(usage, model) {
    const p = MODELS[model].price;
    const tokens = usageParts(usage).reduce(
      (s, u) =>
        s +
        (u.input_tokens || 0) * p.in +
        (u.output_tokens || 0) * p.out +
        (u.cache_creation_input_tokens || 0) * p.cw +
        (u.cache_read_input_tokens || 0) * p.cr,
      0,
    );
    return tokens / 1e6 + searchesOf(usage) * SEARCH_USD;
  }
  const servedBy = (msg, model) =>
    (msg.usage?.iterations ?? []).some((e) => e.type === "fallback_message") && msg.model !== MODELS[model].id ? msg.model : undefined;

  // うまくいかなかったときの説明 (SDK の種類別のエラーで見分ける)
  function explain(err, A) {
    if (!A) return { msg: "AIの部品を読み込めませんでした。通信できるところで、もう一度お試しください。" };
    if (err instanceof A.AuthenticationError) return { msg: "APIキーが正しくないようです。設定で、キーを入れ直してください。", key: true };
    if (err instanceof A.PermissionDeniedError) return { msg: "このAPIキーでは使えないようです。Claude Console で、キーの設定を確かめてください。", key: true };
    if (err instanceof A.APIError && (err.status === 402 || err.type === "billing_error"))
      return { msg: "クレジット（前払いの残高）が足りないか、支払いの設定に問題があるようです。Claude Console の「Billing」を確かめてください。" };
    if (err instanceof A.RateLimitError) return { msg: "短い時間に質問が多すぎるか、使える上限に達しました。少し待ってから、もう一度お試しください。" };
    if (err instanceof A.InternalServerError || err?.type === "overloaded_error" || err?.type === "api_error")
      return { msg: "AIが混み合っているようです。少し待ってから、もう一度お試しください。" };
    if (err instanceof A.NotFoundError) return { msg: "選んだAIが見つかりませんでした。設定の「AIの種類」を変えて、お試しください。" };
    if (err instanceof A.APIConnectionError) return { msg: "通信できませんでした。電波の良いところで、もう一度お試しください。" };
    if (err instanceof A.APIError) return { msg: "質問をうまく送れませんでした。くわしい理由（英語）:", detail: err.message };
    return { msg: "答えをうまく受け取れませんでした。もう一度お試しください。", detail: String(err?.message ?? err) };
  }

  // ---- 画面 ----

  const views = new Map(); // 記事ID → 画面 (記事を開き直すたびに新しい箱になる)
  const live = new Map(); // 記事ID → 答えを受け取っている途中の質問
  const errors = new Map(); // 記事ID → うまくいかなかった質問 (もう一度ためせるように残す)

  function mount(box, ctx) {
    for (const [id, v] of views) if (!v.box.isConnected) views.delete(id);
    const v = { box, ctx, id: ctx.item.id };
    views.set(v.id, v);
    build(v);
  }

  function build(v) {
    const { box, ctx } = v;
    box.textContent = "";
    v.chips = PRESETS.filter((p) => (p.only ? p.only === ctx.region.id : p.not !== ctx.region.id)).map((p) =>
      h("button", { type: "button", class: "ask-chip", onclick: () => submit(v, p.label, p.q) }, p.label),
    );
    v.input = h("textarea", {
      rows: 1,
      maxlength: MAX_Q,
      placeholder: "自由に質問を書く",
      "aria-label": "AIへの質問",
      enterkeyhint: "send",
      oninput: () => grow(v.input),
      onkeydown: (e) => {
        // 日本語の変換を確定する Enter では送らない。パソコンでは Enter で送り、Shift+Enter で改行する
        if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
        if (e.ctrlKey || e.metaKey || (!e.shiftKey && matchMedia("(pointer: fine)").matches)) {
          e.preventDefault();
          v.form.requestSubmit();
        }
      },
    });
    v.send = h("button", { type: "submit", class: "ask-send", "aria-label": "質問を送る", html: ICONS.send });
    v.form = h(
      "form",
      {
        class: "ask-form",
        onsubmit: (e) => {
          e.preventDefault();
          const q = v.input.value.trim();
          if (!q) return v.input.focus();
          if (submit(v, q, q)) {
            v.input.value = "";
            grow(v.input);
          }
        },
      },
      v.input,
      v.send,
    );
    v.web = h("input", { type: "checkbox", checked: store.get("askWeb", false) === true, onchange: (e) => store.set("askWeb", e.target.checked) });
    v.clear = h("button", { type: "button", class: "ask-clear", onclick: () => clearArticle(v) }, "この記事の質問を消す");
    v.setup = getKey() ? null : setupEl();
    v.log = h("div", { class: "ask-log" });
    // キーがあるときの v.setup は null (append に null を渡すと「null」の文字が入るので除く)
    const parts = [
      h("h3", { class: "ask-h", id: "ask-h" }, h("span", { class: "ask-icon", html: ICONS.spark }), "AIに質問"),
      h("p", { class: "ask-lead" }, "この記事について、AI（Claude）に聞けます。下から選ぶか、自由に書いてください。"),
      v.setup,
      v.log,
      h("div", { class: "ask-chips", role: "group", "aria-label": "質問の例" }, v.chips),
      v.form,
      h(
        "div",
        { class: "ask-opts" },
        h("label", { class: "ask-web" }, v.web, h("span", {}, "ウェブでも調べる", h("small", {}, "最新の情報を探します（料金は少し高め）"))),
      ),
      h("p", { class: "ask-foot" }, `${MODELS[getModel()].name} が答えます（設定で変えられます）。AIの答えはまちがえることがあるので、大事なことは元記事などで確かめてください。`, " ", v.clear),
    ];
    box.append(...parts.filter(Boolean));
    paint(v);
  }

  // 質問と答えの一覧を描き直す
  function paint(v) {
    v.log.textContent = "";
    for (const t of turnsOf(v.id)) v.log.append(turnEl(t));
    const err = errors.get(v.id);
    if (err) v.log.append(errorEl(v, err));
    const job = live.get(v.id);
    if (job) {
      job.view = liveEl(job);
      v.log.append(job.view.wrap);
      draw(job, true);
    }
    controls(v);
  }

  // ボタンの状態 (答えを待っている間は次の質問を受け付けない)
  function controls(v) {
    const turns = turnsOf(v.id);
    const busy = live.has(v.id);
    const asked = new Set(turns.map((t) => t.q));
    for (const c of v.chips) {
      c.disabled = busy;
      c.classList.toggle("done", asked.has(c.textContent));
    }
    v.send.disabled = busy;
    v.clear.hidden = busy || !turns.length;
  }

  const qEl = (q) => h("p", { class: "ask-q" }, q);

  function turnEl(t) {
    const src = Array.isArray(t.src) ? t.src.filter((s) => safeUrl(s?.u)) : [];
    const meta = [
      t.by ? `${modelName(t.by)} が回答` : MODELS[t.m]?.short,
      t.ns ? `ウェブ検索${t.ns}回` : "",
      Number.isFinite(t.usd) ? yen(t.usd) : "",
      t.at ? when(t.at) : "",
    ].filter(Boolean);
    return h(
      "div",
      { class: "ask-turn" },
      qEl(t.q),
      h(
        "div",
        { class: "ask-a" },
        h("div", { class: "ask-md" }, md(t.a)),
        t.end === "cut" ? h("p", { class: "ask-note" }, "長くなったため、ここで終わっています。") : null,
        t.end === "stop" ? h("p", { class: "ask-note" }, "ここで止めました。") : null,
        src.length
          ? h(
              "details",
              { class: "ask-src" },
              h("summary", {}, `${t.sk === "found" ? "検索で見つかったページ" : "参考にしたページ"}（${src.length}）`),
              h(
                "ul",
                {},
                src.map((s) => h("li", {}, h("a", { href: s.u, target: "_blank", rel: "noopener noreferrer" }, s.t || host(s.u)), h("small", {}, host(s.u)))),
              ),
            )
          : null,
        h("div", { class: "ask-meta" }, meta.join(" · ")),
      ),
    );
  }

  function errorEl(v, e) {
    return h(
      "div",
      { class: "ask-turn" },
      qEl(e.q),
      h(
        "div",
        { class: "ask-a ask-err", role: "alert" },
        h("p", {}, e.msg),
        e.detail ? h("p", { class: "ask-detail" }, e.detail) : null,
        h(
          "div",
          { class: "ask-btns" },
          e.key ? h("a", { class: "ask-btn", href: "#/settings", onclick: goSettings }, "設定を開く") : null,
          h(
            "button",
            {
              type: "button",
              class: "ask-btn",
              onclick: () => {
                errors.delete(v.id);
                if (!submit(v, e.q, e.p)) paint(v);
              },
            },
            "もう一度聞く",
          ),
        ),
      ),
    );
  }

  function liveEl(job) {
    const status = h("p", { class: "ask-status" }, h("i", { class: "ask-dots", "aria-hidden": "true" }), h("span", {}, ""));
    const body = h("div", { class: "ask-md" });
    const wrap = h(
      "div",
      { class: "ask-turn live" },
      qEl(job.q),
      h(
        "div",
        { class: "ask-a", "aria-busy": "true" },
        body,
        status,
        h(
          "div",
          { class: "ask-meta" },
          h("span", {}, `${MODELS[job.model].short}${job.web ? " · ウェブ検索あり" : ""}`),
          h("button", { type: "button", class: "ask-stop", onclick: () => stop(job) }, "止める"),
        ),
      ),
    );
    return { wrap, status, body };
  }

  // 受け取った答えを画面に出す (文字が届くたびではなく、画面の書き換え1回分ずつまとめる)
  function draw(job, now = false) {
    const run = () => {
      job.raf = 0;
      if (!job.view) return;
      job.view.body.replaceChildren(md(job.text));
      job.view.status.hidden = !job.status;
      job.view.status.lastChild.textContent = job.status;
    };
    if (now) {
      cancelAnimationFrame(job.raf);
      run();
    } else if (!job.raf) job.raf = requestAnimationFrame(run);
  }

  function setupEl() {
    return h(
      "div",
      { class: "ask-setup" },
      h("p", {}, h("b", {}, "使うには、Claude の APIキーが必要です。"), "設定の「AIに質問」で、キーを入れてください。"),
      h("a", { class: "ask-btn primary", href: "#/settings", onclick: goSettings }, "設定を開く"),
      h("p", { class: "ask-small" }, "キーはこの端末の中にだけ保存し、Anthropic（Claude を作っている会社）にだけ送ります。質問するたびに、少し料金がかかります。"),
    );
  }
  // 設定の画面に切り替わったあとで、AIの欄まで動かす (切り替えは world.js がリンクから行う)
  function goSettings() {
    setTimeout(() => $("s-ai")?.scrollIntoView({ block: "start", behavior: smooth() }), 320);
  }
  function needKey(v) {
    if (!v.setup) {
      v.setup = setupEl();
      v.log.before(v.setup);
    }
    v.setup.scrollIntoView({ block: "center", behavior: smooth() });
    v.setup.classList.remove("pulse");
    void v.setup.offsetWidth; // アニメーションを最初からやり直す
    v.setup.classList.add("pulse");
  }

  function grow(t) {
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 168)}px`;
  }

  function clearArticle(v) {
    const all = allHist();
    delete all[v.id];
    store.set("askHist", all);
    errors.delete(v.id);
    paint(v);
  }

  // ---- 質問する ----

  function submit(v, label, prompt) {
    if (live.has(v.id)) return false;
    if (!getKey()) {
      needKey(v);
      return false;
    }
    errors.delete(v.id);
    ask(v, label, prompt.slice(0, MAX_Q));
    // 新しい質問が画面の上に来るように動かす (答えはその下に出てくる)
    requestAnimationFrame(() => live.get(v.id)?.view?.wrap.scrollIntoView({ block: "start", behavior: smooth() }));
    return true;
  }

  function stop(job) {
    job.stopped = true;
    job.stream?.abort();
  }

  async function ask(v, label, prompt) {
    const { id, ctx } = v;
    const model = getModel();
    const web = v.web.checked;
    const job = { q: label, p: prompt, model, web, text: "", status: "考えています…", stream: null, stopped: false, view: null, raf: 0 };
    live.set(id, job);
    paint(v);

    let A = null;
    let blocks = []; // 受け取ったブロック (途中で止まって続きを頼んだときは、前の分もふくむ)
    let saved = null;
    try {
      A = await sdk();
      if (job.stopped) throw new Error("stopped");
      const client = new A({ apiKey: getKey(), dangerouslyAllowBrowser: true });
      // 前のやりとりは、文だけを送る (AIの考えの途中は送らない)
      const messages = [];
      for (const t of turnsOf(id).slice(-KEEP_TURNS)) messages.push({ role: "user", content: t.p || t.q }, { role: "assistant", content: t.a || "（答えなし）" });
      messages.push({ role: "user", content: prompt });
      const params = {
        model: MODELS[model].id,
        max_tokens: MAX_TOKENS,
        output_config: { effort: "low" }, // 考えすぎず、早く答える
        cache_control: { type: "ephemeral" }, // 続けて聞くとき、同じ部分を安く読み直す
        system: [
          { type: "text", text: RULES },
          { type: "text", text: articleText(ctx) },
        ],
        messages,
      };
      // 安全のための仕組みで断られたとき、Anthropic が選んだ別のモデルで答え直してもらう (Opus のみ)
      if (model === "opus") Object.assign(params, { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
      if (web)
        params.tools = [
          model === "opus"
            ? { type: "web_search_20260209", name: "web_search", max_uses: 3, user_location: LOCATION }
            : { type: "web_search_20250305", name: "web_search", max_uses: 3, user_location: LOCATION },
        ];

      const usage = [];
      const done = [];
      let msg = null;
      for (let round = 0; round < 3; round++) {
        const stream = client.beta.messages.stream(
          done.length ? { ...params, messages: [...messages, { role: "assistant", content: echoable(done) }] } : params,
        );
        job.stream = stream;
        if (job.stopped) stream.abort();
        stream.on("streamEvent", (_event, snapshot) => {
          blocks = [...done, ...snapshot.content];
          job.text = textOf(blocks);
          job.status = phase(snapshot.content);
          draw(job);
        });
        msg = await stream.finalMessage();
        usage.push(msg.usage);
        blocks = [...done, ...msg.content];
        if (msg.stop_reason !== "pause_turn") break;
        done.push(...msg.content); // 検索が長くかかって途中で止まった: ここまでの答えを送り返して続けてもらう
      }

      const usd = costOf(usage, model);
      addSpend(usd);
      // 断られたときは、途中まで出ていた答えも使わない
      if (msg.stop_reason === "refusal") {
        errors.set(id, { q: label, p: prompt, msg: "この質問には答えられませんでした。聞き方を変えてみてください。" });
      } else {
        const src = sourcesOf(blocks);
        saved = {
          q: label,
          p: prompt,
          a: textOf(blocks).trim() || "（答えが空でした）",
          src: src.list,
          sk: src.kind,
          m: model,
          by: servedBy(msg, model),
          ns: searchesOf(usage),
          usd,
          at: Date.now(),
          end: msg.stop_reason === "max_tokens" ? "cut" : msg.stop_reason === "pause_turn" ? "cut" : undefined,
        };
      }
    } catch (err) {
      if (job.stopped) {
        // 止めたときは、そこまでの答えを残す (料金はわからないので数えない)
        const text = textOf(blocks).trim();
        if (text) saved = { q: label, p: prompt, a: text, src: [], m: model, at: Date.now(), end: "stop" };
      } else {
        errors.set(id, { q: label, p: prompt, ...explain(err, A) });
      }
    } finally {
      cancelAnimationFrame(job.raf);
      live.delete(id);
    }
    if (saved) saveTurn(id, ctx.item.title, saved);

    // 記事を開いたままなら、途中の表示を答えに入れ替える (閉じていれば、次に開いたときに出る)
    const cur = views.get(id);
    if (!cur?.box.isConnected) return;
    const el = job.view?.wrap;
    if (el?.isConnected && cur.log.contains(el)) {
      const err = errors.get(id);
      const next = saved ? turnEl(saved) : err ? errorEl(cur, err) : null;
      if (next) el.replaceWith(next);
      else el.remove();
      controls(cur);
    } else paint(cur);
  }

  // キーや AIの種類を変えたら、開いている記事の箱も作り直す
  function refreshAll() {
    for (const v of views.values()) if (v.box.isConnected) build(v);
  }

  // ---- 設定の画面 ----

  const mask = (k) => `${k.slice(0, 7)}…${k.slice(-4)}`;

  function showSpend() {
    const el = $("ai-spend");
    if (!el) return;
    const s = spend();
    el.textContent = s.n ? `${yen(s.usd)}（${s.n}回）` : "0円";
  }

  function bindSettings() {
    const form = $("ai-key-form");
    if (!form) return;
    const input = $("ai-key");
    const msg = $("ai-key-msg");
    const state = $("ai-key-state");
    const del = $("ai-key-del");
    const save = form.querySelector("button[type=submit]");
    const say = (text, ok = false) => {
      msg.textContent = text;
      msg.classList.toggle("ok", ok);
    };
    const show = () => {
      const k = getKey();
      state.textContent = k ? `設定済み（${mask(k)}）` : "まだ入っていません";
      state.classList.toggle("on", !!k);
      del.hidden = !k;
      input.placeholder = k ? "キーを変えるときは、ここに貼り付け" : "sk-ant- で始まるキーを貼り付け";
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const k = input.value.replace(/\s+/g, "");
      if (!k) return say("キーを貼り付けてください");
      if (!/^sk-ant-[\w-]{20,}$/.test(k)) return say("Claude の APIキーではないようです（sk-ant- で始まる、長い文字です）");
      save.disabled = true;
      say("キーを確かめています…");
      let A = null;
      try {
        // 料金のかからない「モデルの情報を見る」で、キーが使えるか確かめる
        A = await sdk();
        await new A({ apiKey: k, dangerouslyAllowBrowser: true, maxRetries: 1 }).models.retrieve(MODELS.opus.id);
        store.set("askKey", k);
        input.value = "";
        say("保存しました。ワールドの記事で質問できます", true);
      } catch (err) {
        if (A && err instanceof A.AuthenticationError) say("このキーは使えないようです。Claude Console でコピーし直して、貼り付けてください");
        else if (A && err instanceof A.PermissionDeniedError) say("このキーには、使う権限がないようです。Claude Console でキーを確かめてください");
        else {
          // 通信できないなどで確かめられなかったときは、保存だけしておく
          store.set("askKey", k);
          input.value = "";
          say("通信できず、キーを確かめられませんでした。保存はしたので、質問するときに確かめます");
        }
      } finally {
        save.disabled = false;
        show();
        refreshAll();
      }
    });

    del.addEventListener("click", () => {
      store.del("askKey");
      show();
      refreshAll();
      say("この端末からキーを消しました");
    });

    for (const r of document.querySelectorAll('input[name="ai-model"]')) {
      r.checked = r.value === getModel();
      r.addEventListener("change", () => {
        if (!r.checked) return;
        store.set("askModel", r.value);
        refreshAll();
      });
    }

    const clear = $("ai-clear");
    const note = $("ai-clear-note");
    const noteText = note.textContent;
    let timer = 0;
    clear.addEventListener("click", () => {
      store.del("askHist");
      errors.clear();
      refreshAll();
      note.textContent = "消しました";
      clearTimeout(timer);
      timer = setTimeout(() => (note.textContent = noteText), 2000);
    });

    show();
    showSpend();
  }

  bindSettings();
  window.Ask = { mount };
})();

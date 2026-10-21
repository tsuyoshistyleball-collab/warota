// 同じ出来事を伝える記事を1つの「話題」にまとめ、何社が報じたか・新しさ・注目度から話題度を計算する。
// 見出しから内容を表す語 (カタカナ語・英字・漢字2文字の組) を取り出し、
// どの記事にも出る語 (「トランプ」「政府」など) ほど軽く数えて比べる。ひらがなの言い回しは比べない。

const SIM_THRESHOLD = 0.18; // これ以上似ていれば同じ話題とみなす (同じ話題 0.17〜0.7 / 別の話題 0〜0.05 程度)
const MAX_GAP_MS = 36 * 3600_000; // これ以上離れた記事は別の話題とみなす
const HALF_LIFE_H = 16; // 話題度が半分になるまでの時間

// 媒体によって表記が違う語をそろえる
const SPELLINGS = [[/ぜい弱/g, "脆弱"], [/ら致/g, "拉致"], [/だ捕/g, "拿捕"], [/ねつ造/g, "捏造"]];

// 見出しから比較用の語を取り出す
export function terms(title) {
  let s = title.normalize("NFKC").replace(/^(?:【[^】]{1,12}】\s*)+/, "");
  for (const [re, to] of SPELLINGS) s = s.replace(re, to);
  const out = new Map();
  const add = (t, w = 1) => out.set(t, (out.get(t) ?? 0) + w);
  for (const [w] of s.matchAll(/[ァ-ヺー]{2,}/g)) add(w); // カタカナ語 (「キム・ヨジョン」は「キム」「ヨジョン」)
  for (const [w] of s.matchAll(/[A-Za-z][A-Za-z0-9]+/g)) add(w.toUpperCase()); // PHP, FBI, AI
  for (const [w] of s.matchAll(/\d+(?:\.\d+)?(?:号|人|件|割|%|億|万|兆|円|ドル|歳|年|位)/g)) add(w); // 30号, 7割
  for (const [run] of s.matchAll(/\p{Script=Han}+/gu)) {
    if (run.length === 1) add(run, 0.5); // 「北」「露」など1文字は弱めに
    else for (let i = 0; i < run.length - 1; i++) add(run.slice(i, i + 2));
  }
  return out;
}

function vectorize(items) {
  const df = new Map();
  const grams = items.map((it) => terms(it.title));
  for (const g of grams) for (const k of g.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const n = items.length;
  const idf = (k) => Math.log((n + 1) / ((df.get(k) ?? 0) + 1)) + 1;
  // 多くの記事に出る語 (「大統」「政府」など) は候補探しの索引に使わない
  const tooCommon = Math.max(8, n * 0.03);
  return grams.map((g) => {
    const vec = new Map();
    let norm = 0;
    for (const [k, tf] of g) {
      const w = tf * idf(k);
      vec.set(k, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [k, w] of vec) vec.set(k, w / norm);
    const keys = [...g.keys()].filter((k) => df.get(k) > 1 && df.get(k) <= tooCommon);
    return { vec, keys };
  });
}

function cosine(a, b) {
  let s = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, w] of small) {
    const v = large.get(k);
    if (v) s += w * v;
  }
  return s;
}

// items: [{title, ts, ...}] を話題ごとにまとめ、[[item, ...], ...] を返す
export function clusterItems(items) {
  const sorted = [...items].sort((a, b) => b.ts - a.ts);
  const vecs = vectorize(sorted);
  const clusters = []; // {members:[idx], newest}
  const index = new Map(); // 2文字の組 → その語を持つ話題の番号
  sorted.forEach((item, i) => {
    const { vec, keys } = vecs[i];
    const candidates = new Set();
    for (const k of keys) for (const c of index.get(k) ?? []) candidates.add(c);
    let best = -1;
    let bestSim = SIM_THRESHOLD;
    for (const c of candidates) {
      const cl = clusters[c];
      if (cl.newest - item.ts > MAX_GAP_MS) continue;
      for (const m of cl.members) {
        const sim = cosine(vec, vecs[m].vec);
        if (sim >= bestSim) {
          bestSim = sim;
          best = c;
        }
      }
    }
    if (best < 0) {
      best = clusters.length;
      clusters.push({ members: [], newest: item.ts });
    }
    clusters[best].members.push(i);
    for (const k of keys) {
      const list = index.get(k) ?? [];
      if (!list.includes(best)) list.push(best);
      index.set(k, list);
    }
  });
  return clusters.map((c) => c.members.map((i) => sorted[i]));
}

// 話題度 = (報じた媒体の数 + 注目度の加点) × 新しさ
export function trendScore(members, now) {
  const outlets = new Set(members.map((m) => m.outlet));
  let boost = 0;
  if (members.some((m) => m.boost === "topic")) boost += 1.5; // Yahoo!トピックスに選ばれた
  if (members.some((m) => m.boost === "ranking")) boost += 1; // アクセスランキング入り
  // Googleニュースの並び順 (上位ほど主要ニュース)
  const google = members.filter((m) => m.boost === "google");
  if (google.length) boost += Math.max(0, 1.2 - Math.min(...google.map((m) => m.rank ?? 99)) * 0.02);
  const newest = Math.max(...members.map((m) => m.ts));
  const ageH = Math.max(0, (now - newest) / 3600_000);
  return { score: (outlets.size + boost) * 0.5 ** (ageH / HALF_LIFE_H), outlets: outlets.size, newest };
}

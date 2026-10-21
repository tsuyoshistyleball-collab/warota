// 同じ出来事を伝える記事を1つの「話題」にまとめ、何社が報じたか・新しさ・注目度から話題度を計算する。
// 見出しから内容を表す語 (カタカナ語・英字・漢字2文字の組) を取り出し、
// どの記事にも出る語 (「トランプ」「政府」など) ほど軽く数えて比べる。ひらがなの言い回しは比べない。

const SIM_THRESHOLD = 0.16; // これ以上似ていれば同じ話題とみなす (同じ話題 0.17〜0.7 / 別の話題 0〜0.05 程度)
const MAX_GAP_MS = 36 * 3600_000; // これ以上離れた記事は別の話題とみなす
const HALF_LIFE_H = 16; // 話題度が半分になるまでの時間

// 媒体によって表記が違う語をそろえる
const SPELLINGS = [[/ぜい弱/g, "脆弱"], [/ら致/g, "拉致"], [/だ捕/g, "拿捕"], [/ねつ造/g, "捏造"]];

// 多くの別々の話題に共通して出る語。これだけが一致しても同じ話題とはみなさないよう軽く数える
// (「トランプ」「政権」「個人情報流出」が共通するだけの別のニュースがまとまるのを防ぐ)。
// 熟語のまま書いておき、見出しと同じ区切り方で分解する (「情報流出」の継ぎ目の「報流」も軽くなる)
const WEAK_WORDS = [
  // 人名
  "トランプ", "バンス", "ルビオ", "プーチン", "ゼレンスキー", "マクロン", "スターマー", "メルツ", "ネタニヤフ",
  "エルドアン", "習近平", "金正恩", "高市", "石破", "岸田",
  // 国・地域名 (同じ国の別の話題にも出る)
  "アメリカ", "米国", "中国", "韓国", "北朝鮮", "台湾", "日本", "ロシア", "ウクライナ", "イギリス", "英国",
  "フランス", "ドイツ", "イタリア", "イスラエル", "パレスチナ", "イラン", "インド", "欧州", "中東", "アジア",
  // 都道府県名 (同じ県の別のニュースにも出る)
  "北海道", "青森", "岩手", "宮城", "秋田", "山形", "福島", "茨城", "栃木", "群馬", "埼玉", "千葉", "東京", "神奈川",
  "新潟", "富山", "石川", "福井", "山梨", "長野", "岐阜", "静岡", "愛知", "三重", "滋賀", "京都", "大阪", "兵庫",
  "奈良", "和歌山", "鳥取", "島根", "岡山", "広島", "山口", "徳島", "香川", "愛媛", "高知", "福岡", "佐賀", "長崎",
  "熊本", "大分", "宮崎", "鹿児島", "沖縄", "県内", "県警", "市内", "都内", "知事", "市長",
  // 報道の定番語 (同じ種類の別の出来事にも出る: 個人情報の流出、首脳会談、逮捕 など)
  "政権", "政府機関", "大統領選", "首相", "総理大臣", "官房長官", "国務長官", "外務大臣", "外務省", "政治資金",
  "支持", "批判", "発表", "表明", "首脳会談", "首脳会議", "方針", "見通", "懸念", "可能性", "問題", "対応",
  "関係", "判断", "要請", "検討", "決定", "開始", "発言", "主張", "指摘", "強調", "意向", "調査中", "影響", "拡大",
  "世界", "国際", "国内", "全国", "各地", "地域", "地方自治体", "住民", "速報", "動画", "解説", "ニュース", "最新",
  "外相", "大臣", "当局", "政策", "声明", "協議", "交渉", "合意", "中間選挙", "衆院選", "参院選", "投票", "議員",
  "国会", "内閣", "与党", "野党", "自民党", "経済", "市場", "企業", "成長", "物価", "株価", "金利", "円安", "日銀",
  "社会", "生活", "職場", "仕事", "女性", "男性", "若者", "高齢者", "世論調査", "事件", "交通事故", "逮捕",
  "容疑者", "警察官", "発生", "死亡", "被害", "火災", "死体遺棄", "特殊詐欺", "殺人", "強盗", "個人情報流出",
  "不正", "アクセス", "対策", "支援", "国家安全保障", "制度", "改革", "計画", "予定", "開催", "実施", "結果",
  "理由", "背景", "規制", "禁止", "導入", "発見", "開発", "研究", "記者会見", "上昇", "下落", "増加", "減少",
  "過去", "最大", "最高", "最多", "大雨", "警報", "注意報", "土砂災害", "台風", "地震", "AI", "SNS",
];
const WEAK_TERMS = new Set(WEAK_WORDS.flatMap((w) => [...terms(w).keys()]));

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
      // 他の記事に一度も出ない語は照合の役に立たず、共通語の比重を薄めるだけなので軽くする
      const w = tf * idf(k) * (df.get(k) > 1 ? 1 : 0.5) * (WEAK_TERMS.has(k) ? 0.25 : 1);
      vec.set(k, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [k, w] of vec) vec.set(k, w / norm);
    const keys = [...g.keys()].filter((k) => df.get(k) > 1 && df.get(k) <= tooCommon);
    // 話題を特定する手がかりになる語 (よく出る語でも1文字でもないもの)
    const strong = [...g.keys()].filter((k) => k.length > 1 && !WEAK_TERMS.has(k));
    return { vec, keys, strong };
  });
}

// 同じ話題とみなすのに必要な、共通する手がかり語の数。
// 実際の同じニュースは「子吉・吉川・氾濫」のように複数を共有し、別のニュースの誤一致は1語だけのことが多い
const MIN_SHARED_TERMS = 2;

function cosine(a, b) {
  let s = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, w] of small) {
    const v = large.get(k);
    if (v) s += w * v;
  }
  return s;
}

// items: [{title, ts, geo?, ...}] を話題ごとにまとめ、[[item, ...], ...] を返す。
// 話題の「中心」(所属記事の平均) と比べるので、A≒B, B≒C の数珠つなぎで無関係な記事が混ざらない。
// geo (見出しに出てくる地域の Set) が両方にあって重ならない記事同士は、別の国の話題としてまとめない
export function clusterItems(items) {
  const sorted = [...items].sort((a, b) => b.ts - a.ts);
  const vecs = vectorize(sorted);
  const clusters = []; // {members:[idx], newest, sum: Map, norm2, geo: Set}
  const index = new Map(); // 語 → その語を持つ話題の番号
  sorted.forEach((item, i) => {
    const { vec, keys, strong } = vecs[i];
    const geo = item.geo ?? new Set();
    const candidates = new Set();
    for (const k of keys) for (const c of index.get(k) ?? []) candidates.add(c);
    let best = -1;
    let bestSim = SIM_THRESHOLD;
    let bestDot = 0;
    for (const c of candidates) {
      const cl = clusters[c];
      if (cl.newest - item.ts > MAX_GAP_MS) continue;
      if (geo.size && cl.geo.size && ![...geo].some((r) => cl.geo.has(r))) continue;
      if (strong.filter((k) => cl.sum.has(k)).length < MIN_SHARED_TERMS) continue;
      const dot = cosine(vec, cl.sum);
      const sim = dot / Math.sqrt(cl.norm2);
      if (sim >= bestSim) {
        bestSim = sim;
        best = c;
        bestDot = dot;
      }
    }
    if (best < 0) {
      best = clusters.length;
      clusters.push({ members: [], newest: item.ts, sum: new Map(), norm2: 0, geo: new Set() });
    }
    const cl = clusters[best];
    cl.members.push(i);
    // 中心ベクトル (合計) と、その長さの2乗を足し込む: |s+v|² = |s|² + 2 s·v + |v|²
    cl.norm2 += 2 * bestDot + 1;
    for (const [k, w] of vec) cl.sum.set(k, (cl.sum.get(k) ?? 0) + w);
    for (const r of geo) cl.geo.add(r);
    for (const k of keys) {
      const list = index.get(k) ?? [];
      if (!list.includes(best)) list.push(best);
      index.set(k, list);
    }
  });
  return clusters.map((c) => c.members.map((i) => sorted[i]));
}

// 記事を選んで紹介するだけの「まとめ役」は、報じた媒体の数に入れない
const CURATORS = new Set(["Yahoo!トピックス", "Googleニュース"]);

// 話題度 = (報じた媒体の数 + 注目度の加点) × 新しさ
export function trendScore(members, now) {
  const outlets = new Set(members.map((m) => m.outlet).filter((o) => !CURATORS.has(o)));
  let boost = 0;
  if (members.some((m) => m.boost === "topic")) boost += 1.5; // Yahoo!トピックスに選ばれた
  if (members.some((m) => m.boost === "ranking")) boost += 1; // アクセスランキング入り
  // Googleニュースの並び順 (上位ほど主要ニュース)
  const google = members.filter((m) => m.boost === "google");
  if (google.length) boost += Math.max(0, 1.2 - Math.min(...google.map((m) => m.rank ?? 99)) * 0.02);
  const newest = Math.max(...members.map((m) => m.ts));
  const ageH = Math.max(0, (now - newest) / 3600_000);
  return { score: (outlets.size + boost) * 0.5 ** (ageH / HALF_LIFE_H), outlets: Math.max(1, outlets.size), newest };
}

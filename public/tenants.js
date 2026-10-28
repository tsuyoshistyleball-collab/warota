"use strict";

// 物件のタブ: 草加・獨協大学前・新田・蒲生・新越谷・南越谷の近くのテナント (貸店舗・貸事務所・貸倉庫) を、
// 不動産サイトの検索結果で開くボタンを並べる。物件の情報はアプリでは集めない
// (アットホームは利用規約でプログラムによる情報の取得を禁止していて、HOME'S はロボット確認があるため)
(() => {
  const body = document.getElementById("tn-body");
  // 東武スカイツリーラインの南から順に。homes は HOME'S の駅の一覧の URL に使う駅の名前と番号
  const STATIONS = [
    { name: "草加", line: "東武スカイツリーライン", city: "草加市", homes: "soka_04614" },
    { name: "獨協大学前", sub: "草加松原", line: "東武スカイツリーライン", city: "草加市", homes: "dokkyodaigakumae_04615" },
    { name: "新田", line: "東武スカイツリーライン", city: "草加市", homes: "shinden_04616" },
    { name: "蒲生", line: "東武スカイツリーライン", city: "越谷市", homes: "gamo_04617" },
    { name: "新越谷", line: "東武スカイツリーライン", city: "越谷市", homes: "shinkoshigaya_04618" },
    { name: "南越谷", line: "JR武蔵野線", city: "越谷市", homes: "minamikoshigaya_00699" },
  ];
  const ICON = {
    tempo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 10.5V20h15v-9.5"/><path d="M3 9.6 4.8 4.5h14.4L21 9.6a2.6 2.6 0 0 1-4.5 1.6 2.6 2.6 0 0 1-4.5 0 2.6 2.6 0 0 1-4.5 0A2.6 2.6 0 0 1 3 9.6z"/><path d="M10 20v-5h4v5"/></svg>',
    office: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M8.8 7.5h2M13.2 7.5h2M8.8 11h2M13.2 11h2M8.8 14.5h2M13.2 14.5h2M10.5 20.5v-3h3v3"/></svg>',
    soko: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20.5V9l9-5.5L21 9v11.5"/><path d="M7 20.5v-8h10v8M7 15.3h10M7 18h10"/></svg>',
  };
  // HOME'S: 駅の近くの一覧 (種類ごと)
  const HOMES_KINDS = [
    { key: "tempo", label: "店舗" },
    { key: "office", label: "事務所" },
    { key: "soko", label: "倉庫" },
  ];
  // アットホーム: 市全体の一覧 (駅ごとの一覧はなく、開いた先で駅を選べる)
  const ATHOME_CITIES = [
    { city: "草加市", roman: "soka-city", near: "草加・獨協大学前・新田" },
    { city: "越谷市", roman: "koshigaya-city", near: "蒲生・新越谷・南越谷" },
  ];
  const ATHOME_KINDS = [
    { key: "rent_store", label: "店舗・事務所", icon: "tempo" },
    { key: "rent_office", label: "事務所", icon: "office" },
    { key: "rent_souko", label: "倉庫・工場", icon: "soko" },
  ];
  // HOME'S の一覧の並び順 (開いた先の「並び替え」と同じもの)
  const SORTS = { area_house: "面積の広い順", newdate: "新着順" };

  let sort = "area_house";
  try {
    if (SORTS[localStorage.getItem("tenantSort")]) sort = localStorage.getItem("tenantSort");
  } catch {}

  const homesUrl = (kind, st) =>
    `https://www.homes.co.jp/chintai/${kind}/saitama/${st.homes}-st/list/?cond%5Bsortby%5D=${sort}`;
  const button = (href, icon, label, aria) =>
    `<a class="tn-btn" href="${href}" target="_blank" rel="noopener" aria-label="${aria}">${ICON[icon]}<span>${label}</span></a>`;

  function render() {
    body.innerHTML = `
      <section class="tn-card tn-intro">
        <p>ボタンを押すと、不動産サイトの検索結果が開きます。</p>
        <fieldset class="tn-sort">
          <legend>HOME'S の並び順</legend>
          <div class="seg">
            ${Object.entries(SORTS)
              .map(([k, v]) => `<label><input type="radio" name="tn-sort" value="${k}"${k === sort ? " checked" : ""}><span>${v}</span></label>`)
              .join("")}
          </div>
        </fieldset>
      </section>
      <h2 class="tn-h">HOME'S で駅の近くを探す</h2>
      <div class="tn-list">
        ${STATIONS.map((st) => `
          <section class="tn-card tn-st" aria-label="${st.name}駅">
            <div class="tn-st-name">
              <h3>${st.name}<small>駅${st.sub ? `〈${st.sub}〉` : ""}</small></h3>
              <p>${st.line} · ${st.city}</p>
            </div>
            <div class="tn-btns">
              ${HOMES_KINDS.map((k) => button(homesUrl(k.key, st), k.key, k.label, `${st.name}駅の近くの貸${k.label}を HOME'S で開く (${SORTS[sort]})`)).join("")}
            </div>
          </section>`).join("")}
      </div>
      <h2 class="tn-h">アットホームで市全体から探す <small>物件が多い</small></h2>
      <div class="tn-list">
        ${ATHOME_CITIES.map((c) => `
          <section class="tn-card tn-st" aria-label="${c.city}">
            <div class="tn-st-name">
              <h3>${c.city}</h3>
              <p>${c.near}駅のあたり</p>
            </div>
            <div class="tn-btns">
              ${ATHOME_KINDS.map((k) => button(`https://www.athome.co.jp/${k.key}/saitama/${c.roman}/list/`, k.icon, k.label, `${c.city}の貸${k.label}をアットホームで開く`)).join("")}
            </div>
          </section>`).join("")}
      </div>
      <section class="tn-card tn-tips" aria-label="使い方のヒント">
        <h2 class="tn-h">ヒント</h2>
        <ul>
          <li>HOME'S は上の「並び順」で開きます。並んでいないときは、開いた先の「並び替え」で「広い順」「新着順」を選べます。</li>
          <li>アットホームは、開いた先の「表示順」で「面積が広い順」「新着順」を、「駅」で駅を選べます。</li>
          <li>新しい物件を見逃さないには、開いた先の「この条件の新着物件を通知」(HOME'S) や「この条件で新着お知らせを受け取る」(アットホーム) を押して登録すると、新着が届きます。</li>
        </ul>
      </section>`;
  }

  body.addEventListener("change", (e) => {
    if (e.target.name !== "tn-sort") return;
    sort = e.target.value;
    try {
      localStorage.setItem("tenantSort", sort);
    } catch {}
    // 並び順だけを変える (選んだ印の場所を動かさないように、ボタンのリンクだけを書き換える)
    for (const a of body.querySelectorAll('a[href^="https://www.homes.co.jp/"]')) {
      a.href = a.href.replace(/sortby%5D=\w+/, `sortby%5D=${sort}`);
      a.setAttribute("aria-label", a.getAttribute("aria-label").replace(/\(.+\)$/, `(${SORTS[sort]})`));
    }
  });

  render();
})();

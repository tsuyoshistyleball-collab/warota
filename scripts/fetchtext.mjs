// 文字コードを自動判定してテキストを取得する共通ヘルパー。
// 古いまとめブログは EUC-JP や Shift_JIS のことがあるため、
// Content-Type ヘッダー → meta タグ/XML宣言 の順で charset を調べて復号する。

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ALIASES = {
  "shift-jis": "shift_jis",
  sjis: "shift_jis",
  "x-sjis": "shift_jis",
  "euc_jp": "euc-jp",
  utf8: "utf-8",
};

export async function fetchText(url, timeoutMs, accept = "*/*") {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept, "accept-language": "ja,en;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());

  let charset = (res.headers.get("content-type") ?? "").match(/charset=["']?([\w_-]+)/i)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.subarray(0, 4096));
    charset =
      head.match(/<meta[^>]+charset=["']?([\w_-]+)/i)?.[1] ??
      head.match(/<\?xml[^>]*encoding=["']([\w_-]+)/i)?.[1];
  }
  charset = (charset ?? "utf-8").toLowerCase();
  charset = ALIASES[charset] ?? charset;
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

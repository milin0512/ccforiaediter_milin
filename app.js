"use strict";

/* ============================================================
 * 定数
 * ========================================================== */

const SCHEMA_VERSION = 1;
const STATE_SCRIPT_ID = "ccfolia-editor-state";

// 汎用の話者カラープリセット（公式パレットではなく一般的な配色候補）
const COLOR_PRESETS = [
  "#f44336", "#e91e63", "#9c27b0", "#673ab7",
  "#3f51b5", "#03a9f4", "#009688", "#4caf50",
  "#8bc34a", "#ffc107", "#ff9800", "#795548",
  "#607d8b", "#888888", "#000000"
];

// ダイスロール本文の末尾（最後の＞の後）に現れる判定結果の分類
// ココフォリアのCoCダイスボット出力（クリティカル／イクストリーム成功／ハード成功／
// レギュラー成功／成功／失敗／ファンブル）に基づく。他のシステムの判定語は「other」として
// 「ダイスロールのみ」には表示されるが、成功系・失敗系の絞り込みには含まれない。
const DICE_OUTCOME_CATEGORIES = [
  { key: "critical", label: "クリティカル", group: "success" },
  { key: "extreme", label: "イクストリーム成功", group: "success" },
  { key: "hard", label: "ハード成功", group: "success" },
  { key: "regular", label: "レギュラー成功", group: "success" },
  { key: "success", label: "成功", group: "success" },
  { key: "failure", label: "失敗", group: "failure" },
  { key: "fumble", label: "ファンブル", group: "failure" },
];

function classifyDiceOutcome(text) {
  const parts = text.split("＞");
  if (parts.length < 2) return "other";
  const last = parts[parts.length - 1].trim();
  const known = DICE_OUTCOME_CATEGORIES.find((c) => c.label === last);
  if (known) return known.key;
  if (/^-?\d+(\[[^\]]*\])?$/.test(last)) return "number";
  return "other";
}

function diceOutcomeGroup(key) {
  const found = DICE_OUTCOME_CATEGORIES.find((c) => c.key === key);
  return found ? found.group : null;
}

/* ============================================================
 * アプリ状態
 * ========================================================== */

const state = {
  messages: [],   // { id, tab, channel, isSystem, speaker, color, text, isDiceRoll, diceOutcome, iconId }
  images: [],     // 表情差分画像のプール { id, dataUrl }
  speakerSettings: {}, // 発言者名 -> { displayType: "character" | "narration" }
  meta: {
    schemaVersion: SCHEMA_VERSION,
    savedAt: null,
    sourceFileName: null,
  },
  loadedFileName: null,
  // プレビュー用HTMLでKP・PLとして表示する発言者名（本文の書き出し中は保持し、ファイルの読み込み直しでは変わらない）
  previewRoles: { kp: ["KP"], pl: ["PL"] },
};

/* ============================================================
 * ユーティリティ
 * ========================================================== */

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DEFAULT_COLOR = "#888888";

// 外部から読み込んだ色は必ずここを通す。
// #rrggbb 以外は既定色に落とし、style属性やdata属性への文字列注入を防ぐ。
function normalizeColor(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : DEFAULT_COLOR;
}

// 外部から読み込んだ値を必ず文字列にする。
// 壊れたファイルで数値やオブジェクトが入っていても、後段が例外で止まらないようにする。
function toText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatTimestampForFilename(date) {
  return (
    date.getFullYear() +
    pad2(date.getMonth() + 1) +
    pad2(date.getDate()) +
    "_" +
    pad2(date.getHours()) +
    pad2(date.getMinutes())
  );
}

function stripExtension(fileName) {
  const idx = fileName.lastIndexOf(".");
  return idx === -1 ? fileName : fileName.slice(0, idx);
}

/* ============================================================
 * 表情差分画像のプール・発言者ごとの表示方法
 * ========================================================== */

function getImageById(id) {
  return state.images.find((img) => img.id === id) || null;
}

function getImageDataUrl(id) {
  const img = getImageById(id);
  return img ? img.dataUrl : null;
}

// 画像は発言者ごとの「持ち物」として管理する（表情に名前を付けて管理できるように）。
// その発言者が今まで持っている表情の数から、次の既定名（表情1、表情2…）を決める。
function nextDefaultImageName(speaker) {
  return `表情${getSpeakerImageIds(speaker).length + 1}`;
}

// 発言者に新しい表情差分画像を1件追加する（既存の発言への割り当ては行わない）
function addSpeakerImage(speaker, dataUrl, name) {
  const id = uid();
  state.images.push({ id, dataUrl, name: name || nextDefaultImageName(speaker), speaker });
  scheduleAutoSave();
  return id;
}

// 発言編集フォームからの新規アップロード用。同じ発言者・同じ画像が既にあれば使い回す。
function addImageToPool(dataUrl, speaker) {
  const existing = state.images.find((img) => img.speaker === speaker && img.dataUrl === dataUrl);
  if (existing) return existing.id;
  return addSpeakerImage(speaker, dataUrl);
}

function renameImage(imageId, name) {
  const img = getImageById(imageId);
  if (!img) return;
  img.name = name.trim();
  scheduleAutoSave();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function getSpeakerDisplayType(speaker) {
  const s = state.speakerSettings[speaker];
  return s && s.displayType === "character" ? "character" : "narration";
}

function setSpeakerDisplayType(speaker, type) {
  state.speakerSettings[speaker] = { displayType: type === "character" ? "character" : "narration" };
  renderAll();
}

// その発言者が持っている画像を、追加した順に返す（現在どの発言にも使われていない
// 画像も、管理対象として持ち主基準でここに含める）
function getSpeakerImageIds(speaker) {
  return state.images.filter((img) => img.speaker === speaker).map((img) => img.id);
}

// 元データに画像を持たなかった発言者（地の文扱い）に、初めて画像を追加したときの処理。
// その発言者の発言すべてに同じ画像を割り当て、キャラクター発言に切り替える。
function insertFirstImageForSpeaker(speaker, dataUrl) {
  const id = addSpeakerImage(speaker, dataUrl);
  state.messages.forEach((m) => {
    if (m.speaker === speaker) m.iconId = id;
  });
  setSpeakerDisplayType(speaker, "character");
}

/* ============================================================
 * ダイスロール自動判定（6章）
 * 「数字+D+数字」（大小文字区別なし）と「＞」を含むかどうかで判定
 * ========================================================== */

function detectDiceRoll(text) {
  return /\d+d\d+/i.test(text) && text.includes("＞");
}

/* ============================================================
 * ココフォリア書き出しHTMLの解析（4章）
 * ========================================================== */

function extractSpanText(spanEl) {
  const clone = spanEl.cloneNode(true);
  clone.querySelectorAll("br").forEach((br) => {
    br.replaceWith(document.createTextNode("\n"));
  });
  const raw = clone.textContent || "";
  return raw
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

// ダイスロール本文の末尾（最後の＞の後）から成否を推測する現行ロジック。
// 新形式では .roll-result のclass修飾から直接判定できるが、それが取れない場合
// （旧形式・class修飾なしの単純ロール等）のフォールバックとして使う。
function classifyDiceOutcomeFromText(text) {
  return classifyDiceOutcome(text);
}

// ココフォリアの書き出しHTMLは新形式（article.message ベース）と、
// 過去の旧形式（p[style*="color:"] ベース）のどちらもありうるため、
// 新形式のセレクタで1件もマッチしなければ旧形式として解析する。
function parseCcfoliaHtml(htmlString) {
  const doc = new DOMParser().parseFromString(htmlString, "text/html");
  const articles = doc.querySelectorAll("article.message");
  return articles.length > 0 ? parseCcfoliaHtmlNew(doc, articles) : parseCcfoliaHtmlLegacy(doc);
}

// <style>内の .avatar-image-N { background-image: url("data:...") } から
// 表情差分画像のdata URIを取り出し、インデックス文字列(N) -> data URI の対応表を作る
function parseAvatarImageMap(doc) {
  const map = new Map();
  const re = /\.avatar-image-(\d+)\s*\{[^}]*background-image:\s*url\((["']?)(data:[^"')]+)\2\)/g;
  doc.querySelectorAll("style").forEach((styleEl) => {
    const css = styleEl.textContent || "";
    let m;
    while ((m = re.exec(css))) {
      map.set(m[1], m[3]);
    }
  });
  return map;
}

function parseCcfoliaHtmlNew(doc, articles) {
  const avatarMap = parseAvatarImageMap(doc);
  const images = [];
  const imageIdByKey = new Map(); // speaker -> (dataUrl -> id)（画像は発言者ごとの持ち物として管理する）
  const speakerImageCounters = new Map();
  const speakerHasImage = new Set();

  function registerImage(dataUrl, speaker) {
    let bucket = imageIdByKey.get(speaker);
    if (!bucket) {
      bucket = new Map();
      imageIdByKey.set(speaker, bucket);
    }
    if (bucket.has(dataUrl)) return bucket.get(dataUrl);
    const count = (speakerImageCounters.get(speaker) || 0) + 1;
    speakerImageCounters.set(speaker, count);
    const id = uid();
    images.push({ id, dataUrl, name: `表情${count}`, speaker });
    bucket.set(dataUrl, id);
    return id;
  }

  const messages = [];

  articles.forEach((article) => {
    const channel = article.getAttribute("data-channel") || "main";
    const channelNameEl = article.querySelector(".channel-name");
    const tab = (channelNameEl ? extractSpanText(channelNameEl) : "") || "[メイン]";

    if (article.classList.contains("system")) {
      const textEl = article.querySelector(".message-text");
      messages.push({
        id: uid(),
        tab,
        channel,
        isSystem: true,
        speaker: "",
        color: DEFAULT_COLOR,
        text: textEl ? extractSpanText(textEl) : "",
        isDiceRoll: false,
        diceOutcome: null,
        iconId: null,
      });
      return;
    }

    const speakerEl = article.querySelector(".speaker");
    const speaker = speakerEl ? extractSpanText(speakerEl) : "";
    const speakerStyle = speakerEl ? speakerEl.getAttribute("style") || "" : "";
    const colorMatch = speakerStyle.match(/--speaker-color:\s*(#[0-9a-fA-F]{6})/);
    const color = normalizeColor(colorMatch ? colorMatch[1] : DEFAULT_COLOR);

    const textEl = article.querySelector(".message-text");
    const text = textEl ? extractSpanText(textEl) : "";

    const rollEl = article.querySelector(".roll-result");
    const isDiceRoll = !!rollEl;
    let diceOutcome = null;
    if (rollEl) {
      const outcomeClass = Array.from(rollEl.classList).find((c) => c !== "roll-result");
      diceOutcome = outcomeClass || classifyDiceOutcomeFromText(extractSpanText(rollEl));
    }

    let iconId = null;
    const avatarEl = article.querySelector(".avatar");
    if (avatarEl && !avatarEl.classList.contains("avatar-spacer")) {
      const imgClass = Array.from(avatarEl.classList).find((c) => /^avatar-image-\d+$/.test(c));
      const idx = imgClass ? imgClass.replace("avatar-image-", "") : null;
      const dataUrl = idx !== null ? avatarMap.get(idx) : null;
      if (dataUrl) {
        iconId = registerImage(dataUrl, speaker);
        if (speaker) speakerHasImage.add(speaker);
      }
    }

    messages.push({
      id: uid(),
      tab,
      channel,
      isSystem: false,
      speaker,
      color,
      text,
      isDiceRoll,
      diceOutcome,
      iconId,
    });
  });

  // 画像を1件でも使っていた発言者は「キャラクター発言」、一度も使っていない発言者
  // （KP等）は「地の文」として初期分類する
  const speakerSettings = {};
  new Set(messages.map((m) => m.speaker).filter(Boolean)).forEach((speaker) => {
    speakerSettings[speaker] = { displayType: speakerHasImage.has(speaker) ? "character" : "narration" };
  });

  return {
    messages,
    images,
    speakerSettings,
    meta: {
      schemaVersion: SCHEMA_VERSION,
      savedAt: null,
      sourceFileName: null,
    },
  };
}

// 過去のココフォリア書き出し形式（<p style="color:..."><span>×3</span></p>）。
// 画像・チャンネルIDなどの情報は元々存在しないため、既定値で埋める。
function parseCcfoliaHtmlLegacy(doc) {
  const paragraphs = doc.querySelectorAll('p[style*="color:"]');
  const messages = [];

  paragraphs.forEach((p) => {
    const spans = p.querySelectorAll(":scope > span");
    if (spans.length < 3) return;

    const styleAttr = p.getAttribute("style") || "";
    const colorMatch = styleAttr.match(/color:\s*(#[0-9a-fA-F]{6})/);
    const color = normalizeColor(colorMatch ? colorMatch[1] : DEFAULT_COLOR);

    const tab = extractSpanText(spans[0]);
    const speaker = extractSpanText(spans[1]);
    const text = extractSpanText(spans[2]);

    messages.push({
      id: uid(),
      tab: tab || "[main]",
      channel: null,
      isSystem: false,
      speaker,
      color,
      text,
      isDiceRoll: detectDiceRoll(text),
      diceOutcome: null,
      iconId: null,
    });
  });

  return {
    messages,
    images: [],
    speakerSettings: {},
    meta: {
      schemaVersion: SCHEMA_VERSION,
      savedAt: null,
      sourceFileName: null,
    },
  };
}

/* ============================================================
 * 一時保存ファイル（隠しJSON付きHTML）の解析（5.4章）
 * ========================================================== */

function findStateScript(doc) {
  return doc.getElementById(STATE_SCRIPT_ID);
}

// 外部（保存HTML・ブラウザ内の自動保存）から読み込んだ画像プールを、
// アプリ内で扱える形に揃える。壊れたエントリは無視する。
function normalizeImages(list) {
  if (!Array.isArray(list)) return [];
  const seenIds = new Set();
  const result = [];
  list.forEach((img) => {
    if (!img || typeof img !== "object") return;
    const dataUrl = typeof img.dataUrl === "string" ? img.dataUrl : "";
    if (!dataUrl.startsWith("data:image/")) return;
    let id = typeof img.id === "string" && img.id ? img.id : uid();
    if (seenIds.has(id)) id = uid();
    seenIds.add(id);
    result.push({ id, dataUrl, name: toText(img.name), speaker: toText(img.speaker) });
  });
  return result;
}

// 本機能追加より前に保存されたデータには画像の持ち主（speaker）・名前が無いため、
// その画像を実際に使っている発言から持ち主を補い、名前が無ければ既定名を振る。
// どの発言からも使われていない画像は持ち主なし（""）として扱う。
function backfillImageOwnership(images, messages) {
  const counters = new Map();
  images.forEach((img) => {
    if (!img.speaker) {
      const owner = messages.find((m) => m.iconId === img.id);
      img.speaker = owner ? owner.speaker : "";
    }
    if (!img.name) {
      const count = (counters.get(img.speaker) || 0) + 1;
      counters.set(img.speaker, count);
      img.name = `表情${count}`;
    }
  });
  return images;
}

// 外部（保存HTML・ブラウザ内の自動保存）から読み込んだ発言の配列を、
// アプリ内で扱える形に揃える。値の正規化とID重複の解消をここに集約する。
function normalizeLoadedMessages(list, validImageIds) {
  const imageIdSet = validImageIds instanceof Set ? validImageIds : new Set(validImageIds || []);
  // IDが重複していると、選択・編集が別の発言を巻き込むので振り直す
  const seenIds = new Set();
  return list
    .filter((m) => m && typeof m === "object")
    .map((m) => {
      let id = typeof m.id === "string" && m.id ? m.id : uid();
      if (seenIds.has(id)) id = uid();
      seenIds.add(id);
      const iconId = typeof m.iconId === "string" && imageIdSet.has(m.iconId) ? m.iconId : null;
      return {
        id,
        tab: toText(m.tab) || "[main]",
        channel: typeof m.channel === "string" && m.channel ? m.channel : null,
        isSystem: !!m.isSystem,
        speaker: toText(m.speaker),
        color: normalizeColor(m.color),
        text: toText(m.text),
        isDiceRoll: !!m.isDiceRoll,
        diceOutcome: typeof m.diceOutcome === "string" ? m.diceOutcome : null,
        iconId,
      };
    });
}

// 発言者ごとの表示方法（キャラクター発言／地の文）。保存データに残っていればそれを使い、
// 無い発言者は「画像付きの発言を1件でも持っていればキャラクター発言」という既定ルールで補う。
function normalizeSpeakerSettings(obj, messages) {
  const knownSpeakers = new Set(messages.map((m) => m.speaker).filter(Boolean));
  const settings = {};
  if (obj && typeof obj === "object") {
    Object.keys(obj).forEach((speaker) => {
      if (!knownSpeakers.has(speaker)) return;
      const entry = obj[speaker];
      settings[speaker] = { displayType: entry && entry.displayType === "character" ? "character" : "narration" };
    });
  }
  knownSpeakers.forEach((speaker) => {
    if (settings[speaker]) return;
    const hasIcon = messages.some((m) => m.speaker === speaker && m.iconId);
    settings[speaker] = { displayType: hasIcon ? "character" : "narration" };
  });
  return settings;
}

function parseSavedHtml(htmlString) {
  const doc = new DOMParser().parseFromString(htmlString, "text/html");
  const scriptEl = findStateScript(doc);
  if (!scriptEl) return null;

  let data;
  try {
    data = JSON.parse(scriptEl.textContent);
  } catch (e) {
    return null;
  }

  // 想定の形をしていない場合は「保存ファイルではない」とみなし、
  // 呼び出し元で通常のココフォリアHTMLとして解析させる
  if (!data || typeof data !== "object" || !Array.isArray(data.messages)) return null;

  const images = normalizeImages(data.images);
  const imageIdSet = new Set(images.map((img) => img.id));
  const messages = normalizeLoadedMessages(data.messages, imageIdSet);
  backfillImageOwnership(images, messages);

  return {
    messages,
    images,
    speakerSettings: normalizeSpeakerSettings(data.speakerSettings, messages),
    meta: {
      schemaVersion: data.schemaVersion || SCHEMA_VERSION,
      savedAt: typeof data.savedAt === "string" ? data.savedAt : null,
      sourceFileName: typeof data.sourceFileName === "string" ? data.sourceFileName : null,
    },
  };
}

/* ============================================================
 * 読み込み時の自動判定（5.1・5.4章）
 * ========================================================== */

function loadFromHtmlString(htmlString, fileName) {
  const saved = parseSavedHtml(htmlString);
  let result;

  if (saved) {
    result = saved;
    if (!result.meta.sourceFileName) {
      result.meta.sourceFileName = fileName;
    }
  } else {
    result = parseCcfoliaHtml(htmlString);
    result.meta.sourceFileName = fileName;
  }

  state.messages = result.messages;
  state.images = result.images || [];
  state.speakerSettings = result.speakerSettings || {};
  state.meta = result.meta;
  state.loadedFileName = fileName;

  selectedMessageId = null;
  bottomBarMinimized = false;
  loadSectionExpanded = false;
  loadYieldedNoMessages = state.messages.length === 0;
  // 別のログを読み込んだら、前のファイルを上書きしないよう保存先を忘れる
  saveFileHandle = null;

  renderAll();
}

/* ============================================================
 * 編集内容の自動保存（ブラウザ内・端末外には出ない）
 * 次に開いたときに「前回の続き」から再開できるようにする。
 * ========================================================== */

// 一覧用の見出し情報（軽い）と、発言本体（重い）を別のキーに分けて持つ。
// こうすると一覧表示のたびに全ログを読み込まずに済み、保存時も編集中の1件だけを書けばよい。
const AUTOSAVE_INDEX_KEY = "ccfolia-log-editor:autosave-index";
const AUTOSAVE_DATA_PREFIX = "ccfolia-log-editor:autosave:";
const AUTOSAVE_MAX_ENTRIES = 5;
const AUTOSAVE_DEBOUNCE_MS = 800;

let autoSaveTimer = null;
let autoSaveDisabled = false;

// 同じシナリオのログは同じ枠に上書きしたいので、一時保存HTMLを読み直しても
// 変わらない「元のココフォリアのファイル名」を枠の見分けに使う。
function currentAutoSaveKey() {
  return state.meta.sourceFileName || state.loadedFileName || "ccfolia-log";
}

function readAutoSaveIndex() {
  let raw;
  try {
    raw = localStorage.getItem(AUTOSAVE_INDEX_KEY);
  } catch (e) {
    return [];
  }
  if (!raw) return [];

  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && typeof e === "object" && typeof e.id === "string");
}

function removeAutoSaveData(id) {
  try {
    localStorage.removeItem(AUTOSAVE_DATA_PREFIX + id);
  } catch (e) {
    // 消せなくても実害はないので握りつぶす
  }
}

function scheduleAutoSave() {
  if (autoSaveDisabled) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(writeAutoSave, AUTOSAVE_DEBOUNCE_MS);
}

function writeAutoSave() {
  autoSaveTimer = null;
  if (autoSaveDisabled) return;
  // 発言が0件のときは書き込まない。ここで消してしまうと、
  // ログ以外のHTMLを誤って選んだだけで前回の編集内容が失われてしまう。
  // 自動保存を消すのは「破棄」を押したときだけにする。
  if (state.messages.length === 0) return;

  const key = currentAutoSaveKey();
  const stored = readAutoSaveIndex();
  const existing = stored.find((e) => e.key === key);

  const entry = {
    id: existing ? existing.id : uid(),
    key,
    sourceFileName: state.meta.sourceFileName || null,
    loadedFileName: state.loadedFileName || null,
    savedAt: new Date().toISOString(),
    count: state.messages.length,
  };

  // 編集中のものを先頭に置き、古いものから上限を超えた分を捨てる
  const list = [entry, ...stored.filter((e) => e.key !== key)];
  while (list.length > AUTOSAVE_MAX_ENTRIES) {
    removeAutoSaveData(list.pop().id);
  }

  const payload = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    messages: state.messages,
    images: state.images,
    speakerSettings: state.speakerSettings,
  });

  for (;;) {
    try {
      localStorage.setItem(AUTOSAVE_DATA_PREFIX + entry.id, payload);
      localStorage.setItem(AUTOSAVE_INDEX_KEY, JSON.stringify(list));
      return;
    } catch (e) {
      // 容量が足りないときは、古い記録から順に手放して入るところまで試す。
      // 編集中のもの（先頭）だけは最後まで残す。
      if (list.length > 1) {
        removeAutoSaveData(list.pop().id);
        continue;
      }
      autoSaveDisabled = true;
      console.warn("自動保存できませんでした:", e);
      return;
    }
  }
}

function readAutoSaveData(id) {
  let raw;
  try {
    raw = localStorage.getItem(AUTOSAVE_DATA_PREFIX + id);
  } catch (e) {
    return null;
  }
  if (!raw) return null;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.messages) || data.messages.length === 0) {
    return null;
  }
  return data;
}

function discardAutoSave(id) {
  removeAutoSaveData(id);
  const list = readAutoSaveIndex().filter((e) => e.id !== id);
  try {
    localStorage.setItem(AUTOSAVE_INDEX_KEY, JSON.stringify(list));
  } catch (e) {
    // 一覧を書き戻せなくても、本体は消えているので実害はない
  }
  renderRestoreList();
}

function restoreFromAutoSave(id) {
  const entry = readAutoSaveIndex().find((e) => e.id === id);
  const data = entry ? readAutoSaveData(id) : null;
  if (!entry || !data) {
    // 記録が壊れている・本体だけ消えている場合は一覧からも取り除く
    discardAutoSave(id);
    window.alert("この自動保存は読み込めませんでした。一覧から取り除きます。");
    return;
  }

  const images = normalizeImages(data.images);
  const imageIdSet = new Set(images.map((img) => img.id));
  const messages = normalizeLoadedMessages(data.messages, imageIdSet);
  backfillImageOwnership(images, messages);

  state.messages = messages;
  state.images = images;
  state.speakerSettings = normalizeSpeakerSettings(data.speakerSettings, messages);
  state.meta = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: typeof entry.savedAt === "string" ? entry.savedAt : null,
    sourceFileName: typeof entry.sourceFileName === "string" ? entry.sourceFileName : null,
  };
  state.loadedFileName =
    typeof entry.loadedFileName === "string" && entry.loadedFileName ? entry.loadedFileName : entry.key;

  selectedMessageId = null;
  bottomBarMinimized = false;
  loadSectionExpanded = false;
  loadYieldedNoMessages = state.messages.length === 0;
  saveFileHandle = null;

  renderAll();
}

/* ============================================================
 * DOM要素の取得
 * ========================================================== */

const el = {
  fileInput: document.getElementById("file-input"),
  loadStatus: document.getElementById("load-status"),
  loadFull: document.getElementById("load-full"),
  loadCollapsed: document.getElementById("load-collapsed"),
  loadCollapsedText: document.getElementById("load-collapsed-text"),
  btnLoadExpand: document.getElementById("btn-load-expand"),
  sectionEditor: document.getElementById("section-editor"),
  msgCount: document.getElementById("msg-count"),
  messageList: document.getElementById("message-list"),
  btnSaveTemp: document.getElementById("btn-save-temp"),
  btnShareTemp: document.getElementById("btn-share-temp"),
  saveTempStatus: document.getElementById("save-temp-status"),
  restoreNotice: document.getElementById("restore-notice"),
  restoreList: document.getElementById("restore-list"),
  exportFormatSelect: document.getElementById("export-format-select"),
  exportFormatNote: document.getElementById("export-format-note"),
  btnManagePreviewRoles: document.getElementById("btn-manage-preview-roles"),
  previewRoleOverlay: document.getElementById("preview-role-overlay"),
  previewRoleOverlayBackdrop: document.getElementById("preview-role-overlay-backdrop"),
  previewRoleList: document.getElementById("preview-role-list"),
  btnClosePreviewRoles: document.getElementById("btn-close-preview-roles"),
  btnCopyExport: document.getElementById("btn-copy-export"),
  btnDownloadExport: document.getElementById("btn-download-export"),
  exportStatus: document.getElementById("export-status"),

  overlay: document.getElementById("msg-overlay"),
  overlayBackdrop: document.getElementById("msg-overlay-backdrop"),
  msgForm: document.getElementById("msg-form"),
  msgFormTitle: document.getElementById("msg-form-title"),
  fieldTabSelect: document.getElementById("field-tab-select"),
  newTabBlock: document.getElementById("new-tab-block"),
  fieldTabName: document.getElementById("field-tab-name"),
  fieldSpeakerSelect: document.getElementById("field-speaker-select"),
  newSpeakerBlock: document.getElementById("new-speaker-block"),
  fieldSpeakerName: document.getElementById("field-speaker-name"),
  fieldSpeakerColor: document.getElementById("field-speaker-color"),
  colorSwatches: document.getElementById("color-swatches"),
  iconFieldBlock: document.getElementById("icon-field-block"),
  iconPickerList: document.getElementById("icon-picker-list"),
  fieldIconUpload: document.getElementById("field-icon-upload"),
  fieldText: document.getElementById("field-text"),
  fieldDice: document.getElementById("field-dice"),
  btnCancelMsg: document.getElementById("btn-cancel-msg"),

  filterSelect: document.getElementById("filter-select"),
  filterNote: document.getElementById("filter-note"),
  filterSummary: document.getElementById("filter-summary"),
  speakerFilterSelect: document.getElementById("speaker-filter-select"),

  sidebar: document.getElementById("sidebar"),
  sidebarBackdrop: document.getElementById("sidebar-backdrop"),
  btnSidebarOpen: document.getElementById("btn-sidebar-open"),
  btnSidebarClose: document.getElementById("btn-sidebar-close"),
  sidebarFilterDot: document.getElementById("sidebar-filter-dot"),

  btnManageSpeakerColors: document.getElementById("btn-manage-speaker-colors"),
  speakerColorOverlay: document.getElementById("speaker-color-overlay"),
  speakerColorOverlayBackdrop: document.getElementById("speaker-color-overlay-backdrop"),
  speakerColorList: document.getElementById("speaker-color-list"),
  btnCloseSpeakerColors: document.getElementById("btn-close-speaker-colors"),

  imagePreviewOverlay: document.getElementById("image-preview-overlay"),
  imagePreviewOverlayBackdrop: document.getElementById("image-preview-overlay-backdrop"),
  imagePreviewImg: document.getElementById("image-preview-img"),
  btnCloseImagePreview: document.getElementById("btn-close-image-preview"),

  btnDeleteEmpty: document.getElementById("btn-delete-empty"),

  bottomBar: document.getElementById("bottom-bar"),
  bottomBarLabel: document.getElementById("bottom-bar-label"),
  bottomBarActions: document.getElementById("bottom-bar-actions"),
  btnBottomBarToggle: document.getElementById("btn-bottom-bar-toggle"),
  btnBottomBarClose: document.getElementById("btn-bottom-bar-close"),
  barActionUp: document.getElementById("bar-action-up"),
  barActionDown: document.getElementById("bar-action-down"),
  barActionEdit: document.getElementById("bar-action-edit"),
  barActionDelete: document.getElementById("bar-action-delete"),
  barActionInsertBelow: document.getElementById("bar-action-insert-below"),
};

/* ============================================================
 * 絞り込み表示（ダイスロールの成功／失敗抽出）
 * ========================================================== */

let currentFilter = "all";
let currentSpeakerFilter = "all";
let loadSectionExpanded = true;
let sidebarOpen = false;
let selectedMessageId = null;
let bottomBarMinimized = false;
// 「発言0件」が読み込み失敗によるものか、すべて削除した結果かを区別するための記録
let loadYieldedNoMessages = false;
// PC(Chrome/Edge)など、ブラウザからファイルへ直接書き込める環境での保存先。
// 一度決めたら以降は同じファイルを黙って上書きする（新しいファイルを増やさない）。
// 別のログを読み込んだときは、前のファイルを壊さないよう必ずnullに戻すこと。
let saveFileHandle = null;

// 新形式は .roll-result のclass修飾（diceOutcome）から直接判定できる。
// それが無い（旧形式・単純ロール等）場合のみ、本文末尾からの推測にフォールバックする。
function getDiceOutcomeKey(msg) {
  return msg.diceOutcome || classifyDiceOutcome(msg.text);
}

function messagePassesFilter(msg) {
  if (currentSpeakerFilter !== "all" && msg.speaker !== currentSpeakerFilter) return false;

  switch (currentFilter) {
    case "dice":
      return msg.isDiceRoll;
    case "dice-success":
      return msg.isDiceRoll && diceOutcomeGroup(getDiceOutcomeKey(msg)) === "success";
    case "dice-failure":
      return msg.isDiceRoll && diceOutcomeGroup(getDiceOutcomeKey(msg)) === "failure";
    case "talk":
      return !msg.isDiceRoll;
    default:
      return true;
  }
}

function isFilterActive() {
  return currentFilter !== "all" || currentSpeakerFilter !== "all";
}

function updateSpeakerFilterOptions() {
  const speakers = getKnownSpeakers().map((s) => s.speaker);
  const previous = currentSpeakerFilter;

  el.speakerFilterSelect.innerHTML =
    `<option value="all">すべての発言者</option>` +
    speakers.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");

  currentSpeakerFilter = speakers.includes(previous) ? previous : "all";
  el.speakerFilterSelect.value = currentSpeakerFilter;
}

el.filterSelect.addEventListener("change", () => {
  currentFilter = el.filterSelect.value;
  deselectMessage();
  renderList();
});

el.speakerFilterSelect.addEventListener("change", () => {
  currentSpeakerFilter = el.speakerFilterSelect.value;
  deselectMessage();
  renderList();
});

/* ============================================================
 * サイドバー（ツール・絞り込み）
 * PC・iPad横向き（900px以上）は常時表示、それ以外はスライドイン
 * ========================================================== */

function openSidebar() {
  sidebarOpen = true;
  el.sidebar.classList.add("is-open");
  el.sidebarBackdrop.hidden = false;
}

function closeSidebar() {
  sidebarOpen = false;
  el.sidebar.classList.remove("is-open");
  el.sidebarBackdrop.hidden = true;
}

el.btnSidebarOpen.addEventListener("click", openSidebar);
el.btnSidebarClose.addEventListener("click", closeSidebar);
el.sidebarBackdrop.addEventListener("click", closeSidebar);

/* ============================================================
 * ①読み込みエリアの折りたたみ（読み込み後は自動で畳む）
 * ========================================================== */

function renderLoadSection() {
  const hasFile = !!state.loadedFileName;
  // 発言が0件のときは畳まない。畳むと「ファイルを選ぶ」が隠れて、
  // 別のファイルを選び直す手段が分かりにくくなるため。
  const hasMessages = state.messages.length > 0;
  const showFull = !hasFile || !hasMessages || loadSectionExpanded;
  el.loadFull.hidden = !showFull;
  el.loadCollapsed.hidden = showFull;
  if (hasFile) {
    el.loadCollapsedText.textContent = `${state.loadedFileName}（${state.messages.length} 件）読み込み中`;
  }
}

el.btnLoadExpand.addEventListener("click", () => {
  loadSectionExpanded = true;
  renderLoadSection();
  // パネルを開いたときにも、他のログの自動保存を選べるように一覧を作り直す
  renderRestoreList();
});

/* ============================================================
 * 一覧の描画（5.2章）
 * ========================================================== */

function renderAll() {
  const hasMessages = state.messages.length > 0;
  el.sectionEditor.hidden = !hasMessages;
  el.sidebar.hidden = !hasMessages;
  el.btnSidebarOpen.hidden = !hasMessages;
  if (!hasMessages) closeSidebar();

  if (!state.loadedFileName) {
    el.loadStatus.textContent = "まだファイルが読み込まれていません。";
  } else if (hasMessages) {
    el.loadStatus.textContent =
      `読み込み中のファイル：${state.loadedFileName}（発言 ${state.messages.length} 件）` +
      (state.meta.savedAt ? ` / 保存日時：${formatDisplayDate(state.meta.savedAt)}` : "");
  } else if (loadYieldedNoMessages) {
    // 読み込んだ時点で0件＝ログ以外のHTMLを選んだ可能性が高いので、その旨を伝える
    el.loadStatus.textContent =
      `${state.loadedFileName} から発言を読み取れませんでした。ココフォリアの書き出しHTML、または本ツールで一時保存したHTMLを選んでください。`;
  } else {
    // 読み込みは成功していて、編集の結果0件になった場合
    el.loadStatus.textContent = `${state.loadedFileName}：発言がすべて削除されました。`;
  }

  renderLoadSection();
  renderRestoreList();
  updateSpeakerFilterOptions();
  renderList();
  renderBottomBar();

  // 発言を変更する操作はいずれも最終的にここを通るので、自動保存はここで一括して予約する
  // （並べ替えだけは一覧を作り直さないため、moveMessage側でも呼んでいる）
  scheduleAutoSave();
}

function renderRestoreList() {
  // 読み込みパネルが出ているときだけ案内する（読み込み直後の畳まれた状態では出さない）。
  // 編集中のログ自身は、いま画面に出ているものなので一覧から除く。
  const showPanel = !el.loadFull.hidden;
  const currentKey = state.messages.length > 0 ? currentAutoSaveKey() : null;
  const entries = showPanel ? readAutoSaveIndex().filter((e) => e.key !== currentKey) : [];

  el.restoreList.innerHTML = "";
  if (entries.length === 0) {
    el.restoreNotice.hidden = true;
    return;
  }

  entries.forEach((entry) => el.restoreList.appendChild(buildRestoreItem(entry)));
  el.restoreNotice.hidden = false;
}

function buildRestoreItem(entry) {
  const name = entry.loadedFileName || entry.key || "読み込んだログ";

  const li = document.createElement("li");
  li.className = "restore-item";

  const info = document.createElement("div");
  info.className = "restore-item__info";

  const nameEl = document.createElement("span");
  nameEl.className = "restore-item__name";
  nameEl.textContent = name;
  info.appendChild(nameEl);

  const metaEl = document.createElement("span");
  metaEl.className = "restore-item__meta";
  metaEl.textContent =
    `${entry.count || 0} 件 / ` + (entry.savedAt ? formatCompactDate(entry.savedAt) : "日時不明");
  info.appendChild(metaEl);

  li.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "restore-item__actions";

  const restoreBtn = document.createElement("button");
  restoreBtn.type = "button";
  restoreBtn.className = "btn btn--primary btn--small";
  restoreBtn.textContent = "再開";
  restoreBtn.addEventListener("click", () => restoreFromAutoSave(entry.id));
  actions.appendChild(restoreBtn);

  const discardBtn = document.createElement("button");
  discardBtn.type = "button";
  discardBtn.className = "btn btn--secondary btn--small";
  discardBtn.textContent = "破棄";
  discardBtn.addEventListener("click", () => {
    if (!window.confirm(`「${name}」の自動保存を破棄します。よろしいですか？`)) return;
    discardAutoSave(entry.id);
  });
  actions.appendChild(discardBtn);

  li.appendChild(actions);
  return li;
}

// 自動保存の一覧は横幅が狭いので、今年のものは年を省いて短く出す
function formatCompactDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const md = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

function formatDisplayDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function renderList() {
  const filterActive = isFilterActive();
  const visibleCount = state.messages.filter(messagePassesFilter).length;

  el.msgCount.textContent = filterActive
    ? `全 ${state.messages.length} 件中 ${visibleCount} 件を表示中`
    : `全 ${state.messages.length} 件`;

  el.filterNote.hidden = !filterActive;

  const activeFilterCount = (currentFilter !== "all" ? 1 : 0) + (currentSpeakerFilter !== "all" ? 1 : 0);
  el.filterSummary.textContent =
    activeFilterCount > 0 ? `絞り込み中：${activeFilterCount}件の条件` : "すべて表示中";
  el.sidebarFilterDot.hidden = activeFilterCount === 0;

  el.messageList.innerHTML = "";

  const frag = document.createDocumentFragment();

  state.messages.forEach((msg, index) => {
    if (!messagePassesFilter(msg)) return;
    frag.appendChild(buildMessageCard(msg, index));
  });

  el.messageList.appendChild(frag);
}

function buildMessageCard(msg, index) {
  const card = document.createElement("div");
  card.className = "msg-card" + (msg.id === selectedMessageId ? " is-selected" : "");
  card.dataset.id = msg.id;
  card.addEventListener("click", () => handleCardTap(msg.id));

  // システムメッセージ（SAN変化通知等）は話者を持たないので専用の見た目にする
  if (msg.isSystem) {
    card.classList.add("msg-card--system");
    card.style.borderLeftColor = "transparent";

    const meta = document.createElement("div");
    meta.className = "msg-card__meta";
    meta.innerHTML =
      `<span class="msg-card__index">#${index + 1}</span>` +
      `<span class="msg-card__tab">${escapeHtml(msg.tab)}</span>`;
    card.appendChild(meta);

    const text = document.createElement("div");
    text.className = "msg-card__system-text";
    text.textContent = msg.text;
    card.appendChild(text);

    return card;
  }

  card.style.borderLeftColor = msg.color;

  const meta = document.createElement("div");
  meta.className = "msg-card__meta";
  meta.innerHTML =
    `<span class="msg-card__index">#${index + 1}</span>` +
    `<span class="msg-card__tab">${escapeHtml(msg.tab)}</span>` +
    (msg.isDiceRoll ? `<span class="msg-card__dice-badge">🎲 ダイスロール</span>` : "");
  card.appendChild(meta);

  // ダイスロールはキャラクター発言でも吹き出しにせず、地の文と同じ見た目にする
  const useCharacterBubble = !msg.isDiceRoll && getSpeakerDisplayType(msg.speaker) === "character";

  if (useCharacterBubble) {
    card.classList.add("msg-card--character");

    const bubbleWrap = document.createElement("div");
    bubbleWrap.className = "msg-card__bubble-wrap";

    const icon = document.createElement("div");
    const dataUrl = msg.iconId ? getImageDataUrl(msg.iconId) : null;
    if (dataUrl) {
      icon.className = "msg-card__icon";
      icon.style.backgroundImage = `url("${dataUrl}")`;
    } else {
      icon.className = "msg-card__icon msg-card__icon--placeholder";
      icon.style.background = normalizeColor(msg.color);
    }
    bubbleWrap.appendChild(icon);

    const bubbleCol = document.createElement("div");
    bubbleCol.className = "msg-card__bubble-col";

    const name = document.createElement("div");
    name.className = "msg-card__bubble-name";
    name.textContent = msg.speaker;
    bubbleCol.appendChild(name);

    const bubble = document.createElement("div");
    bubble.className = "msg-card__bubble";
    bubble.textContent = msg.text;
    bubbleCol.appendChild(bubble);

    bubbleWrap.appendChild(bubbleCol);
    card.appendChild(bubbleWrap);
  } else {
    const speaker = document.createElement("div");
    speaker.className = "msg-card__speaker";
    speaker.innerHTML =
      `<span class="color-dot" style="background:${escapeHtml(normalizeColor(msg.color))}"></span>` +
      `<span>${escapeHtml(msg.speaker)}</span>`;
    card.appendChild(speaker);

    const text = document.createElement("div");
    text.className = "msg-card__text";
    text.textContent = msg.text;
    card.appendChild(text);
  }

  return card;
}

/* ダブルタップ（ダブルクリック）判定。
 * dblclick イベントはタッチ環境での挙動が端末差が大きいので、
 * click の間隔を自前で見て判定する。 */
const DOUBLE_TAP_MS = 320;
let lastTapId = null;
let lastTapAt = 0;

function handleCardTap(id) {
  const now = Date.now();
  const isDoubleTap = id === lastTapId && now - lastTapAt < DOUBLE_TAP_MS;
  lastTapId = isDoubleTap ? null : id;
  lastTapAt = isDoubleTap ? 0 : now;

  if (!isDoubleTap) {
    toggleSelectMessage(id);
    return;
  }

  // ダブルタップ時は必ずその発言を選択状態にしてから編集を開く
  if (selectedMessageId !== id) toggleSelectMessage(id);

  const index = state.messages.findIndex((m) => m.id === id);
  if (index === -1) return;

  // ダブルクリックによる本文の範囲選択を解除しておく
  const selection = window.getSelection();
  if (selection) selection.removeAllRanges();

  openMessageForm({ mode: "edit", index });
}

/* ============================================================
 * 発言の選択と、画面下部の操作バー（S3・S1）
 * ========================================================== */

function findCardEl(id) {
  return el.messageList.querySelector(`[data-id="${CSS.escape(id)}"]`);
}

function toggleSelectMessage(id) {
  const previousId = selectedMessageId;
  selectedMessageId = selectedMessageId === id ? null : id;
  bottomBarMinimized = false;

  if (previousId) {
    const prevEl = findCardEl(previousId);
    if (prevEl) prevEl.classList.remove("is-selected");
  }
  if (selectedMessageId) {
    const curEl = findCardEl(selectedMessageId);
    if (curEl) curEl.classList.add("is-selected");
  }

  renderBottomBar();
}

function deselectMessage() {
  if (!selectedMessageId) return;
  const prevEl = findCardEl(selectedMessageId);
  if (prevEl) prevEl.classList.remove("is-selected");
  selectedMessageId = null;
  renderBottomBar();
}

function getSelectedIndex() {
  return state.messages.findIndex((m) => m.id === selectedMessageId);
}

function renderBottomBar() {
  if (!selectedMessageId) {
    el.bottomBar.hidden = true;
    document.body.style.paddingBottom = "";
    return;
  }

  const index = getSelectedIndex();
  if (index === -1) {
    selectedMessageId = null;
    el.bottomBar.hidden = true;
    document.body.style.paddingBottom = "";
    return;
  }

  const msg = state.messages[index];

  // 絞り込みの結果、選択中の発言が一覧から消えることがある（例：発言者で絞り込み中に
  // その発言の発言者を変更した）。操作バーだけ残ると対象が見えないまま削除できてしまうので、
  // 選択を解除する。
  if (!messagePassesFilter(msg)) {
    const staleEl = findCardEl(selectedMessageId);
    if (staleEl) staleEl.classList.remove("is-selected");
    selectedMessageId = null;
    el.bottomBar.hidden = true;
    document.body.style.paddingBottom = "";
    return;
  }

  const preview = msg.text.length > 16 ? msg.text.slice(0, 16) + "…" : msg.text;

  el.bottomBar.hidden = false;
  el.bottomBarLabel.textContent = `${msg.speaker}：${preview}`;
  el.bottomBarActions.hidden = bottomBarMinimized;
  el.btnBottomBarToggle.textContent = bottomBarMinimized ? "▲" : "▾";

  const filterActive = isFilterActive();
  el.barActionUp.disabled = filterActive || index === 0;
  el.barActionDown.disabled = filterActive || index === state.messages.length - 1;
  el.barActionInsertBelow.disabled = filterActive;

  requestAnimationFrame(() => {
    document.body.style.paddingBottom = el.bottomBar.offsetHeight + 16 + "px";
  });
}

el.btnBottomBarToggle.addEventListener("click", () => {
  bottomBarMinimized = !bottomBarMinimized;
  renderBottomBar();
});

el.btnBottomBarClose.addEventListener("click", deselectMessage);

el.barActionUp.addEventListener("click", () => {
  const idx = getSelectedIndex();
  if (idx === -1) return;
  moveMessage(idx, -1);
});

el.barActionDown.addEventListener("click", () => {
  const idx = getSelectedIndex();
  if (idx === -1) return;
  moveMessage(idx, 1);
});

el.barActionEdit.addEventListener("click", () => {
  const idx = getSelectedIndex();
  if (idx === -1) return;
  openMessageForm({ mode: "edit", index: idx });
});

el.barActionDelete.addEventListener("click", () => {
  const idx = getSelectedIndex();
  if (idx === -1) return;
  deleteMessage(idx);
});

el.barActionInsertBelow.addEventListener("click", () => {
  const idx = getSelectedIndex();
  if (idx === -1) return;
  openMessageForm({ mode: "add", insertAt: idx + 1 });
});

/* ============================================================
 * 並べ替え・削除（5.2 1, 2）
 * ========================================================== */

function setCardIndexLabel(cardEl, index) {
  const label = cardEl.querySelector(".msg-card__index");
  if (label) label.textContent = `#${index + 1}`;
}

function moveMessage(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= state.messages.length) return;
  const [item] = state.messages.splice(index, 1);
  state.messages.splice(target, 0, item);

  // 並べ替えは絞り込み解除中しか押せないため、一覧のDOMは全発言と1対1で対応している。
  // 全再描画は件数が多いと重い（2600件で150ms以上かかり、連続タップがもたつく）ので、
  // 動いた1件だけをDOM上でも動かし、番号が変わる範囲だけ振り直す。
  const movedEl = findCardEl(item.id);
  const anchorEl = target > 0 ? findCardEl(state.messages[target - 1].id) : null;

  if (movedEl && (anchorEl || target === 0)) {
    if (anchorEl) anchorEl.after(movedEl);
    else el.messageList.prepend(movedEl);

    const from = Math.min(index, target);
    const to = Math.max(index, target);
    for (let i = from; i <= to; i++) {
      const cardEl = findCardEl(state.messages[i].id);
      if (cardEl) setCardIndexLabel(cardEl, i);
    }
  } else {
    // 想定外の状態（DOMと状態がずれている等）では安全側に倒して作り直す
    renderList();
  }

  renderBottomBar();
  scheduleAutoSave();

  const cardEl = findCardEl(item.id);
  if (cardEl) cardEl.scrollIntoView({ block: "center", behavior: "smooth" });
}

function deleteMessage(index) {
  const msg = state.messages[index];
  const preview = msg.text.length > 20 ? msg.text.slice(0, 20) + "…" : msg.text;
  const ok = window.confirm(`この発言を削除しますか？\n\n${msg.speaker}：${preview}`);
  if (!ok) return;
  state.messages.splice(index, 1);
  if (selectedMessageId === msg.id) selectedMessageId = null;
  renderAll();
}

function deleteEmptyMessages() {
  const emptyCount = state.messages.filter((m) => m.text.trim() === "").length;
  if (emptyCount === 0) {
    window.alert("本文が空の発言はありませんでした。");
    return;
  }
  const ok = window.confirm(`本文が空の発言が ${emptyCount} 件あります。すべて削除しますか？`);
  if (!ok) return;
  const selectedMsg = state.messages.find((m) => m.id === selectedMessageId);
  if (selectedMsg && selectedMsg.text.trim() === "") selectedMessageId = null;
  state.messages = state.messages.filter((m) => m.text.trim() !== "");
  renderAll();
}

el.btnDeleteEmpty.addEventListener("click", deleteEmptyMessages);

/* ============================================================
 * 追加・編集フォーム（5.2 3, 4, 5）
 * ========================================================== */

let formContext = { mode: "add", index: null, insertAt: null, selectedColor: null, selectedIconId: null };

function getKnownSpeakers() {
  const map = new Map(); // speaker -> { color, count }
  state.messages.forEach((m) => {
    if (!m.speaker) return;
    const entry = map.get(m.speaker) || { colorCounts: new Map() };
    entry.colorCounts.set(m.color, (entry.colorCounts.get(m.color) || 0) + 1);
    map.set(m.speaker, entry);
  });
  const speakers = [];
  map.forEach((entry, speaker) => {
    let bestColor = "#888888";
    let bestCount = -1;
    entry.colorCounts.forEach((count, color) => {
      if (count > bestCount) {
        bestCount = count;
        bestColor = color;
      }
    });
    speakers.push({ speaker, color: bestColor });
  });
  return speakers.sort((a, b) => a.speaker.localeCompare(b.speaker, "ja"));
}

function getKnownTabs() {
  const tabs = new Set(state.messages.map((m) => m.tab));
  if (tabs.size === 0) tabs.add("[main]");
  return Array.from(tabs);
}

// 色スウォッチのHTML。色は必ず正規化＋エスケープしてから属性に埋める。
function buildColorSwatchHtml(color) {
  const c = escapeHtml(normalizeColor(color));
  return `<button type="button" class="color-swatch" data-color="${c}" style="background:${c}"></button>`;
}

function getUsedColors() {
  const colors = new Set(state.messages.map((m) => normalizeColor(m.color)));
  return Array.from(colors);
}

function openMessageForm({ mode, index = null, insertAt = null }) {
  formContext = { mode, index, insertAt, selectedColor: null, selectedIconId: null };

  el.msgFormTitle.textContent = mode === "edit" ? "発言を編集" : "発言を追加";

  // タブ候補
  const knownTabs = getKnownTabs();
  el.fieldTabSelect.innerHTML =
    knownTabs.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("") +
    `<option value="__new__">＋ 新しいタブを追加する</option>`;

  // 話者候補
  const knownSpeakers = getKnownSpeakers();
  el.fieldSpeakerSelect.innerHTML =
    knownSpeakers
      .map(
        (s) =>
          `<option value="${escapeHtml(s.speaker)}" data-color="${escapeHtml(normalizeColor(s.color))}">${escapeHtml(s.speaker)}</option>`
      )
      .join("") + `<option value="__new__">＋ 新しい発言者を登録する</option>`;

  // 色スウォッチ（プリセット ＋ 使用中の色）
  const palette = Array.from(new Set([...COLOR_PRESETS, ...getUsedColors()]));
  el.colorSwatches.innerHTML = palette.map(buildColorSwatchHtml).join("");

  let editingMsg = null;
  if (mode === "edit") {
    editingMsg = state.messages[index];
    el.fieldText.value = editingMsg.text;
    el.fieldDice.checked = editingMsg.isDiceRoll;
    formContext.selectedIconId = editingMsg.iconId || null;

    if (knownTabs.includes(editingMsg.tab)) {
      el.fieldTabSelect.value = editingMsg.tab;
      setNewTabBlockVisible(false);
    } else {
      el.fieldTabSelect.value = "__new__";
      el.fieldTabName.value = editingMsg.tab;
      setNewTabBlockVisible(true);
    }

    const existsInSelect = knownSpeakers.some((s) => s.speaker === editingMsg.speaker);
    if (existsInSelect) {
      el.fieldSpeakerSelect.value = editingMsg.speaker;
      setNewSpeakerBlockVisible(false);
    } else {
      el.fieldSpeakerSelect.value = "__new__";
      el.fieldSpeakerName.value = editingMsg.speaker;
      el.fieldSpeakerColor.value = editingMsg.color;
      setNewSpeakerBlockVisible(true);
      selectColorSwatch(editingMsg.color);
    }
  } else {
    el.fieldText.value = "";
    el.fieldDice.checked = false;
    el.fieldTabName.value = "";
    if (knownTabs.length > 0) {
      el.fieldTabSelect.value = knownTabs[0];
      setNewTabBlockVisible(false);
    } else {
      el.fieldTabSelect.value = "__new__";
      setNewTabBlockVisible(true);
    }
    el.fieldSpeakerName.value = "";
    el.fieldSpeakerColor.value = "";
    if (knownSpeakers.length > 0) {
      el.fieldSpeakerSelect.value = knownSpeakers[0].speaker;
      setNewSpeakerBlockVisible(false);
    } else {
      el.fieldSpeakerSelect.value = "__new__";
      setNewSpeakerBlockVisible(true);
    }
  }

  updateIconFieldVisibility();

  el.overlay.hidden = false;
}

function setNewTabBlockVisible(visible) {
  el.newTabBlock.hidden = !visible;
}

function setNewSpeakerBlockVisible(visible) {
  el.newSpeakerBlock.hidden = !visible;
}

// 発言編集フォームで今選ばれている発言者名（新規登録中ならその入力値）を返す
function getFormSpeakerValue() {
  return el.fieldSpeakerSelect.value === "__new__"
    ? el.fieldSpeakerName.value.trim()
    : el.fieldSpeakerSelect.value;
}

// 選ばれている発言者が「キャラクター発言」の場合のみ、画像選択欄を表示する
function updateIconFieldVisibility() {
  const speaker = getFormSpeakerValue();
  const show = !!speaker && getSpeakerDisplayType(speaker) === "character";
  el.iconFieldBlock.hidden = !show;
  if (show) renderIconPicker(speaker);
}

function renderIconPicker(speaker) {
  const selectedIconId = formContext.selectedIconId;
  const ids = getSpeakerImageIds(speaker);

  el.iconPickerList.innerHTML =
    `<button type="button" class="icon-picker__item${!selectedIconId ? " is-selected" : ""}" data-action="pick-icon" data-icon-id="">画像なし</button>` +
    ids
      .map((id) => {
        const img = getImageById(id);
        const bg = img ? escapeHtml(img.dataUrl) : "";
        const label = img && img.name ? img.name : "名前未設定の表情";
        return `<button type="button" class="icon-picker__item icon-picker__item--image${
          selectedIconId === id ? " is-selected" : ""
        }" data-action="pick-icon" data-icon-id="${escapeHtml(id)}" style="background-image:url('${bg}')" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}を選ぶ"></button>`;
      })
      .join("");

  el.iconPickerList.querySelectorAll('[data-action="pick-icon"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      formContext.selectedIconId = btn.dataset.iconId || null;
      renderIconPicker(speaker);
    });
  });
}

function selectColorSwatch(color) {
  formContext.selectedColor = color;
  el.colorSwatches.querySelectorAll(".color-swatch").forEach((sw) => {
    sw.classList.toggle("is-selected", sw.dataset.color.toLowerCase() === color.toLowerCase());
  });
}

function closeMessageForm() {
  el.overlay.hidden = true;
}

el.fieldTabSelect.addEventListener("change", () => {
  setNewTabBlockVisible(el.fieldTabSelect.value === "__new__");
});

el.fieldSpeakerSelect.addEventListener("change", () => {
  setNewSpeakerBlockVisible(el.fieldSpeakerSelect.value === "__new__");
  formContext.selectedIconId = null;
  updateIconFieldVisibility();
});

el.fieldSpeakerName.addEventListener("input", () => {
  formContext.selectedIconId = null;
  updateIconFieldVisibility();
});

el.fieldIconUpload.addEventListener("change", async () => {
  const file = el.fieldIconUpload.files[0];
  if (!file) return;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    formContext.selectedIconId = addImageToPool(dataUrl, getFormSpeakerValue());
    renderIconPicker(getFormSpeakerValue());
  } catch (e) {
    window.alert("画像の読み込みに失敗しました。");
    console.error(e);
  }
  el.fieldIconUpload.value = "";
});

el.colorSwatches.addEventListener("click", (e) => {
  const btn = e.target.closest(".color-swatch");
  if (!btn) return;
  const color = btn.dataset.color;
  el.fieldSpeakerColor.value = color;
  selectColorSwatch(color);
});

el.fieldSpeakerColor.addEventListener("input", () => {
  const v = el.fieldSpeakerColor.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    selectColorSwatch(v);
  }
});

el.btnCancelMsg.addEventListener("click", closeMessageForm);
el.overlayBackdrop.addEventListener("click", closeMessageForm);

el.msgForm.addEventListener("submit", (e) => {
  e.preventDefault();

  let tab;
  if (el.fieldTabSelect.value === "__new__") {
    tab = el.fieldTabName.value.trim();
    if (!tab) {
      window.alert("タブ名を入力してください。");
      return;
    }
  } else {
    tab = el.fieldTabSelect.value;
  }

  const text = el.fieldText.value.trim();
  if (!text) {
    window.alert("本文を入力してください。");
    return;
  }

  let speaker, color;
  if (el.fieldSpeakerSelect.value === "__new__") {
    speaker = el.fieldSpeakerName.value.trim();
    if (!speaker) {
      window.alert("発言者名を入力してください。");
      return;
    }
    color = el.fieldSpeakerColor.value.trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      window.alert("カラーコードは #03a9f4 のような形式で入力するか、色をタップして選んでください。");
      return;
    }
  } else {
    speaker = el.fieldSpeakerSelect.value;
    const opt = el.fieldSpeakerSelect.selectedOptions[0];
    color = (opt && opt.dataset.color) || "#888888";
  }

  const isDiceRoll = el.fieldDice.checked;
  const iconId = getSpeakerDisplayType(speaker) === "character" ? formContext.selectedIconId || null : null;

  if (formContext.mode === "edit") {
    const msg = state.messages[formContext.index];
    msg.tab = tab;
    msg.speaker = speaker;
    msg.color = normalizeColor(color);
    msg.text = text;
    msg.isDiceRoll = isDiceRoll;
    msg.iconId = iconId;
    // 手動編集した時点で自動生成のシステム通知としての特別扱いは外す
    msg.isSystem = false;
  } else {
    const newMsg = {
      id: uid(),
      tab,
      channel: null,
      isSystem: false,
      speaker,
      color: normalizeColor(color),
      text,
      isDiceRoll,
      diceOutcome: null,
      iconId,
    };
    const insertAt = formContext.insertAt == null ? state.messages.length : formContext.insertAt;
    state.messages.splice(insertAt, 0, newMsg);
  }

  closeMessageForm();
  renderAll();
});

/* ============================================================
 * 既存話者のカラー管理（一括変更）
 * ========================================================== */

function recolorSpeaker(speaker, newColor) {
  const color = normalizeColor(newColor);
  state.messages.forEach((m) => {
    if (m.speaker === speaker) m.color = color;
  });
  renderAll();
  renderSpeakerColorList();
}

// 発言者管理パネル：表情差分画像1件分のサムネイル＋差し替えボタンのHTML
function buildSpeakerImageItemHtml(imageId) {
  const img = getImageById(imageId);
  const bg = img ? escapeHtml(img.dataUrl) : "";
  const name = img ? escapeHtml(img.name || "") : "";
  return `
    <div class="speaker-image-item">
      <button type="button" class="speaker-image-thumb" style="background-image:url('${bg}')" data-action="view-image" data-image-id="${escapeHtml(imageId)}" aria-label="拡大表示"></button>
      <input type="text" class="speaker-image-name" placeholder="表情の名前" value="${name}" data-action="rename-image" data-image-id="${escapeHtml(imageId)}" />
      <button type="button" class="btn btn--secondary btn--small" data-action="replace-image" data-image-id="${escapeHtml(imageId)}">差し替える</button>
      <input type="file" accept="image/*" hidden />
    </div>
  `;
}

// 発言者行の画像まわりのセクション。
// ・キャラクター発言：既存の表情一覧＋「新しい表情を追加」
// ・地の文で画像を1枚も持っていない：最初の画像を挿入する導線（挿入するとキャラクター発言に切り替わる）
// ・地の文だが過去に画像を持っている：件数だけ案内（切り替えれば表示される）
function buildSpeakerImageSectionHtml(speaker, displayType, imageIds) {
  if (displayType === "character") {
    return `<div class="speaker-image-gallery">
      <p class="speaker-image-gallery__note">表情差分（元画像は小さいため拡大表示はぼやけます。タップで拡大、名前を付けて管理できます。「差し替える」で画像を変更、下のボタンで表情を追加できます）</p>
      <div class="speaker-image-list">
        ${
          imageIds.length > 0
            ? imageIds.map(buildSpeakerImageItemHtml).join("")
            : `<p class="speaker-image-gallery__empty">まだ画像がありません。下のボタンから追加できます。</p>`
        }
      </div>
      <label class="btn btn--secondary btn--small">
        ＋ 新しい表情を追加
        <input type="file" accept="image/*" hidden data-action="add-image" />
      </label>
    </div>`;
  }

  if (imageIds.length === 0) {
    return `<div class="speaker-image-gallery">
      <p class="speaker-image-gallery__note">この発言者には元データに画像がありません。画像を追加すると、この発言者のすべての発言に同じ画像が適用され、キャラクター発言（吹き出し表示）に切り替わります。</p>
      <label class="btn btn--secondary btn--small">
        ＋ 画像を追加する
        <input type="file" accept="image/*" hidden data-action="insert-first-image" />
      </label>
    </div>`;
  }

  return `<p class="speaker-image-gallery__hint">画像 ${imageIds.length} 件を保持しています（「キャラクター発言」に切り替えると表示されます）</p>`;
}

async function replaceImageFromFile(imageId, file) {
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const img = getImageById(imageId);
    if (img) img.dataUrl = dataUrl;
    renderAll();
    renderSpeakerColorList();
  } catch (e) {
    window.alert("画像の読み込みに失敗しました。");
    console.error(e);
  }
}

function openImagePreview(imageId) {
  const img = getImageById(imageId);
  if (!img) return;
  el.imagePreviewImg.src = img.dataUrl;
  el.imagePreviewOverlay.hidden = false;
}

function renderSpeakerColorList() {
  const speakers = getKnownSpeakers();
  const palette = Array.from(new Set([...COLOR_PRESETS, ...getUsedColors()]));

  el.speakerColorList.innerHTML = "";

  if (speakers.length === 0) {
    el.speakerColorList.innerHTML = `<p class="panel__desc">まだ発言者がいません。</p>`;
    return;
  }

  speakers.forEach(({ speaker, color }) => {
    const displayType = getSpeakerDisplayType(speaker);
    const imageIds = getSpeakerImageIds(speaker);

    const row = document.createElement("div");
    row.className = "speaker-color-row";
    row.innerHTML = `
      <div class="speaker-color-row__main">
        <span class="color-dot" style="background:${escapeHtml(normalizeColor(color))}"></span>
        <span class="speaker-color-row__name">${escapeHtml(speaker)}</span>
        <button type="button" class="btn btn--secondary btn--small" data-action="toggle">色を変更</button>
      </div>
      <div class="speaker-color-row__editor" hidden>
        <div class="color-swatches">
          ${palette.map(buildColorSwatchHtml).join("")}
        </div>
        <div class="speaker-color-row__hex">
          <input type="text" placeholder="#03a9f4" />
          <button type="button" class="btn btn--primary btn--small" data-action="apply-hex">適用</button>
        </div>
      </div>

      <div class="speaker-type-toggle" role="group" aria-label="表示方法">
        <button type="button" class="speaker-type-btn${displayType === "character" ? " is-active" : ""}" data-action="set-type" data-type="character">🗨️ キャラクター発言</button>
        <button type="button" class="speaker-type-btn${displayType === "narration" ? " is-active" : ""}" data-action="set-type" data-type="narration">地の文</button>
      </div>

      ${buildSpeakerImageSectionHtml(speaker, displayType, imageIds)}
    `;

    const editor = row.querySelector(".speaker-color-row__editor");
    const hexInput = row.querySelector(".speaker-color-row__hex input");

    row.querySelector('[data-action="toggle"]').addEventListener("click", () => {
      editor.hidden = !editor.hidden;
    });

    row.querySelectorAll(".color-swatch").forEach((sw) => {
      sw.addEventListener("click", () => recolorSpeaker(speaker, sw.dataset.color));
    });

    row.querySelector('[data-action="apply-hex"]').addEventListener("click", () => {
      const v = hexInput.value.trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
        window.alert("カラーコードは #03a9f4 のような形式で入力してください。");
        return;
      }
      recolorSpeaker(speaker, v);
    });

    row.querySelectorAll('[data-action="set-type"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        setSpeakerDisplayType(speaker, btn.dataset.type);
        renderSpeakerColorList();
      });
    });

    row.querySelectorAll('[data-action="view-image"]').forEach((btn) => {
      btn.addEventListener("click", () => openImagePreview(btn.dataset.imageId));
    });

    row.querySelectorAll('[data-action="replace-image"]').forEach((btn) => {
      const fileInput = btn.parentElement.querySelector('input[type="file"]');
      btn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        const file = fileInput.files[0];
        if (file) replaceImageFromFile(btn.dataset.imageId, file);
        fileInput.value = "";
      });
    });

    row.querySelectorAll('[data-action="rename-image"]').forEach((input) => {
      input.addEventListener("change", () => renameImage(input.dataset.imageId, input.value));
    });

    // 既存キャラクターへの表情追加：一覧を作り直すだけでよい（発言への割り当てはしない）
    const addImageInput = row.querySelector('[data-action="add-image"]');
    if (addImageInput) {
      addImageInput.addEventListener("change", async () => {
        const file = addImageInput.files[0];
        if (!file) return;
        try {
          const dataUrl = await readFileAsDataUrl(file);
          addSpeakerImage(speaker, dataUrl);
          renderSpeakerColorList();
        } catch (e) {
          window.alert("画像の読み込みに失敗しました。");
          console.error(e);
        }
        addImageInput.value = "";
      });
    }

    // 元データに画像を持たない発言者への初めての画像挿入：全発言に反映し、キャラクター発言に切り替える
    const insertFirstInput = row.querySelector('[data-action="insert-first-image"]');
    if (insertFirstInput) {
      insertFirstInput.addEventListener("change", async () => {
        const file = insertFirstInput.files[0];
        if (!file) return;
        try {
          const dataUrl = await readFileAsDataUrl(file);
          insertFirstImageForSpeaker(speaker, dataUrl);
          renderSpeakerColorList();
        } catch (e) {
          window.alert("画像の読み込みに失敗しました。");
          console.error(e);
        }
        insertFirstInput.value = "";
      });
    }

    el.speakerColorList.appendChild(row);
  });
}

el.btnManageSpeakerColors.addEventListener("click", () => {
  renderSpeakerColorList();
  el.speakerColorOverlay.hidden = false;
});
el.btnCloseSpeakerColors.addEventListener("click", () => {
  el.speakerColorOverlay.hidden = true;
});
el.speakerColorOverlayBackdrop.addEventListener("click", () => {
  el.speakerColorOverlay.hidden = true;
});

el.btnCloseImagePreview.addEventListener("click", () => {
  el.imagePreviewOverlay.hidden = true;
});
el.imagePreviewOverlayBackdrop.addEventListener("click", () => {
  el.imagePreviewOverlay.hidden = true;
});

/* ============================================================
 * ダイス本文の自動再判定（本文を編集した際の参考用トグル）
 * ========================================================== */

el.fieldText.addEventListener("input", () => {
  if (formContext.mode === "add") {
    el.fieldDice.checked = detectDiceRoll(el.fieldText.value);
  }
});

/* ============================================================
 * 一時保存：ハイブリッドHTMLの生成（5.3章）
 * ========================================================== */

function buildHybridHtml() {
  const savedAt = new Date().toISOString();
  state.meta.savedAt = savedAt;
  if (!state.meta.sourceFileName) {
    state.meta.sourceFileName = state.loadedFileName;
  }

  const bodyHtml = state.messages
    .map((m) => {
      const textHtml = escapeHtml(m.text).replace(/\n/g, "<br>");
      return `<p style="color:${escapeHtml(normalizeColor(m.color))};">
  <span> ${escapeHtml(m.tab)}</span>
  <span>${escapeHtml(m.speaker)}</span> :
  <span>
    ${textHtml}
  </span>
</p>`;
    })
    .join("\n\n");

  const jsonData = {
    schemaVersion: SCHEMA_VERSION,
    savedAt,
    sourceFileName: state.meta.sourceFileName || null,
    messages: state.messages.map((m) => ({
      id: m.id,
      tab: m.tab,
      channel: m.channel,
      isSystem: m.isSystem,
      speaker: m.speaker,
      color: m.color,
      text: m.text,
      isDiceRoll: m.isDiceRoll,
      diceOutcome: m.diceOutcome,
      iconId: m.iconId,
    })),
    images: state.images,
    speakerSettings: state.speakerSettings,
  };

  // JSON内に "</script>" が出現してもスクリプトタグが壊れないようにエスケープする
  const jsonText = JSON.stringify(jsonData, null, 2).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="X-UA-Compatible" content="ie=edge" />
    <title>ccfolia - logs</title>
  </head>
  <body>

${bodyHtml}

<script type="application/json" id="${STATE_SCRIPT_ID}">
${jsonText}
</script>
  </body>
</html>
`;
}

function buildSavedFileName() {
  const base = stripExtension(state.loadedFileName || "ccfolia-log");
  return `${base}_${formatTimestampForFilename(new Date())}.html`;
}

function downloadTextFile(fileName, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// PCの上書き保存で使う、日時を含まない固定のファイル名。
// 中身が実際に上書きされていく1つの作業用ファイルなので、名前も変えない。
// 元のココフォリアのファイル名を基準にするため、保存ファイルを読み直しても名前が伸びていかない。
function buildOverwriteFileName() {
  const base = stripExtension(state.meta.sourceFileName || state.loadedFileName || "ccfolia-log");
  return `${base}_編集中.html`;
}

async function saveTemp() {
  const html = buildHybridHtml();

  if (typeof window.showSaveFilePicker === "function") {
    try {
      if (!saveFileHandle) {
        saveFileHandle = await window.showSaveFilePicker({
          suggestedName: buildOverwriteFileName(),
          types: [{ description: "HTML", accept: { "text/html": [".html"] } }],
        });
      }
      const writable = await saveFileHandle.createWritable();
      await writable.write(html);
      await writable.close();
      el.saveTempStatus.textContent = `${saveFileHandle.name} に保存しました。次からは同じファイルに上書きされます。`;
      renderAll();
      return;
    } catch (e) {
      // 保存ダイアログを閉じただけなら何もしない
      if (e && e.name === "AbortError") return;
      // 権限切れ・削除などで書けなくなった場合は保存先を忘れ、ダウンロードで保存する
      saveFileHandle = null;
      console.warn("ファイルへの上書き保存に失敗したため、ダウンロードで保存します:", e);
    }
  }

  const fileName = buildSavedFileName();
  downloadTextFile(fileName, html, "text/html");
  el.saveTempStatus.textContent = `${fileName} を保存しました。`;
  renderAll();
}

el.btnSaveTemp.addEventListener("click", saveTemp);

/* ============================================================
 * 共有シートで保存（iPhone・iPad向け）
 * できるのは「保存先を選ぶ」ことだけ。
 * iOSは同名ファイルがあっても置き換えを確認せず別名で保存するため、
 * 上書きはできない（実機で確認済み）。そのため、ファイル名は
 * 「一時保存」と同じ日時つきにして、どれがいつの保存か分かるようにする。
 * ========================================================== */

function canShareHtmlFile() {
  if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [new File(["<html></html>"], "test.html", { type: "text/html" })] });
  } catch (e) {
    return false;
  }
}

async function shareTemp() {
  const fileName = buildSavedFileName();
  // navigator.share はユーザー操作の直後に呼ぶ必要があるので、ここまでは同期処理のままにする
  const file = new File([buildHybridHtml()], fileName, { type: "text/html" });

  try {
    await navigator.share({ files: [file] });
    el.saveTempStatus.textContent = `${fileName} を共有しました。`;
  } catch (e) {
    if (e && e.name === "AbortError") return;
    el.saveTempStatus.textContent = "共有できませんでした。「一時保存（HTML）」をお試しください。";
    console.warn("共有に失敗しました:", e);
  }
  renderAll();
}

el.btnShareTemp.addEventListener("click", shareTemp);
el.btnShareTemp.hidden = !canShareHtmlFile();

/* ============================================================
 * Markdown書き出し（5.5章・7章）
 * ========================================================== */

// 色コードに最も近い丸絵文字を返す（Markdownは文字色を指定できないため、
// 話者ごとの色を見分けられるようにする近似表現。厳密な同一HEX値の再現は不可）
const COLOR_EMOJI_PALETTE = [
  { emoji: "🔴", rgb: [244, 67, 54] },
  { emoji: "🟠", rgb: [255, 152, 0] },
  { emoji: "🟡", rgb: [255, 235, 59] },
  { emoji: "🟢", rgb: [76, 175, 80] },
  { emoji: "🔵", rgb: [33, 150, 243] },
  { emoji: "🟣", rgb: [156, 39, 176] },
  { emoji: "🟤", rgb: [121, 85, 72] },
  { emoji: "⚫", rgb: [0, 0, 0] },
  { emoji: "⚪", rgb: [255, 255, 255] },
];

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function nearestColorEmoji(hex) {
  let rgb;
  try {
    rgb = hexToRgb(hex);
  } catch (e) {
    return "⚪";
  }
  let best = COLOR_EMOJI_PALETTE[0];
  let bestDist = Infinity;
  COLOR_EMOJI_PALETTE.forEach((c) => {
    const dist = (c.rgb[0] - rgb[0]) ** 2 + (c.rgb[1] - rgb[1]) ** 2 + (c.rgb[2] - rgb[2]) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  });
  return best.emoji;
}

function buildExportLines(markdownStyle) {
  const lines = [];
  let currentTab = null;
  let prevWasMessage = false;

  state.messages.forEach((m) => {
    if (m.tab !== currentTab) {
      lines.push(markdownStyle ? `### ${m.tab}` : m.tab);
      currentTab = m.tab;
      prevWasMessage = false;
    } else if (prevWasMessage) {
      lines.push("");
    }
    const flatText = m.text.replace(/\n/g, " ");
    const trimmedSpeaker = m.speaker.trim();
    const isKpOrPl = state.previewRoles.kp.includes(trimmedSpeaker) || state.previewRoles.pl.includes(trimmedSpeaker);
    const emojiPrefix = isKpOrPl ? "" : `${nearestColorEmoji(m.color)} `;
    const speakerLabel = markdownStyle ? `**${m.speaker}**` : m.speaker;
    lines.push(`${emojiPrefix}${speakerLabel}：${flatText}`);
    prevWasMessage = true;
  });

  return lines.join("\n");
}

function buildMarkdown() {
  return buildExportLines(true);
}

function buildPlainText() {
  return buildExportLines(false);
}

/* ============================================================
 * プレビュー用HTMLの生成（Notion貼り付け・閲覧専用、編集には戻せない）
 * ========================================================== */

// 自己完結スタイル。Notion貼り付け・外部ホスティングどちらでも崩れないよう、
// 外部リソース・スクリプトを一切使わずインラインCSSのみで完結させる。
// フォント・文字サイズは本ツールの画面表示（style.css の body / .msg-card__text）に合わせている。
const PREVIEW_HTML_STYLE = `
  :root { color-scheme: light dark; font-size: 17px; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 16px 64px;
    background: #fbfaf8;
    color: #2b2b2b;
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", sans-serif;
    font-size: 1rem;
    line-height: 1.8;
    -webkit-text-size-adjust: 100%;
  }
  .ccpv-wrap {
    max-width: 640px;
    margin: 0 auto;
  }
  .ccpv-line {
    margin: 0 0 0.9em;
    padding-left: 10px;
    border-left: 3px solid transparent;
    overflow-wrap: break-word;
    word-break: break-word;
  }
  .ccpv-speaker {
    font-weight: 700;
    color: #555;
  }
  .ccpv-role-kp.ccpv-tab-main {
    border-left-color: #3b6fa8;
  }
  .ccpv-role-kp > .ccpv-speaker {
    color: #3b6fa8;
  }
  .ccpv-role-pl.ccpv-tab-main {
    border-left-color: #a85a3b;
  }
  .ccpv-role-pl > .ccpv-speaker {
    color: #a85a3b;
  }
  .ccpv-tab-other {
    color: #999;
  }
  .ccpv-tab-other .ccpv-speaker {
    color: #999 !important;
  }
  .ccpv-tab-info {
    margin-left: 1.6em;
    padding: 0.5em 0.9em;
    border-left: 3px solid #d8d3c8;
    background: rgba(0, 0, 0, 0.035);
    color: #4a4a4a;
  }
  .ccpv-system {
    text-align: center;
    color: #999;
    font-size: 0.85em;
  }
  .ccpv-bubble-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin: 0 0 0.9em;
  }
  .ccpv-bubble-row.ccpv-tab-other {
    opacity: 0.6;
  }
  .ccpv-bubble-avatar {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background-size: cover;
    background-position: center;
    flex: none;
    border: 1px solid rgba(0, 0, 0, 0.15);
  }
  .ccpv-bubble-col {
    min-width: 0;
  }
  .ccpv-bubble-name {
    font-weight: 700;
    font-size: 0.85em;
    color: #555;
    margin-bottom: 2px;
  }
  .ccpv-bubble {
    position: relative;
    display: inline-block;
    background: rgba(0, 0, 0, 0.045);
    border-radius: 14px;
    padding: 0.5em 0.9em;
    overflow-wrap: break-word;
    word-break: break-word;
  }
  .ccpv-bubble::before {
    content: "";
    position: absolute;
    left: -6px;
    top: 12px;
    border-width: 6px 8px 6px 0;
    border-style: solid;
    border-color: transparent rgba(0, 0, 0, 0.045) transparent transparent;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #e7e9ee; }
    .ccpv-speaker { color: #c7cbd4; }
    .ccpv-role-kp.ccpv-tab-main { border-left-color: #6ea3e0; }
    .ccpv-role-kp > .ccpv-speaker { color: #6ea3e0; }
    .ccpv-role-pl.ccpv-tab-main { border-left-color: #e0916e; }
    .ccpv-role-pl > .ccpv-speaker { color: #e0916e; }
    .ccpv-tab-other { color: #6b7078; }
    .ccpv-tab-other .ccpv-speaker { color: #6b7078 !important; }
    .ccpv-tab-info {
      border-left-color: #3a3d44;
      background: rgba(255, 255, 255, 0.04);
      color: #c7cbd4;
    }
    .ccpv-system { color: #6b7078; }
    .ccpv-bubble-name { color: #c7cbd4; }
    .ccpv-bubble { background: rgba(255, 255, 255, 0.08); }
    .ccpv-bubble::before { border-color: transparent rgba(255, 255, 255, 0.08) transparent transparent; }
  }
`;

// タブは自由記述だが、"main" "info" "other"（大文字小文字は問わない）という名前を
// 特別扱いする。それ以外の名前のタブはmainと同じ通常表示にする。
// normalize("NFKC")で全角英字（日本語入力中に打った "info" など）も半角と同じ扱いにする。
// ココフォリアの書き出しHTMLは既定のタブ名が "[main]" "[info]" "[other]" のように
// 角括弧付きなので、丸ごと囲われている場合は括弧を外してから判定する。
// タブ名の文字列から推測する（旧形式・チャンネルIDを持たないデータ向けのフォールバック）
function getTabCategory(tab) {
  let t = tab.trim().normalize("NFKC").toLowerCase();
  const bracketed = t.match(/^\[(.+)\]$/);
  if (bracketed) t = bracketed[1];
  if (t === "info") return "info";
  if (t === "other") return "other";
  return "main";
}

// 新形式は <article data-channel="..."> の安定IDで判定する（表示名は
// 「[メイン]」「[情報]」のように日本語化されており、文字列からの推測はできないため）。
// channel情報がない（旧形式・古い保存データ）場合のみ、タブ表示名から推測する。
function getMessageTabCategory(msg) {
  if (msg.channel === "info") return "info";
  if (msg.channel === "other") return "other";
  if (msg.channel) return "main";
  return getTabCategory(msg.tab);
}

// 1メッセージ分のHTML。
// KP/PL扱いにする発言者は、サイドバーの「KP/PL表示を設定」で選んだ発言者名（state.previewRoles）で判定する。
// サイコロ発言(isDiceRoll)も特別扱いせず、他の発言と同じ見た目にする（ト書き調の統一感を優先）。
// 発言者管理で「キャラクター発言」に設定された発言者は、ツール内の一覧と同じく
// アイコン＋吹き出しの見た目にする。
function buildPreviewLineHtml(msg) {
  const category = getMessageTabCategory(msg);
  const textHtml = escapeHtml(msg.text).replace(/\n/g, "<br>");

  if (msg.isSystem) {
    return `<p class="ccpv-line ccpv-system">${textHtml}</p>`;
  }

  // infoタブ：話者名を出さず、引用ブロックのようにインデントを下げて表示する
  if (category === "info") {
    return `<p class="ccpv-line ccpv-tab-info">${textHtml}</p>`;
  }

  const trimmedSpeaker = msg.speaker.trim();
  const isKp = state.previewRoles.kp.includes(trimmedSpeaker);
  const isPl = state.previewRoles.pl.includes(trimmedSpeaker);

  if (!msg.isDiceRoll && getSpeakerDisplayType(msg.speaker) === "character") {
    const dataUrl = msg.iconId ? getImageDataUrl(msg.iconId) : null;
    const avatarStyle = dataUrl
      ? `background-image:url('${escapeHtml(dataUrl)}');`
      : `background:${escapeHtml(normalizeColor(msg.color))};`;
    const rowClasses = ["ccpv-bubble-row", `ccpv-tab-${category}`];
    return `<div class="${rowClasses.join(" ")}">
      <div class="ccpv-bubble-avatar" style="${avatarStyle}"></div>
      <div class="ccpv-bubble-col">
        <div class="ccpv-bubble-name">${escapeHtml(msg.speaker)}</div>
        <div class="ccpv-bubble">${textHtml}</div>
      </div>
    </div>`;
  }

  const classes = ["ccpv-line", `ccpv-tab-${category}`];
  if (isKp) classes.push("ccpv-role-kp");
  if (isPl) classes.push("ccpv-role-pl");

  // 個別話者（KP/PL以外）は、グレー表示（otherタブ）でないときだけ本人の色をインラインで反映する。
  const speakerStyle =
    !isKp && !isPl && category !== "other" ? ` style="color:${escapeHtml(normalizeColor(msg.color))};"` : "";

  return `<p class="${classes.join(" ")}"><span class="ccpv-speaker"${speakerStyle}>${escapeHtml(
    msg.speaker
  )}</span>：${textHtml}</p>`;
}

function buildPreviewHtml() {
  const bodyHtml = state.messages.map((m) => buildPreviewLineHtml(m)).join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>セッションログ</title>
    <style>${PREVIEW_HTML_STYLE}</style>
  </head>
  <body>
    <div class="ccpv-wrap">
${bodyHtml}
    </div>
  </body>
</html>
`;
}

function getExportContent() {
  if (el.exportFormatSelect.value === "text") {
    return { content: buildPlainText(), ext: "txt", mime: "text/plain", label: "テキスト", fileNameSuffix: "" };
  }
  if (el.exportFormatSelect.value === "preview-html") {
    return { content: buildPreviewHtml(), ext: "html", mime: "text/html", label: "プレビュー用HTML", fileNameSuffix: "_preview" };
  }
  return { content: buildMarkdown(), ext: "md", mime: "text/markdown", label: "Markdown", fileNameSuffix: "" };
}

function updateExportFormatNote() {
  const isPreviewHtml = el.exportFormatSelect.value === "preview-html";
  el.exportFormatNote.textContent = isPreviewHtml
    ? "※閲覧専用です。このツールへの読み込みには使えません。ダウンロードしてNotionなどに取り込んでください。"
    : "";
  // プレビュー用HTMLはNotionへの貼り付け・ダウンロード専用なので、コピーは提供しない
  el.btnCopyExport.hidden = isPreviewHtml;
}
el.exportFormatSelect.addEventListener("change", updateExportFormatNote);
updateExportFormatNote();

// プレビュー用HTMLでKP・PLとして表示する発言者を選ぶ一覧。
// 1人の発言者がKPとPLの両方に入らないよう、片方を選ぶともう片方は自動で外す。
function togglePreviewRole(speaker, role) {
  const other = role === "kp" ? "pl" : "kp";
  const list = state.previewRoles[role];
  const idx = list.indexOf(speaker);
  if (idx === -1) {
    list.push(speaker);
    const otherIdx = state.previewRoles[other].indexOf(speaker);
    if (otherIdx !== -1) state.previewRoles[other].splice(otherIdx, 1);
  } else {
    list.splice(idx, 1);
  }
}

function renderPreviewRoleList() {
  const speakers = getKnownSpeakers();
  el.previewRoleList.innerHTML = "";

  if (speakers.length === 0) {
    el.previewRoleList.innerHTML = `<p class="panel__desc">まだ発言者がいません。</p>`;
    return;
  }

  speakers.forEach(({ speaker, color }) => {
    const row = document.createElement("div");
    row.className = "preview-role-row";
    row.innerHTML = `
      <span class="color-dot" style="background:${escapeHtml(normalizeColor(color))}"></span>
      <span class="preview-role-row__name">${escapeHtml(speaker)}</span>
      <label class="preview-role-row__check">
        <input type="checkbox" data-role="kp" ${state.previewRoles.kp.includes(speaker) ? "checked" : ""} /> KP
      </label>
      <label class="preview-role-row__check">
        <input type="checkbox" data-role="pl" ${state.previewRoles.pl.includes(speaker) ? "checked" : ""} /> PL
      </label>
    `;

    row.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        togglePreviewRole(speaker, cb.dataset.role);
        renderPreviewRoleList();
      });
    });

    el.previewRoleList.appendChild(row);
  });
}

el.btnManagePreviewRoles.addEventListener("click", () => {
  renderPreviewRoleList();
  el.previewRoleOverlay.hidden = false;
});
el.btnClosePreviewRoles.addEventListener("click", () => {
  el.previewRoleOverlay.hidden = true;
});
el.previewRoleOverlayBackdrop.addEventListener("click", () => {
  el.previewRoleOverlay.hidden = true;
});

el.btnCopyExport.addEventListener("click", async () => {
  const { content, label } = getExportContent();
  try {
    await navigator.clipboard.writeText(content);
    el.exportStatus.textContent = `コピーしました（${label}）。貼り付けてご利用ください。`;
  } catch (e) {
    el.exportStatus.textContent = "コピーに失敗しました。「ダウンロード」をお試しください。";
  }
});

el.btnDownloadExport.addEventListener("click", () => {
  const { content, ext, mime, fileNameSuffix } = getExportContent();
  const base = stripExtension(state.loadedFileName || "ccfolia-log");
  downloadTextFile(`${base}${fileNameSuffix}.${ext}`, content, mime);
  el.exportStatus.textContent = "ダウンロードしました。";
});

/* ============================================================
 * ファイル読み込みのUIハンドリング（5.1章）
 * ========================================================== */

el.fileInput.addEventListener("change", () => {
  const file = el.fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      loadFromHtmlString(String(reader.result), file.name);
    } catch (e) {
      window.alert("ファイルの読み込みに失敗しました。ココフォリアの書き出しHTML、または本ツールで保存したHTMLを選んでください。");
      console.error(e);
    }
  };
  reader.onerror = () => {
    window.alert("ファイルの読み込みに失敗しました。");
  };
  reader.readAsText(file, "UTF-8");

  el.fileInput.value = "";
});

// 起動時：前回までの編集内容が残っていれば復元を案内する
renderRestoreList();

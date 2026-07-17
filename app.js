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
  messages: [],   // { id, tab, speaker, color, text, isDiceRoll }
  meta: {
    schemaVersion: SCHEMA_VERSION,
    savedAt: null,
    sourceFileName: null,
  },
  loadedFileName: null,
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
    .replace(/"/g, "&quot;");
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

function parseCcfoliaHtml(htmlString) {
  const doc = new DOMParser().parseFromString(htmlString, "text/html");
  const paragraphs = doc.querySelectorAll('p[style*="color:"]');
  const messages = [];

  paragraphs.forEach((p) => {
    const spans = p.querySelectorAll(":scope > span");
    if (spans.length < 3) return;

    const styleAttr = p.getAttribute("style") || "";
    const colorMatch = styleAttr.match(/color:\s*(#[0-9a-fA-F]{6})/);
    const color = colorMatch ? colorMatch[1].toLowerCase() : "#888888";

    const tab = extractSpanText(spans[0]);
    const speaker = extractSpanText(spans[1]);
    const text = extractSpanText(spans[2]);

    messages.push({
      id: uid(),
      tab: tab || "[main]",
      speaker,
      color,
      text,
      isDiceRoll: detectDiceRoll(text),
    });
  });

  return {
    messages,
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

  const messages = (data.messages || []).map((m) => ({
    id: m.id || uid(),
    tab: m.tab || "[main]",
    speaker: m.speaker || "",
    color: (m.color || "#888888").toLowerCase(),
    text: m.text || "",
    isDiceRoll: !!m.isDiceRoll,
  }));

  return {
    messages,
    meta: {
      schemaVersion: data.schemaVersion || SCHEMA_VERSION,
      savedAt: data.savedAt || null,
      sourceFileName: data.sourceFileName || null,
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
  state.meta = result.meta;
  state.loadedFileName = fileName;

  selectedMessageId = null;
  bottomBarMinimized = false;
  loadSectionExpanded = false;

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
  sectionExport: document.getElementById("section-export"),
  msgCount: document.getElementById("msg-count"),
  messageList: document.getElementById("message-list"),
  btnAddTop: document.getElementById("btn-add-top"),
  btnAddBottom: document.getElementById("btn-add-bottom"),
  btnSaveTemp: document.getElementById("btn-save-temp"),
  btnCopyMd: document.getElementById("btn-copy-md"),
  btnDownloadMd: document.getElementById("btn-download-md"),
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

function messagePassesFilter(msg) {
  if (currentSpeakerFilter !== "all" && msg.speaker !== currentSpeakerFilter) return false;

  switch (currentFilter) {
    case "dice":
      return msg.isDiceRoll;
    case "dice-success":
      return msg.isDiceRoll && diceOutcomeGroup(classifyDiceOutcome(msg.text)) === "success";
    case "dice-failure":
      return msg.isDiceRoll && diceOutcomeGroup(classifyDiceOutcome(msg.text)) === "failure";
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
    `<option value="all">すべての話者</option>` +
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
  const showFull = !hasFile || loadSectionExpanded;
  el.loadFull.hidden = !showFull;
  el.loadCollapsed.hidden = showFull;
  if (hasFile) {
    el.loadCollapsedText.textContent = `① ${state.loadedFileName}（${state.messages.length} 件）読み込み中`;
  }
}

el.btnLoadExpand.addEventListener("click", () => {
  loadSectionExpanded = true;
  renderLoadSection();
});

/* ============================================================
 * 一覧の描画（5.2章）
 * ========================================================== */

function renderAll() {
  const hasMessages = state.messages.length > 0;
  el.sectionEditor.hidden = !hasMessages;
  el.sectionExport.hidden = !hasMessages;
  el.sidebar.hidden = !hasMessages;
  el.btnSidebarOpen.hidden = !hasMessages;
  if (!hasMessages) closeSidebar();

  el.loadStatus.textContent = state.loadedFileName
    ? `読み込み中のファイル：${state.loadedFileName}（発言 ${state.messages.length} 件）` +
      (state.meta.savedAt ? ` / 保存日時：${formatDisplayDate(state.meta.savedAt)}` : "")
    : "まだファイルが読み込まれていません。";

  renderLoadSection();
  updateSpeakerFilterOptions();
  renderList();
  renderBottomBar();
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
  card.style.borderLeftColor = msg.color;
  card.dataset.id = msg.id;

  const meta = document.createElement("div");
  meta.className = "msg-card__meta";
  meta.innerHTML =
    `<span class="msg-card__index">#${index + 1}</span>` +
    `<span class="msg-card__tab">${escapeHtml(msg.tab)}</span>` +
    (msg.isDiceRoll ? `<span class="msg-card__dice-badge">🎲 ダイスロール</span>` : "");
  card.appendChild(meta);

  const speaker = document.createElement("div");
  speaker.className = "msg-card__speaker";
  speaker.innerHTML =
    `<span class="color-dot" style="background:${escapeHtml(msg.color)}"></span>` +
    `<span>${escapeHtml(msg.speaker)}</span>`;
  card.appendChild(speaker);

  const text = document.createElement("div");
  text.className = "msg-card__text";
  text.textContent = msg.text;
  card.appendChild(text);

  card.addEventListener("click", () => toggleSelectMessage(msg.id));

  return card;
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

function moveMessage(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= state.messages.length) return;
  const [item] = state.messages.splice(index, 1);
  state.messages.splice(target, 0, item);
  renderList();
  renderBottomBar();

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

let formContext = { mode: "add", index: null, insertAt: null, selectedColor: null };

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

function getUsedColors() {
  const colors = new Set(state.messages.map((m) => m.color));
  return Array.from(colors);
}

function openMessageForm({ mode, index = null, insertAt = null }) {
  formContext = { mode, index, insertAt, selectedColor: null };

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
      .map((s) => `<option value="${escapeHtml(s.speaker)}" data-color="${s.color}">${escapeHtml(s.speaker)}</option>`)
      .join("") + `<option value="__new__">＋ 新しい話者を登録する</option>`;

  // 色スウォッチ（プリセット ＋ 使用中の色）
  const palette = Array.from(new Set([...COLOR_PRESETS, ...getUsedColors()]));
  el.colorSwatches.innerHTML = palette
    .map((c) => `<button type="button" class="color-swatch" data-color="${c}" style="background:${c}"></button>`)
    .join("");

  let editingMsg = null;
  if (mode === "edit") {
    editingMsg = state.messages[index];
    el.fieldText.value = editingMsg.text;
    el.fieldDice.checked = editingMsg.isDiceRoll;

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

  el.overlay.hidden = false;
}

function setNewTabBlockVisible(visible) {
  el.newTabBlock.hidden = !visible;
}

function setNewSpeakerBlockVisible(visible) {
  el.newSpeakerBlock.hidden = !visible;
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
      window.alert("話者名を入力してください。");
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

  if (formContext.mode === "edit") {
    const msg = state.messages[formContext.index];
    msg.tab = tab;
    msg.speaker = speaker;
    msg.color = color.toLowerCase();
    msg.text = text;
    msg.isDiceRoll = isDiceRoll;
  } else {
    const newMsg = {
      id: uid(),
      tab,
      speaker,
      color: color.toLowerCase(),
      text,
      isDiceRoll,
    };
    const insertAt = formContext.insertAt == null ? state.messages.length : formContext.insertAt;
    state.messages.splice(insertAt, 0, newMsg);
  }

  closeMessageForm();
  renderAll();
});

el.btnAddTop.addEventListener("click", () => openMessageForm({ mode: "add", insertAt: 0 }));
el.btnAddBottom.addEventListener("click", () => openMessageForm({ mode: "add", insertAt: state.messages.length }));

/* ============================================================
 * 既存話者のカラー管理（一括変更）
 * ========================================================== */

function recolorSpeaker(speaker, newColor) {
  const color = newColor.toLowerCase();
  state.messages.forEach((m) => {
    if (m.speaker === speaker) m.color = color;
  });
  renderAll();
  renderSpeakerColorList();
}

function renderSpeakerColorList() {
  const speakers = getKnownSpeakers();
  const palette = Array.from(new Set([...COLOR_PRESETS, ...getUsedColors()]));

  el.speakerColorList.innerHTML = "";

  if (speakers.length === 0) {
    el.speakerColorList.innerHTML = `<p class="panel__desc">まだ話者がいません。</p>`;
    return;
  }

  speakers.forEach(({ speaker, color }) => {
    const row = document.createElement("div");
    row.className = "speaker-color-row";
    row.innerHTML = `
      <div class="speaker-color-row__main">
        <span class="color-dot" style="background:${escapeHtml(color)}"></span>
        <span class="speaker-color-row__name">${escapeHtml(speaker)}</span>
        <button type="button" class="btn btn--secondary btn--small" data-action="toggle">色を変更</button>
      </div>
      <div class="speaker-color-row__editor" hidden>
        <div class="color-swatches">
          ${palette
            .map((c) => `<button type="button" class="color-swatch" data-color="${c}" style="background:${c}"></button>`)
            .join("")}
        </div>
        <div class="speaker-color-row__hex">
          <input type="text" placeholder="#03a9f4" />
          <button type="button" class="btn btn--primary btn--small" data-action="apply-hex">適用</button>
        </div>
      </div>
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
      return `<p style="color:${m.color};">
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
      speaker: m.speaker,
      color: m.color,
      text: m.text,
      isDiceRoll: m.isDiceRoll,
    })),
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

function saveTemp() {
  const html = buildHybridHtml();
  const fileName = buildSavedFileName();
  downloadTextFile(fileName, html, "text/html");
  renderAll();
}

el.btnSaveTemp.addEventListener("click", saveTemp);

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

function buildMarkdown() {
  const lines = [];
  let currentTab = null;
  let prevWasMessage = false;

  state.messages.forEach((m) => {
    if (m.tab !== currentTab) {
      lines.push(`### ${m.tab}`);
      currentTab = m.tab;
      prevWasMessage = false;
    } else if (prevWasMessage) {
      lines.push("");
    }
    const flatText = m.text.replace(/\n/g, " ");
    const noEmojiSpeakers = ["KP", "PL"];
    const prefix = noEmojiSpeakers.includes(m.speaker.trim()) ? "" : `${nearestColorEmoji(m.color)} `;
    lines.push(`${prefix}**${m.speaker}**：${flatText}`);
    prevWasMessage = true;
  });

  return lines.join("\n");
}

el.btnCopyMd.addEventListener("click", async () => {
  const md = buildMarkdown();
  try {
    await navigator.clipboard.writeText(md);
    el.exportStatus.textContent = "コピーしました。Notionに貼り付けてください。";
  } catch (e) {
    el.exportStatus.textContent = "コピーに失敗しました。「ダウンロード」をお試しください。";
  }
});

el.btnDownloadMd.addEventListener("click", () => {
  const md = buildMarkdown();
  const base = stripExtension(state.loadedFileName || "ccfolia-log");
  downloadTextFile(`${base}.md`, md, "text/markdown");
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

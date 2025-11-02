// 共用 Firebase（→ ./lib/）
import { getFirebase } from "./lib/firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, onSnapshot,
  collection, getDocs, query, where, orderBy, documentId
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

const { auth, db } = getFirebase();
const $ = (id) => document.getElementById(id);

// 先走 Hosting rewrite (/api/usage)，失敗就直連 Cloud Run
const USAGE_API_BASES = [
  "/api/usage",
  "https://eatnow-usage-api-18967449501.asia-east1.run.app"
];

const cfgRef = doc(db, "settings", "maps");
const todayId = (tz = "Asia/Taipei") =>
  new Date().toLocaleString("sv-SE", { timeZone: tz }).slice(0, 10).replaceAll("-", "");
const usageRef = () => doc(db, "usage_maps_daily", todayId());

const ui = {
  who: $("who"), uid: $("uid"), guard: $("guard"), form: $("form"),
  badge: $("badge"), enabled: $("enabled"), mode: $("mode"),
  dailyBudgetUSD: $("dailyBudgetUSD"), warnAtPct: $("warnAtPct"),
  updatedAt: $("updatedAt"), btnReload: $("btnReload"), btnSave: $("btnSave"),
  btnDisable: $("btnDisable"),
  // replies
  cards: $("cards"), btnSaveReplies: $("btnSaveReplies"), statusReplies: $("statusReplies"),
  // usage from API
  uMsgTotal: $("uMsgTotal"), uMsgText: $("uMsgText"), uMsgBubble: $("uMsgBubble"), uMsgCarousel: $("uMsgCarousel"),
  uPushTotal: $("uPushTotal"), uPushText: $("uPushText"), uPushImage: $("uPushImage"),
  uPushBubble: $("uPushBubble"), uPushCarousel: $("uPushCarousel"),
  usageApiDate: $("usageApiDate"),
  // Places
  placesToday: $("placesToday"), placesMonth: $("placesMonth"),
};

let unsubCfg = null;

const fmtTs = (ts) => !ts ? "—" : (isNaN(new Date(ts)) ? "—" : new Date(ts).toLocaleString());
const computePlaces = (usage) => {
  const uses = Number(usage?.messages_flex_carousel || 0);
  const bubbles = Number(usage?.messages_flex_bubble || 0);
  // 每次使用 1 次 + 每張卡片 2 次（圖片 + 位置連結）
  return (uses * 1) + (bubbles * 2);
};

// ── 設定：即時綁定 ───────────────────────────────────────────
function bindLiveConfig() {
  ui.badge.textContent = "同步中…";
  unsubCfg?.();
  unsubCfg = onSnapshot(cfgRef, s => {
    if (!s.exists()) { ui.badge.textContent = "無設定（儲存時會自動建立）"; return; }
    const c = s.data();
    ui.enabled.checked = !!c.enabled;
    ui.mode.value = c.mode || "link";
    ui.dailyBudgetUSD.value = (c.dailyBudgetUSD ?? 3);
    ui.warnAtPct.value = (c.warnAtPct ?? 0.8);
    ui.updatedAt.textContent = fmtTs(c.updatedAt);
    ui.badge.textContent = c.enabled ? "啟用中" : "已關閉";
  }, err => {
    console.error(err);
    ui.badge.textContent = "同步失敗";
    alert("讀取設定失敗：" + (err.message || err));
  });
}

// ── 從 C# 讀取「今日」訊息用量 ──────────────────────────────
async function fetchTodayUsageApi() {
  for (const base of USAGE_API_BASES) {
    try {
      const r = await fetch(`${base}/stats/today`, { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch (_) { /* 換下一個 base 試 */ }
  }
  console.warn("fetchTodayUsageApi: all bases failed");
  return null;
}

function renderUsageApi(u) {
  if (!u) return;
  ui.usageApiDate && (ui.usageApiDate.textContent = `來源：/api/usage/stats/today（dateId=${u.dateId || u.date_id || "—"}）`);

  // reply
  ui.uMsgTotal && (ui.uMsgTotal.textContent = u.messages_total ?? 0);
  ui.uMsgText && (ui.uMsgText.textContent = u.messages_text ?? 0);
  ui.uMsgBubble && (ui.uMsgBubble.textContent = u.messages_flex_bubble ?? 0);
  ui.uMsgCarousel && (ui.uMsgCarousel.textContent = u.messages_flex_carousel ?? 0);

  // push
  ui.uPushTotal && (ui.uPushTotal.textContent = u.push_total ?? 0);
  ui.uPushText && (ui.uPushText.textContent = u.push_text ?? 0);
  ui.uPushImage && (ui.uPushImage.textContent = u.push_image ?? 0);
  ui.uPushBubble && (ui.uPushBubble.textContent = u.push_flex_bubble ?? 0);
  ui.uPushCarousel && (ui.uPushCarousel.textContent = u.push_flex_carousel ?? 0);

  // Places 今日
  ui.placesToday && (ui.placesToday.textContent = computePlaces(u));
}

// ── 若 C# API 掛了，今日用量用 Firestore 文件補 ───────────────
async function renderTodayPlacesFromFirestoreIfMissing() {
  if (Number(ui.placesToday?.textContent || 0) > 0) return; // 已有 API 值就不補
  try {
    const s = await getDoc(usageRef());
    if (!s.exists()) return;
    const d = s.data()?.counters || {};
    const u = {
      messages_flex_bubble: d.messages_flex_bubble || 0,
      messages_flex_carousel: d.messages_flex_carousel || 0
    };
    ui.placesToday && (ui.placesToday.textContent = computePlaces(u));
  } catch (e) {
    console.error("today fallback failed:", e);
  }
}

// ── 本月 Places 累計（從 usage_maps_daily 彙總） ──────────────
function monthRangeIds(tz = "Asia/Taipei") {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const y = now.getFullYear(), m = now.getMonth(); // 0-based
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0)); // 該月最後一天（UTC 算）
  const toId = (d) => new Date(d).toISOString().slice(0, 10).replaceAll("-", "");
  // 用 YYYYMMDD（字串）做 docId 範圍
  return [toId(start), toId(end)];
}

async function loadPlacesThisMonth() {
  try {
    const [startId, endId] = monthRangeIds();
    const q = query(
      collection(db, "usage_maps_daily"),
      where(documentId(), ">=", startId),
      where(documentId(), "<=", endId),
      orderBy(documentId(), "asc")
    );
    const snap = await getDocs(q);
    let uses = 0, bubbles = 0;
    snap.forEach(d => {
      const c = d.data()?.counters || {};
      uses += Number(c.messages_flex_carousel || 0);
      bubbles += Number(c.messages_flex_bubble || 0);
    });
    ui.placesMonth && (ui.placesMonth.textContent = (uses * 1 + bubbles * 2));
  } catch (e) {
    console.error("loadPlacesThisMonth failed:", e);
  }
}

// ── Replies 設定（張數） ─────────────────────────────────────
function setStatusReplies(msg, ok = true) {
  ui.statusReplies.textContent = msg || "";
  ui.statusReplies.style.color = ok ? "#065f46" : "#991b1b";
}

async function loadReplies() {
  try {
    const s = await getDoc(doc(db, "settings", "replies"));
    const n = (s.exists() && Number(s.data().cardsPerReply)) || 5;
    ui.cards.value = Math.max(3, Math.min(9, Math.round(n)));
    setStatusReplies("已載入目前張數設定。", true);
  } catch (e) { console.error(e); setStatusReplies(`讀取失敗：${e?.code || e?.message}`, false); }
}

async function saveReplies() {
  const v = Number(ui.cards.value);
  if (!Number.isFinite(v) || v < 3 || v > 9) return setStatusReplies("請輸入 3–9 的整數。", false);
  try {
    await setDoc(doc(db, "settings", "replies"), { cardsPerReply: Math.round(v), updatedAt: Date.now() }, { merge: true });
    setStatusReplies(`已儲存：每次回傳 ${Math.round(v)} 張。`, true);
  } catch (e) { console.error(e); setStatusReplies(`儲存失敗：${e?.code || e?.message}`, false); }
}

// ── Maps 設定存檔/關閉 ──────────────────────────────────────
async function save() {
  const mode = ui.mode.value, daily = Number(ui.dailyBudgetUSD.value), warn = Number(ui.warnAtPct.value);
  if (!["link", "static", "embed", "js"].includes(mode)) return alert("mode 僅能為 link/static/embed/js");
  if (!(daily >= 0)) return alert("每日預算需為非負數");
  if (!(warn >= 0 && warn <= 1)) return alert("預警門檻需在 0~1");
  try {
    await setDoc(cfgRef, { enabled: ui.enabled.checked, mode: mode, dailyBudgetUSD: daily, warnAtPct: warn, updatedAt: Date.now() }, { merge: true });
    alert("已儲存");
  } catch (e) { console.error(e); alert(`儲存失敗：${e?.code || e?.message || e}`); }
}

async function kill() {
  try { await setDoc(cfgRef, { enabled: false, updatedAt: Date.now() }, { merge: true }); alert("已關閉 Maps 功能"); }
  catch (e) { console.error(e); alert(`關閉失敗：${e?.code || e?.message || e}`); }
}

// ── UI 綁定與初始化 ────────────────────────────────────────
ui.btnReload?.addEventListener("click", async () => {
  const s = await getDoc(cfgRef);
  if (!s.exists()) { ui.badge.textContent = "無設定"; return; }
  const c = s.data();
  ui.enabled.checked = !!c.enabled;
  ui.mode.value = c.mode || "link";
  ui.dailyBudgetUSD.value = (c.dailyBudgetUSD ?? 3);
  ui.warnAtPct.value = (c.warnAtPct ?? 0.8);
  ui.updatedAt.textContent = fmtTs(c.updatedAt);
  ui.badge.textContent = c.enabled ? "啟用中" : "已關閉";
});
ui.btnSave?.addEventListener("click", save);
ui.btnSaveReplies?.addEventListener("click", saveReplies);
ui.btnDisable?.addEventListener("click", kill);

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    ui.who.textContent = "未登入";
    ui.guard.textContent = "你尚未登入，請先回首頁登入。";
    ui.form.classList.add("hidden");
    return;
  }
  ui.who.textContent = user.email || user.uid;
  ui.uid.textContent = user.uid;

  try {
    const adm = await getDoc(doc(db, "admins", user.uid));
    if (!adm.exists()) {
      ui.guard.textContent = "已登入，但尚未加入管理員白名單（admins/{uid}）。";
      ui.form.classList.add("hidden");
      return;
    }
    ui.guard.textContent = "已驗證管理員，可以調整設定。";
    ui.form.classList.remove("hidden");

    bindLiveConfig();
    await loadReplies();

    // 1) 今日（C# API）
    const todayUsage = await fetchTodayUsageApi();
    renderUsageApi(todayUsage);
    // 若 API 失敗，用 Firestore 今日文件補 Places Today
    await renderTodayPlacesFromFirestoreIfMissing();

    // 2) 本月 Places
    await loadPlacesThisMonth();

  } catch (e) {
    console.error(e);
    ui.guard.textContent = "讀取權限時發生錯誤。";
    ui.form.classList.add("hidden");
  }
});

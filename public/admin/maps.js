// Firebase v11 ESM
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

// === 你的 Firebase 設定 ===
const firebaseConfig = {
  apiKey: "AIzaSyBx4_b4COBZalx6QIW9SeYbquCeLndhSG8",
  authDomain: "what-to-eat-now-64db0.firebaseapp.com",
  projectId: "what-to-eat-now-64db0",
  storageBucket: "what-to-eat-now-64db0.firebasestorage.app",
  messagingSenderId: "18967449501",
  appId: "1:18967449501:web:970dd193560edfff4b2974",
  measurementId: "G-XTYDV4WS4S"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

const $ = (id) => document.getElementById(id);

// settings/maps 參考
const cfgRef = doc(db, "settings", "maps");

// 今日用量 doc 參考（usage_maps_daily/{YYYYMMDD}）
function todayId(tz = "Asia/Taipei") {
  const d = new Date();
  const y = d.toLocaleString("sv-SE", { timeZone: tz }).slice(0,10).replaceAll("-","");
  return y; // e.g., 20250224
}
const usageRef = () => doc(db, "usage_maps_daily", todayId());

const ui = {
  who: $("who"),
  guard: $("guard"),
  form: $("form"),
  badge: $("badge"),
  enabled: $("enabled"),
  mode: $("mode"),
  dailyBudgetUSD: $("dailyBudgetUSD"),
  warnAtPct: $("warnAtPct"),
  updatedAt: $("updatedAt"),
  btnReload: $("btnReload"),
  btnSave: $("btnSave"),
  btnDisable: $("btnDisable"),
  // usage
  usageDate: $("usageDate"),
  uStatic: $("uStatic"),
  uEmbed: $("uEmbed"),
  uJs: $("uJs"),
  uTotal: $("uTotal"),
    // replies
  cards: $("cards"),
  btnSaveReplies: $("btnSaveReplies"),
  statusReplies: $("statusReplies"),
  uid: $("uid"),
};

let unsubCfg = null;
let unsubUsage = null;

function fmtTs(ts){
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d) ? "—" : d.toLocaleString();
}

function bindLiveConfig() {
  ui.badge.textContent = "同步中…";
  unsubCfg?.();
  unsubCfg = onSnapshot(cfgRef, (snap) => {
    if (!snap.exists()) {
      ui.badge.textContent = "無設定（儲存時會自動建立）";
      return;
    }
    const cfg = snap.data();
    ui.enabled.checked = !!cfg.enabled;
    ui.mode.value = cfg.mode || "link";
    ui.dailyBudgetUSD.value = (cfg.dailyBudgetUSD ?? 3);
    ui.warnAtPct.value = (cfg.warnAtPct ?? 0.8);
    ui.updatedAt.textContent = fmtTs(cfg.updatedAt);
    ui.badge.textContent = cfg.enabled ? "啟用中" : "已關閉";
  }, (err) => {
    console.error(err);
    ui.badge.textContent = "同步失敗";
    alert("讀取設定失敗：" + (err.message || err));
  });
}

function bindLiveUsage() {
  unsubUsage?.();
  ui.usageDate.textContent = `文件：usage_maps_daily/${todayId()}`;
  unsubUsage = onSnapshot(usageRef(), (snap) => {
    const d = snap.exists() ? snap.data() : {};
    const s = d.requests_static || 0;
    const e = d.requests_embed  || 0;
    const j = d.requests_js     || 0;
    const total = s + e + j;
    ui.uStatic.textContent = s;
    ui.uEmbed.textContent  = e;
    ui.uJs.textContent     = j;
    ui.uTotal.textContent  = total;
  }, (err) => {
    console.error(err);
  });
}

function setStatusReplies(msg, ok=true){
  ui.statusReplies.textContent = msg || "";
  ui.statusReplies.style.color = ok ? "#065f46" : "#991b1b";
}

// 讀 settings/replies.cardsPerReply（沒有就預設 5）
async function loadReplies(){
  try{
    const snap = await getDoc(doc(db, "settings", "replies"));
    const n = (snap.exists() && Number(snap.data().cardsPerReply)) || 5;
    ui.cards.value = Math.max(3, Math.min(9, Math.round(n)));
    setStatusReplies("已載入目前張數設定。", true);
  }catch(e){
    console.error(e);
    setStatusReplies(`讀取失敗：${e && (e.code || e.message)}`, false);
  }
}

// 寫入 settings/replies.cardsPerReply（限 admin）
async function saveReplies(){
  const val = Number(ui.cards.value);
  if (!Number.isFinite(val) || val < 3 || val > 9){
    return setStatusReplies("請輸入 3–9 的整數。", false);
  }
  try{
    await setDoc(doc(db, "settings", "replies"), {
      cardsPerReply: Math.round(val),
      updatedAt: Date.now(),
    }, { merge: true });
    setStatusReplies(`已儲存：每次回傳 ${Math.round(val)} 張。`, true);
    } catch (e) {
      console.error(e);
      setStatusReplies(`儲存失敗：${(e && (e.code || e.message)) || e}`, false);
    }
}

async function save() {
  const mode = ui.mode.value;
  const dailyBudgetUSD = Number(ui.dailyBudgetUSD.value);
  const warnAtPct = Number(ui.warnAtPct.value);
  if (!["link","static","embed","js"].includes(mode)) return alert("mode 僅能為 link/static/embed/js");
  if (!(dailyBudgetUSD >= 0)) return alert("每日預算需為非負數");
  if (!(warnAtPct >= 0 && warnAtPct <= 1)) return alert("預警門檻需在 0~1");

  try {
    await setDoc(cfgRef, {
      enabled: ui.enabled.checked,
      mode, dailyBudgetUSD, warnAtPct,
      updatedAt: Date.now(),
    }, { merge: true });
    alert("已儲存");
  } catch (e) {
    console.error(e);
    alert(`儲存失敗：${(e && (e.code || e.message)) || e}`);
  }
}

async function kill() {
  try {
    await setDoc(cfgRef, { enabled: false, updatedAt: Date.now() }, { merge: true });
    alert("已關閉 Maps 功能");
  } catch (e) {
    console.error(e);
    alert(`關閉失敗：${(e && (e.code || e.message)) || e}`);
  }
}

ui.btnReload.onclick = async () => {
  const snap = await getDoc(cfgRef);
  if (!snap.exists()) { ui.badge.textContent = "無設定"; return; }
  const cfg = snap.data();
  ui.enabled.checked = !!cfg.enabled;
  ui.mode.value = cfg.mode || "link";
  ui.dailyBudgetUSD.value = (cfg.dailyBudgetUSD ?? 3);
  ui.warnAtPct.value = (cfg.warnAtPct ?? 0.8);
  ui.updatedAt.textContent = fmtTs(cfg.updatedAt);
  ui.badge.textContent = cfg.enabled ? "啟用中" : "已關閉";
};
ui.btnSave.onclick = save;
ui.btnSaveReplies.onclick = saveReplies;
ui.btnDisable.onclick = kill;

// 🔒 權限守門：查 Firestore admins 白名單
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
    const adminDoc = await getDoc(doc(db, "admins", user.uid));
    const ok = adminDoc.exists();
    if (!ok) {
      ui.guard.textContent = "已登入，但尚未加入管理員白名單（admins/{uid}）。";
      ui.form.classList.add("hidden");
      return;
    }
    ui.guard.textContent = "已驗證管理員，可以調整設定。";
    ui.form.classList.remove("hidden");
    bindLiveConfig();
    bindLiveUsage();
    await loadReplies();
  } catch (e) {
    console.error(e);
    ui.guard.textContent = "讀取權限時發生錯誤。";
    ui.form.classList.add("hidden");
  }
});

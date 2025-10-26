// 共用 Firebase（→ ./lib/）
import { getFirebase } from "./lib/firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { doc, getDoc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

const { auth, db } = getFirebase();
const $ = (id) => document.getElementById(id);

const cfgRef = doc(db, "settings", "maps");
const todayId = (tz="Asia/Taipei") =>
  new Date().toLocaleString("sv-SE",{ timeZone: tz }).slice(0,10).replaceAll("-","");
const usageRef = () => doc(db, "usage_maps_daily", todayId());

const ui = {
  who:$("who"), uid:$("uid"), guard:$("guard"), form:$("form"),
  badge:$("badge"), enabled:$("enabled"), mode:$("mode"),
  dailyBudgetUSD:$("dailyBudgetUSD"), warnAtPct:$("warnAtPct"),
  updatedAt:$("updatedAt"), btnReload:$("btnReload"), btnSave:$("btnSave"),
  btnDisable:$("btnDisable"), usageDate:$("usageDate"),
  uStatic:$("uStatic"), uEmbed:$("uEmbed"), uJs:$("uJs"), uTotal:$("uTotal"),
  cards:$("cards"), btnSaveReplies:$("btnSaveReplies"), statusReplies:$("statusReplies"),
};

let unsubCfg=null, unsubUsage=null;
const fmtTs=(ts)=>!ts?"—":(isNaN(new Date(ts))?"—":new Date(ts).toLocaleString());

function bindLiveConfig(){
  ui.badge.textContent="同步中…";
  unsubCfg?.();
  unsubCfg = onSnapshot(cfgRef, s=>{
    if(!s.exists()){ ui.badge.textContent="無設定（儲存時會自動建立）"; return; }
    const c=s.data();
    ui.enabled.checked=!!c.enabled;
    ui.mode.value=c.mode||"link";
    ui.dailyBudgetUSD.value=(c.dailyBudgetUSD??3);
    ui.warnAtPct.value=(c.warnAtPct??0.8);
    ui.updatedAt.textContent=fmtTs(c.updatedAt);
    ui.badge.textContent=c.enabled?"啟用中":"已關閉";
  }, err=>{
    console.error(err);
    ui.badge.textContent="同步失敗";
    alert("讀取設定失敗："+(err.message||err));
  });
}

function bindLiveUsage(){
  unsubUsage?.();
  ui.usageDate.textContent=`文件：usage_maps_daily/${todayId()}`;
  unsubUsage = onSnapshot(usageRef(), s=>{
    const d=s.exists()?s.data():{};
    const a=d.requests_static||0, b=d.requests_embed||0, c=d.requests_js||0;
    ui.uStatic.textContent=a; ui.uEmbed.textContent=b; ui.uJs.textContent=c; ui.uTotal.textContent=a+b+c;
  }, err=>console.error(err));
}

function setStatusReplies(msg, ok=true){
  ui.statusReplies.textContent=msg||"";
  ui.statusReplies.style.color=ok?"#065f46":"#991b1b";
}

async function loadReplies(){
  try{
    const s=await getDoc(doc(db,"settings","replies"));
    const n=(s.exists()&&Number(s.data().cardsPerReply))||5;
    ui.cards.value=Math.max(3,Math.min(9,Math.round(n)));
    setStatusReplies("已載入目前張數設定。",true);
  }catch(e){ console.error(e); setStatusReplies(`讀取失敗：${e?.code||e?.message}`,false); }
}

async function saveReplies(){
  const v=Number(ui.cards.value);
  if(!Number.isFinite(v)||v<3||v>9) return setStatusReplies("請輸入 3–9 的整數。",false);
  try{
    await setDoc(doc(db,"settings","replies"),{cardsPerReply:Math.round(v),updatedAt:Date.now()},{merge:true});
    setStatusReplies(`已儲存：每次回傳 ${Math.round(v)} 張。`,true);
  }catch(e){ console.error(e); setStatusReplies(`儲存失敗：${e?.code||e?.message}`,false); }
}

async function save(){
  const mode=ui.mode.value, daily=Number(ui.dailyBudgetUSD.value), warn=Number(ui.warnAtPct.value);
  if(!["link","static","embed","js"].includes(mode)) return alert("mode 僅能為 link/static/embed/js");
  if(!(daily>=0)) return alert("每日預算需為非負數");
  if(!(warn>=0&&warn<=1)) return alert("預警門檻需在 0~1");
  try{
    await setDoc(cfgRef,{enabled:ui.enabled.checked,mode:mode,dailyBudgetUSD:daily,warnAtPct:warn,updatedAt:Date.now()},{merge:true});
    alert("已儲存");
  }catch(e){ console.error(e); alert(`儲存失敗：${e?.code||e?.message||e}`); }
}

async function kill(){
  try{ await setDoc(cfgRef,{enabled:false,updatedAt:Date.now()},{merge:true}); alert("已關閉 Maps 功能"); }
  catch(e){ console.error(e); alert(`關閉失敗：${e?.code||e?.message||e}`); }
}

ui.btnReload?.addEventListener("click", async ()=>{
  const s=await getDoc(cfgRef);
  if(!s.exists()){ ui.badge.textContent="無設定"; return; }
  const c=s.data();
  ui.enabled.checked=!!c.enabled;
  ui.mode.value=c.mode||"link";
  ui.dailyBudgetUSD.value=(c.dailyBudgetUSD??3);
  ui.warnAtPct.value=(c.warnAtPct??0.8);
  ui.updatedAt.textContent=fmtTs(c.updatedAt);
  ui.badge.textContent=c.enabled?"啟用中":"已關閉";
});
ui.btnSave?.addEventListener("click", save);
ui.btnSaveReplies?.addEventListener("click", saveReplies);
ui.btnDisable?.addEventListener("click", kill);

onAuthStateChanged(auth, async (user)=>{
  if(!user){
    ui.who.textContent="未登入";
    ui.guard.textContent="你尚未登入，請先回首頁登入。";
    ui.form.classList.add("hidden");
    return;
  }
  ui.who.textContent=user.email||user.uid;
  ui.uid.textContent=user.uid;

  try{
    const adm=await getDoc(doc(db,"admins",user.uid));
    if(!adm.exists()){
      ui.guard.textContent="已登入，但尚未加入管理員白名單（admins/{uid}）。";
      ui.form.classList.add("hidden");
      return;
    }
    ui.guard.textContent="已驗證管理員，可以調整設定。";
    ui.form.classList.remove("hidden");
    bindLiveConfig(); bindLiveUsage(); await loadReplies();
  }catch(e){
    console.error(e);
    ui.guard.textContent="讀取權限時發生錯誤。";
    ui.form.classList.add("hidden");
  }
});

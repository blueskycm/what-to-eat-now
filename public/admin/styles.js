import { getFirebase } from "./lib/firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { doc, getDoc, setDoc, collection, query, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
// import { getStorage, ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-storage.js";
import { getStorage, ref, uploadBytesResumable, getDownloadURL, getMetadata } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-storage.js";

const { app, auth, db } = getFirebase();
const storage = getStorage(app, "gs://what-to-eat-now-64db0.firebasestorage.app");
const $ = (id)=>document.getElementById(id);

const ui = {
  who:$("who"), uid:$("uid"), guard:$("guard"), form:$("form"),
  thBtnColor:$("thBtnColor"), thBtnColorHex:$("thBtnColorHex"),
  thBtnMargin:$("thBtnMargin"), thHeroMode:$("thHeroMode"),
  thHeroRatio:$("thHeroRatio"), thSave:$("thSave"), thReset:$("thReset"), thMsg:$("thMsg"),
  pvHero:$("pvHero"), pvHeroSizer:$("pvHeroSizer"), pvImg:$("pvImg"),
  pvTitle:$("pvTitle"), pvSub:$("pvSub"), pvBody:$("pvBody"),
  pvInfo:$("pvInfo"),
  pvFooter:$("pvFooter"), pvBtn1:$("pvBtn1"), pvBtn2:$("pvBtn2"),
  fallbackFile:$("fallbackFile"), btnUpload:$("btnUpload"),
  upBar:$("upBar"), upMsg:$("upMsg"), fallbackThumb:$("fallbackThumb"),
  btnKind:()=>document.querySelector('input[name="thBtnKind"]:checked')?.value || "secondary",
};

const theme = {
  btnKind:"secondary", btnColor:"#E5E7EB", btnMargin:"sm",
  heroMode:"cover", heroRatio:"3:4",
  fallbackImageUrl:""
};
const ratioMap = {"16:9":56.25,"20:13":65,"1:1":100,"3:4":133.33};
const gapMap   = { none:"0px", sm:"8px", md:"12px", lg:"16px" };

// 讓覆蓋同名圖也能強制換版：用 generation 當 cache-buster
async function getVersionedDownloadURL(storageRef) {
  const [url, meta] = await Promise.all([getDownloadURL(storageRef), getMetadata(storageRef)]);
  const ver = meta.generation || Date.now();
  return `${url}${url.includes("?") ? "&" : "?"}v=${ver}`;
}

// 若設定裡沒有 fallbackImageUrl，從 Storage 取一次並回寫 Firestore
async function ensureFallbackImageUrl() {
  try {
    const sref = ref(storage, "theme/fallback.jpg");
    const url = await getVersionedDownloadURL(sref);
    theme.fallbackImageUrl = url;
    await setDoc(doc(db, "settings", "theme"), {
      fallbackImageUrl: url,
      updatedAt: Date.now()
    }, { merge: true });
    return url;
  } catch (e) {
    console.warn("沒有 theme/fallback.jpg 或不可讀，略過。", e?.code || e);
    return "";
  }
}

function applyPreview(){
  // 圖片比例高度（用 padding-top）
  const padPct = (ratioMap[theme.heroRatio] || 56.25);
  ui.pvHeroSizer.style.paddingTop = padPct + "%";

  // 圖片裁切/顯示模式
  ui.pvImg.style.objectFit = theme.heroMode === "fit" ? "contain" : "cover";

  // 來源圖（先用題目圖；沒有就用 fallback）
  const url = theme.fallbackImageUrl || ui.pvHero.dataset.qimg || "";
  if (url){
    ui.pvImg.src = url;
    ui.fallbackThumb.style.backgroundImage = `url("${url}")`;
  }else{
    ui.pvImg.removeAttribute("src");
    ui.fallbackThumb.style.backgroundImage = "none";
  }

  // === 兩顆按鈕同樣式 ===
  const btns = [ui.pvBtn1, ui.pvBtn2];
  // 1) 切換 primary/secondary 字色（primary=白字、secondary=黑字）
  for (const b of btns){
    b.classList.toggle("primary", theme.btnKind === "primary");
    b.classList.toggle("secondary", theme.btnKind !== "primary");
    // 2) 底色統一使用你選的色（覆蓋 class 預設）
    b.style.backgroundColor = theme.btnColor;
    // 3) 邊框色：primary 用同色、secondary 用淺灰
    b.style.borderColor = (theme.btnKind === "primary") ? theme.btnColor : "#d1d5db";
  }
  // 4) 兩顆之間的間距（footer 的 gap）
  const gapClass = { none:"pv-gap-none", sm:"pv-gap-sm", md:"pv-gap-md", lg:"pv-gap-lg" }[theme.btnMargin] || "pv-gap-sm";
  ui.pvFooter.classList.remove("pv-gap-none","pv-gap-sm","pv-gap-md","pv-gap-lg");
  ui.pvFooter.classList.add(gapClass);

  // 右側資訊摘要
  ui.pvInfo.innerHTML = [
    `• button.style : ${theme.btnKind}`,
    `• button.color : ${theme.btnColor}`,
    `• button.margin : ${theme.btnMargin}`,
    `• hero.aspectMode : ${theme.heroMode}`,
    `• hero.aspectRatio : ${theme.heroRatio}`
  ].join("<br>");
}

function renderPreviewQuestion(q){
  ui.pvTitle.textContent = q?.title || "店名（範例）";
  ui.pvSub.textContent   = q?.body  || "地址 · 0.8 km";
  ui.pvHero.dataset.qimg = q?.questionImageUrl || "";
  applyPreview();
}

async function loadPreviewQuestion(){
  const qref = query(collection(db, "qbank"), orderBy("qid", "desc"), limit(1));
  const docs = await new Promise((resolve, reject)=>{
    const unsub = onSnapshot(
      qref,
      s => { unsub(); resolve(s.docs); },
      e => { unsub(); reject(e); }
    );
  });
  renderPreviewQuestion(docs.length ? docs[0].data() : null);
}

function bindForm(){
  ui.thBtnColor.addEventListener("input", e=>{
    theme.btnColor = String(e.target.value || "#E5E7EB").toUpperCase();
    ui.thBtnColorHex.value = theme.btnColor; applyPreview();
  });
  ui.thBtnColorHex.addEventListener("input", e=>{
    let v = (e.target.value || "").trim(); if (!v.startsWith("#")) v = "#" + v;
    if (/^#([0-9a-f]{6})$/i.test(v)){ theme.btnColor = v.toUpperCase(); ui.thBtnColor.value = theme.btnColor; applyPreview(); }
  });
  document.querySelectorAll('input[name="thBtnKind"]').forEach(r => r.addEventListener("change", e=>{
    if (e.target.checked){ theme.btnKind = e.target.value; applyPreview(); }
  }));
  ui.thBtnMargin.addEventListener("change", e=>{ theme.btnMargin = e.target.value; applyPreview(); });
  ui.thHeroMode.addEventListener("change", e=>{ theme.heroMode  = e.target.value; applyPreview(); });
  ui.thHeroRatio.addEventListener("change", e=>{ theme.heroRatio = e.target.value; applyPreview(); });

  ui.fallbackFile.addEventListener("change", ()=>{
    const f = ui.fallbackFile.files?.[0];
    if (!f){ ui.upMsg.textContent = "尚未選擇檔案"; ui.fallbackThumb.style.backgroundImage = "none"; return; }
    ui.upMsg.textContent = `${f.name}（${Math.round(f.size/1024)} KB）`;
    ui.fallbackThumb.style.backgroundImage = `url("${URL.createObjectURL(f)}")`;
  });

  ui.btnUpload.addEventListener("click", ()=>{
    const file = ui.fallbackFile.files?.[0];
    if (!file){ ui.upMsg.textContent = "請先選擇圖片檔"; return; }
    if (!file.type.startsWith("image/")){ ui.upMsg.textContent = "檔案必須是圖片"; return; }
    const storageRef = ref(storage, "theme/fallback.jpg");    // ← 全站共用
    const task = uploadBytesResumable(storageRef, file, { contentType: file.type });

    ui.btnUpload.disabled = true;
    ui.btnUpload.textContent = "上傳中…";
    ui.upMsg.textContent = "上傳中…"; ui.upBar.style.width = "0%";

    task.on("state_changed", (snap)=>{
      ui.upBar.style.width = Math.round(snap.bytesTransferred / snap.totalBytes * 100) + "%";
    }, (err)=>{
      console.error(err);
      console.error("Storage Upload Error:", err);
      ui.upMsg.textContent = `上傳失敗 (${err.code}): ${err.message}`;
      ui.btnUpload.disabled = false; ui.btnUpload.textContent = "上傳"; ui.upBar.style.width = "0%";
    }, async ()=>{
        const url = await getVersionedDownloadURL(storageRef);
        theme.fallbackImageUrl = url;
        ui.upMsg.textContent = "上傳完成 ✔ 已套用預覽";
        ui.btnUpload.disabled = false; ui.btnUpload.textContent = "上傳";
        applyPreview();
        try{
            await setDoc(doc(db, "settings", "theme"), {
            fallbackImageUrl: url,
            updatedAt: Date.now()
            }, { merge: true });
            ui.thMsg.textContent = "預設圖片已儲存 ✔";
            setTimeout(()=> ui.thMsg.textContent="", 1500);
        }catch(e){
            console.error(e);
            ui.thMsg.textContent = "寫入預設圖片失敗：" + (e?.message || String(e));
        }
        });
  });

  ui.thReset.addEventListener("click", ()=>{
    theme.btnKind="secondary"; theme.btnColor="#E5E7EB"; theme.btnMargin="sm";
    theme.heroMode="cover"; theme.heroRatio="3:4"; theme.fallbackImageUrl="";
    ui.thBtnColor.value=theme.btnColor; ui.thBtnColorHex.value=theme.btnColor;
    document.querySelector('input[name="thBtnKind"][value="secondary"]').checked = true;
    ui.thBtnMargin.value=theme.btnMargin; ui.thHeroMode.value=theme.heroMode; ui.thHeroRatio.value=theme.heroRatio;
    ui.upBar.style.width="0%"; ui.upMsg.textContent="已重設"; ui.fallbackThumb.style.backgroundImage="none";
    applyPreview();
  });

  ui.thSave.addEventListener("click", async ()=>{
    try{
      ui.thMsg.textContent = "儲存中…";
      await setDoc(doc(db, "settings", "theme"), {
        btnKind: theme.btnKind, btnColor: theme.btnColor, btnMargin: theme.btnMargin,
        heroMode: theme.heroMode, heroRatio: theme.heroRatio,
        fallbackImageUrl: theme.fallbackImageUrl || null,
        updatedAt: Date.now()
      }, { merge: true });
      ui.thMsg.textContent = "已儲存 ✔";
      setTimeout(()=> ui.thMsg.textContent="", 1500);
    }catch(err){
      console.error(err);
      ui.thMsg.textContent = "儲存失敗：" + (err?.message || String(err));
    }
  });
}

async function loadTheme(){
  try{
    const s = await getDoc(doc(db, "settings", "theme"));
    if (s.exists()){
      const d = s.data() || {};
      theme.btnKind  = d.btnKind  || theme.btnKind;
      theme.btnColor = String(d.btnColor || theme.btnColor).toUpperCase();
      theme.btnMargin= d.btnMargin|| theme.btnMargin;
      theme.heroMode = d.heroMode || theme.heroMode;
      theme.heroRatio= d.heroRatio|| theme.heroRatio;
      theme.fallbackImageUrl = d.fallbackImageUrl || "";
      if (!theme.fallbackImageUrl) {
        await ensureFallbackImageUrl(); // 從 Storage 補一次並回寫
      }
      ui.thBtnColor.value = theme.btnColor; ui.thBtnColorHex.value = theme.btnColor;
      document.querySelector(`input[name="thBtnKind"][value="${theme.btnKind}"]`).checked = true;
      ui.thBtnMargin.value = theme.btnMargin; ui.thHeroMode.value = theme.heroMode; ui.thHeroRatio.value = theme.heroRatio;
      if (theme.fallbackImageUrl) ui.fallbackThumb.style.backgroundImage = `url("${theme.fallbackImageUrl}")`;
    }
  }catch(err){
    console.error(err);
    ui.thMsg.textContent = "載入樣式失敗：" + (err?.message || String(err));
  }finally{
    applyPreview();
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user){
    ui.who.textContent = "未登入";
    ui.guard.textContent = "你尚未登入，請先回首頁登入。";
    ui.form.classList.add("hidden");
    return;
  }
  ui.who.textContent = user.email || user.uid;
  ui.uid.textContent = user.uid;

  // 1) 驗證白名單
  try {
    const adminDoc = await getDoc(doc(db, "admins", user.uid));
    if (!adminDoc.exists()){
      ui.guard.textContent = "已登入，但尚未加入管理員白名單（admins/{uid}）。";
      ui.form.classList.add("hidden");
      return;
    }
  } catch (err) {
    console.error("讀取 admins/{uid} 失敗：", err);
    ui.guard.textContent = "讀取管理員白名單失敗（請檢查 Firestore 規則與專案）。";
    ui.form.classList.add("hidden");
    return;
  }

  ui.guard.textContent = "已驗證管理員，可以調整樣式。";
  ui.form.classList.remove("hidden");
  bindForm();

  // 2) settings/theme（失敗不影響整體）
  await loadTheme().catch(err=>{
    console.error("讀取 settings/theme 失敗：", err);
    ui.thMsg.textContent = "讀取樣式失敗（請檢查 settings/* 開放 read）。";
  });

  // 3) qbank（失敗就用空資料）
  await loadPreviewQuestion().catch(err=>{
    console.error("讀取 qbank 失敗：", err);
  });
});

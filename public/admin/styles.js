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
  pvHero:$("pvHero"), pvBody:$("pvBody"), pvTitle:$("pvTitle"), pvSub:$("pvSub"),
  pvKind:$("pvKind"), pvBtnColorVal:$("pvBtnColorVal"), pvBtnMarginVal:$("pvBtnMarginVal"),
  pvHeroModeVal:$("pvHeroModeVal"), pvHeroRatioVal:$("pvHeroRatioVal"),
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
  document.documentElement.style.setProperty("--pv-btn-bg", theme.btnColor);
  document.documentElement.style.setProperty("--pv-btn-fg", theme.btnKind==="primary" ? "#ffffff" : "#111827");
  document.documentElement.style.setProperty("--pv-btn-gap", gapMap[theme.btnMargin] || "8px");
  document.documentElement.style.setProperty("--pv-hero-ratio", (ratioMap[theme.heroRatio] || 56.25) + "%");
  const url = theme.fallbackImageUrl || ui.pvHero.dataset.qimg || "";
  if (url){
    ui.pvHero.style.backgroundImage = `url("${url}")`;
    ui.pvHero.style.backgroundSize = theme.heroMode === "cover" ? "cover" : "contain";
    ui.pvHero.style.backgroundRepeat = "no-repeat";
    ui.pvHero.style.backgroundPosition = "center";
    ui.pvHero.style.backgroundColor = "#000";
    ui.fallbackThumb.style.backgroundImage = `url("${url}")`;
  } else {
    ui.pvHero.removeAttribute("style");
    ui.pvHero.className = "pv-hero";
    ui.fallbackThumb.style.backgroundImage = "none";
  }
  ui.pvKind.textContent = theme.btnKind;
  ui.pvBtnColorVal.textContent = theme.btnColor;
  ui.pvBtnMarginVal.textContent = theme.btnMargin;
  ui.pvHeroModeVal.textContent = theme.heroMode;
  ui.pvHeroRatioVal.textContent = theme.heroRatio;
}

function renderPreviewQuestion(q){
  const title = q?.title || "我是誰？";
  const sub   = q?.body  || "題目預覽";
  const opts  = (q?.options || [{text:"選項 A"},{text:"選項 B"},{text:"選項 C"}]).slice(0,5);
  ui.pvTitle.textContent = title;
  ui.pvSub.textContent   = sub;
  Array.from(ui.pvBody.querySelectorAll(".pv-btn")).forEach(n => n.remove());
  for (const o of opts){
    const b = document.createElement("button");
    b.className = "pv-btn"; b.textContent = o.text || "選項";
    ui.pvBody.appendChild(b);
  }
  ui.pvHero.dataset.qimg = q?.questionImageUrl || "";
  applyPreview();
}

async function loadPreviewQuestion(){
  const qref = query(collection(db, "qbank"), orderBy("qid", "desc"), limit(1));
  const docs = await new Promise(resolve=>{
    const unsub = onSnapshot(qref, s=>{unsub(); resolve(s.docs);});
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

  try{
    const adminDoc = await getDoc(doc(db, "admins", user.uid));
    if (!adminDoc.exists()){
      ui.guard.textContent = "已登入，但尚未加入管理員白名單（admins/{uid}）。";
      ui.form.classList.add("hidden");
      return;
    }
    ui.guard.textContent = "已驗證管理員，可以調整樣式。";
    ui.form.classList.remove("hidden");
    bindForm();
    await loadTheme();
    await loadPreviewQuestion();
  }catch(err){
    console.error(err);
    ui.guard.textContent = "讀取權限時發生錯誤。";
    ui.form.classList.add("hidden");
  }
});

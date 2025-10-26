// admin.js —— 共用 firebase 初始化版本 (v11 ESM)
import { getFirebase } from "./lib/firebase.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

// 取用共用單例
const { app, auth, db } = getFirebase();

// Google 登入提供者
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const $ = id => document.getElementById(id);
const show = (el, yes) => el.classList.toggle("hidden", !yes);

// 登入/登出
$("btnLogin").onclick = async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    alert("登入失敗：" + (e.message || e));
  }
};
$("btnLogout").onclick = () => signOut(auth);

// 檢查是否在 admins 白名單
async function isAdmin(uid){
  try {
    if (!uid) return false;
    const snap = await getDoc(doc(db, "admins", uid));
    return snap.exists();
  } catch {
    return false;
  }
}

// 狀態監聽
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    $("who").textContent = "未登入";
    $("status").textContent = "請先登入";
    show($("btnLogin"), true);
    show($("btnLogout"), false);
    show($("btnGo"), false);
    return;
  }

  $("who").textContent = user.email || user.uid;
  $("status").textContent = "檢查管理員資格中…";
  show($("btnLogin"), false);
  show($("btnLogout"), true);

  const ok = await isAdmin(user.uid);
  if (ok) {
    $("status").textContent = "你是管理員，可以進入管理頁。";
    show($("btnGo"), true);
  } else {
    $("status").textContent = "已登入，但尚未加入管理員白名單（admins/{uid})。";
    show($("btnGo"), false);
  }
});

// Firebase v11 ESM 版
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

// 用你剛貼的 config
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
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const $ = id => document.getElementById(id);
const show = (el, yes) => el.classList.toggle("hidden", !yes);

$("btnLogin").onclick = async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    alert("登入失敗：" + (e.message || e));
  }
};
$("btnLogout").onclick = () => signOut(auth);

async function isAdmin(uid){
  try {
    if (!uid) return false;
    const snap = await getDoc(doc(db, "admins", uid));
    return snap.exists();
  } catch { return false; }
}

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

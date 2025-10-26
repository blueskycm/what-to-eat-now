// /admin/lib/firebase.js  —— 共用 Firebase 初始化（v11 ESM）

import { initializeApp, getApp, getApps } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

// ★ 這段不是機密，用在前端本來就會公開
export const firebaseConfig = {
  apiKey: "AIzaSyBx4_b4COBZalx6QIW9SeYbquCeLndhSG8",
  authDomain: "what-to-eat-now-64db0.firebaseapp.com",
  projectId: "what-to-eat-now-64db0",
  storageBucket: "what-to-eat-now-64db0.firebasestorage.app",
  messagingSenderId: "18967449501",
  appId: "1:18967449501:web:970dd193560edfff4b2974",
  measurementId: "G-XTYDV4WS4S"
};

// 單例：多頁/多模組重複 import 也只會初始化一次
export function getFirebase() {
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db   = getFirestore(app);
  return { app, auth, db };
}

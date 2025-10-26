// 共用 Navbar 元件（lib 目錄內）
import { getFirebase } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

export function mountNavbar(opts = {}) {
  const { auth } = getFirebase();
  const active = String(opts.active || "").toLowerCase();
  const root = document.getElementById("app-navbar");
  if (!root) return;

  const links = opts.links || [
    { href: "./index.html",  label: "首頁",       key: "home" },
    { href: "./maps.html",   label: "Google Maps", key: "maps" },
    { href: "./styles.html", label: "樣式",       key: "styles" },
  ];

  const cssLink = document.createElement("link");
  cssLink.rel = "stylesheet";
  cssLink.href = "./lib/navbar.css";  // ← lib 內的 CSS
  document.head.appendChild(cssLink);

  root.innerHTML = `
    <nav class="app-nav">
      <div class="wrap">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="brand">what-to-eat-now｜管理後台</span>
          ${links.map(l => `<a href="${l.href}" class="${l.key.toLowerCase()===active?"active":""}">${l.label}</a>`).join("")}
        </div>
        <div class="right">
          <span id="appNavWho" class="app-badge">檢查中…</span>
          <button id="appBtnLogout" class="app-btn">登出</button>
        </div>
      </div>
    </nav>
  `;

  document.getElementById("appBtnLogout")
    .addEventListener("click", ()=> signOut(auth));

  onAuthStateChanged(auth, user => {
    document.getElementById("appNavWho").textContent =
      user ? (user.email || user.uid) : "未登入";
  });
}

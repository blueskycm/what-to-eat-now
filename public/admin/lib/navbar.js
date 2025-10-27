// 共用 Navbar 元件（lib 目錄內）
import { getFirebase } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

export function mountNavbar(opts = {}) {
  const { auth } = getFirebase();
  const root = document.getElementById("app-navbar");
  if (!root) return;

  // 預設連結（含使用者清單）
  const links = opts.links || [
    { href: "./index.html",  label: "首頁",          key: "home"   },
    { href: "./maps.html",   label: "Google Maps",   key: "maps"   },
    { href: "./styles.html", label: "樣式",          key: "styles" },
    { href: "./users.html",  label: "使用者清單",    key: "users"  },
  ];

  // 自動判斷 active：依檔名比對 key（可被 opts.active 覆蓋）
  const file = (location.pathname.split("/").pop() || "").toLowerCase();
  let autoActive = links.find(l => (l.href.split("/").pop() || "").toLowerCase() === file)?.key || "";
  const active = String(opts.active || autoActive || "").toLowerCase();

  // 動態插入 CSS
  const cssLink = document.createElement("link");
  cssLink.rel = "stylesheet";
  cssLink.href = "./lib/navbar.css";
  document.head.appendChild(cssLink);

  root.innerHTML = `
    <nav class="app-nav">
      <div class="wrap">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="brand">what-to-eat-now｜管理後台</span>
          ${links.map(l => {
            const isActive = l.key.toLowerCase() === active;
            return `<a href="${l.href}" class="${isActive ? "active" : ""}">${l.label}</a>`;
          }).join("")}
        </div>
        <div class="right">
          <span id="appNavWho" class="app-badge">檢查中…</span>
          <button id="appBtnLogout" class="app-btn">登出</button>
        </div>
      </div>
    </nav>
  `;

  document.getElementById("appBtnLogout")?.addEventListener("click", () => signOut(auth));
  onAuthStateChanged(auth, user => {
    document.getElementById("appNavWho").textContent = user ? (user.email || user.uid) : "未登入";
  });
}

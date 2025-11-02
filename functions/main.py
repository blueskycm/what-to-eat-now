# Cloud Functions for Firebase (Python)
# LINE Webhook + 使用者資料/對話紀錄寫入 Firestore + Places + 距離選擇
from firebase_functions import https_fn
from firebase_functions.options import set_global_options
from firebase_admin import firestore
from math import radians, sin, cos, asin, sqrt
import os, json, hmac, hashlib, base64, datetime
import httpx
from urllib.parse import quote as urlquote
from urllib.parse import urlparse, parse_qs
import unicodedata, re
from google.cloud.firestore_v1 import Increment, ArrayUnion
from math import radians, sin, cos, asin, sqrt
import time
from typing import Dict, Any

import firebase_admin
from firebase_admin import firestore as _fs
import asyncio
from firebase_admin import auth as _auth

# 初始化 Admin SDK（若已初始化會跳過）
if not firebase_admin._apps:
    firebase_admin.initialize_app()

# ── Global options / Secrets ───────────────────────────────────────────────
set_global_options(
    region="asia-east1",
    max_instances=10,
    secrets=["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "PLACES_API_KEY"]
)

# 懶載入 Firestore（避免本機沒有 ADC 時在 import 階段就爆）
_db = None
def get_db():
    global _db
    if _db is None:
        _db = firestore.client()
    return _db

import datetime as _dt

_TZ = _dt.timezone(_dt.timedelta(hours=8))  # Asia/Taipei

def _today_id(dt: _dt.datetime | None = None) -> str:
    now = dt.astimezone(_TZ) if dt else _dt.datetime.now(tz=_TZ)
    return now.strftime("%Y%m%d")

def _usage_ref(date_id: str):
    return get_db().collection("usage_maps_daily").document(date_id)

def _seen_mark_and_check(date_id: str, key: str) -> bool:
    """
    以日為單位去重：第一次回傳 False（並寫入 seen[key]=true），之後回傳 True。
    """
    ref = _usage_ref(date_id)
    tx = get_db().transaction()

    @firestore.transactional
    def _tx(t):
        snap = ref.get(transaction=t)
        seen = (snap.to_dict() or {}).get("seen", {}) if snap.exists else {}
        if key in seen:
            return True
        t.set(ref, {"dateId": date_id, "seen": {key: True}}, merge=True)
        return False

    return _tx(tx)

LINE_TOKEN  = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_SECRET = os.environ.get("LINE_CHANNEL_SECRET", "")
PLACES_KEY  = os.environ.get("PLACES_API_KEY", "")
LIFF_SLOT_URL = os.environ.get("LIFF_SLOT_URL", "https://YOUR_HOSTING_DOMAIN/liff/slot.html")

# ── LINE helpers ───────────────────────────────────────────────────────────
def verify_signature(raw_body: bytes, signature: str) -> bool:
    mac = hmac.new(LINE_SECRET.encode(), raw_body, hashlib.sha256).digest()
    expected = base64.b64encode(mac).decode()
    return hmac.compare_digest(signature or "", expected)

def fetch_line_profile(uid: str) -> dict | None:
    try:
        r = httpx.get(
            f"https://api.line.me/v2/bot/profile/{uid}",
            headers={"Authorization": f"Bearer {LINE_TOKEN}"},
            timeout=8.0,
        )
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError:
        return None

# === 1) 摘要 messages 結構（新增） ===
def summarize_messages(messages: list[dict]) -> dict:
    """
    回傳：
      total / text / image / flexBubble / flexCarousel
    - flex: 若為 carousel → flexCarousel += 1，並且 flexBubble += 內容張數
            若為 bubble  → flexBubble   += 1
    """
    s = {"total": 0, "text": 0, "image": 0, "flexBubble": 0, "flexCarousel": 0}
    for m in messages or []:
        s["total"] += 1
        t = (m or {}).get("type")
        if t == "text":
            s["text"] += 1
        elif t == "image":
            s["image"] += 1
        elif t == "flex":
            contents = (m.get("contents") or {})
            ctype = (contents.get("type") or "").lower()
            if ctype == "carousel":
                items = contents.get("contents") or []
                s["flexCarousel"] += 1
                s["flexBubble"]   += len(items)
            elif ctype == "bubble":
                s["flexBubble"] += 1
    return s

# === 2) 原本的 line_reply 改名成底層呼叫（替換你檔案中的 line_reply）===
def _line_reply_raw(reply_token: str, messages: list) -> bool:
    try:
        r = httpx.post(
            "https://api.line.me/v2/bot/message/reply",
            headers={"Authorization": f"Bearer {LINE_TOKEN}", "Content-Type": "application/json"},
            json={"replyToken": reply_token, "messages": messages},
            timeout=10.0
        )
        if r.status_code >= 400:
            print("LINE_REPLY_ERR", {"status": r.status_code, "body": r.text[:2000]})
            return False
        return True
    except Exception as e:
        print("LINE_REPLY_EXC", repr(e))
        return False

# === 3) stats_ping：呼叫 C# /stats/ping（新增）===
def stats_ping(metric: str, count: int = 1, date_id: str | None = None) -> bool:
    base = os.environ.get("STATS_BASE_URL")
    if not base:
        return False
    try:
        body = {"metric": metric, "count": int(count)}
        if date_id:
            body["dateId"] = date_id
        # 若你的 C# 是 /inc，請改成 f"{base}/inc"
        r = httpx.post(f"{base}/stats/ping", json=body, timeout=5.0)
        return r.status_code < 400
    except Exception as e:
        print("STATS_PING_FAIL", metric, count, repr(e))
        return False

def _stats_inc_local(date_id: str, diffs: dict[str, int]):
    """HTTP 打點失敗時，直接寫 Firestore 累加，避免漏計。"""
    ref = _usage_ref(date_id)
    payload = {"updatedAt": firestore.SERVER_TIMESTAMP}
    for k, v in diffs.items():
        payload[f"counters.{k}"] = Increment(int(v))
    ref.set({"dateId": date_id}, merge=True)
    ref.update(payload)

# === 4) 高階包裝：真正給程式呼叫的 line_reply（新增）===
def line_reply(reply_token: str, messages: list, *, to_user: str | None = None, trace_id: str | None = None) -> bool:
    summary = summarize_messages(messages)
    ok = _line_reply_raw(reply_token, messages)

    # ✅ 只有成功送出才進行統計
    if ok:
        date_id = _today_id()
        seen_key = f"reply:{trace_id}" if trace_id else None
        if seen_key and _seen_mark_and_check(date_id, seen_key):
            pass  # 今天已記過，不再累加
        else:
            need_fallback = False
            diffs = {}

            def _acc(key, val):
                nonlocal need_fallback
                if val:
                    ok2 = stats_ping(key, val, date_id)
                    diffs[key] = diffs.get(key, 0) + int(val)
                    if not ok2:
                        need_fallback = True

            _acc("messages_total", summary["total"])
            _acc("messages_text", summary["text"])
            _acc("messages_image", summary["image"])
            _acc("messages_flex_bubble", summary["flexBubble"])
            _acc("messages_flex_carousel", summary["flexCarousel"])

            if need_fallback and any(diffs.values()):
                _stats_inc_local(date_id, diffs)

    # outbox
    try:
        get_db().collection("events").document("outbox").collection("logs").add({
            "ts": int(time.time()*1000),
            "channel": "line",
            "kind": "reply",
            "to": [to_user] if to_user else [],
            "replyToken": reply_token,
            "messages": messages,
            "summary": summary,
            "result": "ok" if ok else "failed",
            "traceId": trace_id,
        })
    except Exception as e:
        print("OUTBOX_WRITE_FAIL", repr(e))

    return ok

# ==== Backfill: 回補歷史用量（排除管理推播） ====================================
def _cards_per_reply_default() -> int:
    # 先讀環境變數，沒有就用 settings/replies.cardsPerReply，最後預設 5
    try:
        n = int(os.environ.get("CARDS_PER_REPLY", "").strip() or 0)
        if 3 <= n <= 9:
            return n
    except Exception:
        pass
    try:
        return cards_per_reply()
    except Exception:
        return 5

def _date_ids_in_range(date_from: str, date_to: str):
    cur = _dt.datetime.strptime(date_from, "%Y%m%d")
    end = _dt.datetime.strptime(date_to, "%Y%m%d")
    while cur < end:
        yield cur.strftime("%Y%m%d")
        cur += _dt.timedelta(days=1)

def _is_reply_outbox(doc_dict: dict) -> bool:
    """只計算『回覆』訊息，排除管理推播/群發"""
    if not isinstance(doc_dict, dict):
        return False

    # 1) 有 replyToken 一律視為 reply
    if doc_dict.get("replyToken"):
        return True

    # 2) kind 明確不是 reply → 排除
    kind = (doc_dict.get("kind") or "").lower()
    if kind and kind != "reply":
        return False

    # 3) 具有推播特徵 → 排除
    if doc_dict.get("targets"):
        return False
    if doc_dict.get("unitName") or doc_dict.get("unit"):
        return False
    if doc_dict.get("by"):
        return False

    # 4) 其餘情況（kind 為空或為 "reply"）→ 視為 reply
    return True

@https_fn.on_request(region="asia-east1", secrets=[])
def backfill_usage(req: https_fn.Request) -> https_fn.Response:
    """
    回補歷史用量（排除管理推播）
    需要管理員 ID Token（Authorization: Bearer <idToken>）
    POST JSON 參數：
      {
        "from": "20250101",          // 起日(含)
        "to":   "20251101",          // 迄日(不含)
        "cards": 5,                  // 估算法：每次回覆含幾張 bubble（預設讀環境或 settings）
        "source": "auto"             // auto|outbox|events
      }
    策略：
      1) outbox 精準回填：僅計 reply（排除管理推播）
      2) 若當日 outbox 無資料 → events/location 估算（同樣不含管理推播路徑）
    寫入：usage_maps_daily/{dateId} 的 counters.*
      - messages_total / messages_text / messages_image / messages_flex_bubble / messages_flex_carousel
    """
    try:
        # 權限：僅限管理員
        _require_admin_from_idtoken(req.headers.get("Authorization", ""))

        if req.method != "POST":
            return https_fn.Response("POST only", status=405)

        body = req.get_json(silent=True) or {}
        date_from = str(body.get("from") or "")
        date_to   = str(body.get("to")   or "")
        source    = (body.get("source") or "auto").lower()
        N_cards   = int(body.get("cards") or _cards_per_reply_default())
        includePush = bool(body.get("includeAdminPush") or False)

        if not (len(date_from)==8 and len(date_to)==8 and date_from.isdigit() and date_to.isdigit()):
            return https_fn.Response("bad range", status=400)

        db = get_db()
        updated_days = 0
        summary_days = {}

        for day in _date_ids_in_range(date_from, date_to):
            used_any = False

            # ---------- 先看 outbox：只計 reply ----------
            if source in ("auto", "outbox"):
                start_ms = int(_dt.datetime.strptime(day, "%Y%m%d").timestamp() * 1000)
                end_ms   = int((_dt.datetime.strptime(day, "%Y%m%d") + _dt.timedelta(days=1)).timestamp() * 1000)

                logs = list(
                    db.collection("events").document("outbox").collection("logs")
                      .where("ts", ">=", start_ms)
                      .where("ts", "<",  end_ms)
                      .stream()
                )

                totals = {"total":0, "text":0, "image":0, "flexBubble":0, "flexCarousel":0}
                for d in logs:
                    x = d.to_dict() or {}
                    if not _is_reply_outbox(x):
                        continue
                    msgs = x.get("messages") or []
                    s = summarize_messages(msgs)   # 直接用你檔案既有的函式
                    for k in totals:
                        totals[k] += s[k]

                if sum(totals.values()) > 0:
                    ref = db.collection("usage_maps_daily").document(day)
                    ref.set({"dateId": day}, merge=True)
                    ref.update({
                        "updatedAt": firestore.SERVER_TIMESTAMP,
                        "counters.messages_total":         Increment(totals["total"]),
                        "counters.messages_text":          Increment(totals["text"]),
                        "counters.messages_image":         Increment(totals["image"]),
                        "counters.messages_flex_bubble":   Increment(totals["flexBubble"]),
                        "counters.messages_flex_carousel": Increment(totals["flexCarousel"]),
                    })
                    summary_days[day] = {"mode": "outbox", **totals}
                    updated_days += 1
                    used_any = True
                    
            # ---------- （可選）回補管理推播：乘上收件人數 ----------
            if includePush:
                # 以同一天的毫秒範圍撈 outbox
                start_ms = int(_dt.datetime.strptime(day, "%Y%m%d").timestamp() * 1000)
                end_ms   = int((_dt.datetime.strptime(day, "%Y%m%d") + _dt.timedelta(days=1)).timestamp() * 1000)

                # 撈出當日 outbox 紀錄
                push_logs = []
                try:
                    push_logs = list(
                        db.collection("events").document("outbox").collection("logs")
                          .where("ts", ">=", start_ms)
                          .where("ts", "<",  end_ms)
                          .stream()
                    )
                except Exception:
                    push_logs = []

                # 累計推播（依訊息型別 × 收件人數）
                p = {"total":0, "text":0, "image":0, "flexBubble":0, "flexCarousel":0}
                for d in push_logs:
                    x = d.to_dict() or {}
                    kind = (x.get("kind") or "").lower()
                    # 視為管理推播（push/multicast/broadcast 或帶有 targets/unitName/by）
                    is_admin_push = bool(
                        kind in ("push","multicast","broadcast")
                        or x.get("targets") or x.get("unitName") or x.get("by")
                    )
                    if not is_admin_push:
                        continue

                    s = summarize_messages(x.get("messages") or [])
                    nrec = len(x.get("targets") or []) or 1  # 收件人數（無 targets 視為 1）

                    p["total"]        += s["total"]        * nrec
                    p["text"]         += s["text"]         * nrec
                    p["image"]        += s["image"]        * nrec
                    p["flexBubble"]   += s["flexBubble"]   * nrec
                    p["flexCarousel"] += s["flexCarousel"] * nrec

                # 寫入 counters.push_*（使用 Increment；重跑會再次累加）
                if sum(p.values()) > 0:
                    ref = db.collection("usage_maps_daily").document(day)
                    ref.set({"dateId": day}, merge=True)
                    ref.update({
                        "updatedAt": firestore.SERVER_TIMESTAMP,
                        "counters.push_total":          Increment(p["total"]),
                        "counters.push_text":           Increment(p["text"]),
                        "counters.push_image":          Increment(p["image"]),
                        "counters.push_flex_bubble":    Increment(p["flexBubble"]),
                        "counters.push_flex_carousel":  Increment(p["flexCarousel"]),
                    })
                    # 回傳摘要可選（方便你看回應）
                    summary_days.setdefault(day, {}).update({"push": p})

            # ---------- 沒 outbox → fallback events/location 估算 ----------
            if (not used_any) and (source in ("auto", "events")):
                coll = db.collection("events").document(day).collection("logs")
                docs = list(coll.where("type", "==", "message").stream())
                count_loc = 0
                for d in docs:
                    ev = (d.to_dict() or {}).get("event") or {}
                    m = (ev.get("message") or {})
                    if m.get("type") == "location":
                        count_loc += 1

                if count_loc > 0:
                    ref = db.collection("usage_maps_daily").document(day)
                    ref.set({"dateId": day}, merge=True)
                    ref.update({
                        "updatedAt": firestore.SERVER_TIMESTAMP,
                        # 估算：1 則文字 + 1 則 Flex（carousel），每次 Flex 內含 N_cards 張 bubble
                        "counters.messages_total":         Increment(count_loc * 2),
                        "counters.messages_text":          Increment(count_loc * 1),
                        "counters.messages_flex_carousel": Increment(count_loc * 1),
                        "counters.messages_flex_bubble":   Increment(count_loc * N_cards),
                    })
                    summary_days[day] = {"mode": "events-location-est", "loc": count_loc, "cardsPerReply": N_cards}
                    updated_days += 1

        return https_fn.Response(
            json.dumps({"ok": True, "updatedDays": updated_days, "summary": summary_days}, ensure_ascii=False),
            headers={"Content-Type": "application/json"}
        )

    except PermissionError as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=403, headers={"Content-Type": "application/json"})
    except Exception as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, headers={"Content-Type": "application/json"})

# ── Theme (settings/theme) helpers ─────────────────────────────────────────
THEME_TTL_SEC = 60
_THEME_CACHE = {"data": None, "exp": 0}

def get_theme(ttl_sec: int = THEME_TTL_SEC) -> dict:
    import time
    now = time.time()
    if _THEME_CACHE["data"] and _THEME_CACHE["exp"] > now:
        return _THEME_CACHE["data"]

    doc = get_db().collection("settings").document("theme").get()
    data = doc.to_dict() or {}

    theme = {
        "btnKind":          (data.get("btnKind") or "secondary"),
        "btnColor":         (data.get("btnColor") or "#E5E7EB").upper(),
        "btnMargin":        (data.get("btnMargin") or "sm"),
        "heroMode":         (data.get("heroMode") or "cover"),   # cover | fit
        "heroRatio":        (data.get("heroRatio") or "20:13"),  # 1:1 | 3:4 | 20:13 | 16:9
        "fallbackImageUrl": (data.get("fallbackImageUrl") or ""),
    }

    _THEME_CACHE["data"] = theme
    _THEME_CACHE["exp"]  = now + max(0, int(ttl_sec))
    return theme

def is_maps_enabled() -> bool:
    """讀取 settings/maps.enabled，預設 True（避免讀不到時誤殺服務）"""
    try:
        snap = get_db().document("settings/maps").get()
        if snap.exists:
            return bool((snap.to_dict() or {}).get("enabled", True))
    except Exception:
        pass
    return True

def normalize_image_url(url: str, size: int = 1200) -> str:
    """
    若為 Google Drive 分享連結，轉為可直接顯示的縮圖連結：
    https://drive.google.com/thumbnail?id=<FILE_ID>&sz=w<size>
    其它網址原樣返回。
    """
    if not url:
        return url
    u = url.strip()
    if "drive.google.com" not in u:
        return u

    try:
        parsed = urlparse(u)
        file_id = None

        # 1) /file/d/<id>/...  例：/file/d/11fAzbE_6ra00yN2xGPZ3F8wl6mAhBq-0/view
        m = re.search(r"/file/d/([a-zA-Z0-9_-]{10,})", parsed.path)
        if m:
            file_id = m.group(1)

        # 2) ?id=<id>  例：/uc?id=<id> 或 /open?id=<id>
        if not file_id:
            qs = parse_qs(parsed.query)
            file_id = (qs.get("id") or [None])[0]

        if file_id:
            return f"https://drive.google.com/thumbnail?id={file_id}&sz=w{int(size)}"
        return u
    except Exception:
        return u

def _require_admin_from_idtoken(authorization: str) -> str:
    """驗證前端帶來的 Firebase ID Token，確認呼叫者是 admins/{uid}。回傳 uid。"""
    if not authorization or not authorization.startswith("Bearer "):
        raise PermissionError("MISSING_ID_TOKEN")
    id_token = authorization.split(" ", 1)[1]
    decoded = _auth.verify_id_token(id_token)
    uid = decoded["uid"]
    if not get_db().collection("admins").document(uid).get().exists:
        raise PermissionError("NOT_ADMIN")
    return uid

def _build_single_bubble(title: str, body: str, image: str, btn_label: str, btn_url: str) -> dict:
    theme     = get_theme()
    btn_style = "primary" if theme.get("btnKind") == "primary" else "secondary"
    btn_color = theme.get("btnColor") or "#00B900"
    aspect    = _aspect_ratio(theme.get("heroRatio"))
    mode      = _aspect_mode(theme.get("heroMode"))
    fallback  = theme.get("fallbackImageUrl") or ""

    img_url = normalize_image_url(image or fallback, size=1200)

    bubble = {
        "type": "bubble",
        **({"hero": {
            "type": "image", "url": img_url, "size": "full",
            "aspectRatio": aspect, "aspectMode": mode
        }} if img_url else {}),
        "body": {"type":"box","layout":"vertical","spacing":"sm","contents":[
            {"type":"text","text": (title or "通知"), "weight":"bold","size":"md","wrap":True},
            *([{"type":"text","text": body, "size":"sm","wrap":True}] if body else [])
        ]},
        "footer":{"type":"box","layout":"vertical","spacing": _gap(theme.get("btnMargin")),
          "contents":[{"type":"button","style":btn_style,"height":"sm","color":btn_color,
            "action":{"type":"uri","label": (btn_label or "查看詳情"), "uri": (btn_url or "https://google.com")}
          }],"flex":0}
    }
    return bubble

# ── Firestore helpers ──────────────────────────────────────────────────────
def yyyymmdd(ts: datetime.datetime | None = None) -> str:
    ts = ts or datetime.datetime.utcnow()
    return ts.strftime("%Y%m%d")

def upsert_user(uid: str, source: dict | None = None):
    profile = fetch_line_profile(uid) or {}
    doc_ref = get_db().collection("users").document(uid)
    payload = {
        "uid": uid,
        "displayName": profile.get("displayName"),
        "pictureUrl": profile.get("pictureUrl"),
        "statusMessage": profile.get("statusMessage"),
        "lastSeenAt": firestore.SERVER_TIMESTAMP,
        "lastSource": source or {},
    }
    if not doc_ref.get().exists:
        payload["firstSeenAt"] = firestore.SERVER_TIMESTAMP
    doc_ref.set(payload, merge=True)

def log_event(uid: str | None, ev_type: str, raw_event: dict):
    day = yyyymmdd()
    get_db().collection("events").document(day).collection("logs").add({
        "uid": uid,
        "type": ev_type,
        "at": firestore.SERVER_TIMESTAMP,
        "event": raw_event
    })

def save_user_message(uid: str, content: dict):
    get_db().collection("users").document(uid).collection("messages").add({
        "at": firestore.SERVER_TIMESTAMP,
        **content
    })
    summary = {}
    if "text" in content:
        summary["lastMessage"] = content["text"][:200]
    if "type" in content:
        summary["lastMessageType"] = content["type"]
    get_db().collection("users").document(uid).set(summary, merge=True)

def set_user_radius(uid: str, radius: int):
    get_db().collection("users").document(uid).set({"pref": {"radius": radius}}, merge=True)

def get_user_radius(uid: str) -> int | None:
    snap = get_db().collection("users").document(uid).get()
    if snap.exists:
        return (snap.to_dict().get("pref") or {}).get("radius")
    return None

def cards_per_reply() -> int:
    """讀 settings/replies.cardsPerReply；無則回 5；限制 3~9"""
    try:
        snap = get_db().document("settings/replies").get()
        n = (snap.to_dict() or {}).get("cardsPerReply") if (snap and snap.exists) else 5
    except Exception:
        n = 5
    try:
        n = int(n)
    except Exception:
        n = 5
    return max(3, min(9, n))

def record_food_pref(uid: str, food: str):
    """將偏好記到 users/{uid}：
       - prefs.{food}: 累計次數（字典）
       - prefs_list: 近期紀錄（陣列）"""
    k = norm_food(food)
    if not k: return
    db = get_db()
    uref = db.collection("users").document(uid)
    uref.set({"prefs": {k: Increment(1)}}, merge=True)
    uref.set({"prefs_list": ArrayUnion([k]) }, merge=True)

def get_top_food_prefs(uid: str, k: int = 5) -> list[str]:
    """回傳使用者最常選的前 k 個偏好（依字典 prefs 降序）"""
    snap = get_db().collection("users").document(uid).get()
    if not snap.exists: return []
    prefs = (snap.to_dict() or {}).get("prefs", {}) or {}
    return [x for x,_ in sorted(prefs.items(), key=lambda kv: kv[1], reverse=True)[:k]]

def set_next(uid: str, step: str | None):
    get_db().collection("users").document(uid).set({"session": {"next": step}}, merge=True)

def set_session_pref(uid: str, pref: str | None):
    get_db().collection("users").document(uid).set({"session": {"pref": pref}}, merge=True)

def get_session_pref(uid: str) -> str | None:
    snap = get_db().collection("users").document(uid).get()
    return ((snap.to_dict() or {}).get("session") or {}).get("pref")

def get_next(uid: str) -> str | None:
    snap = get_db().collection("users").document(uid).get()
    return ((snap.to_dict() or {}).get("session") or {}).get("next")

# ===== 食物偏好：字串正規化 =====
def norm_food(s: str) -> str:
    if not s: return ""
    x = unicodedata.normalize("NFKC", s).strip().lower()
    x = re.sub(r"\s+", " ", x)
    x = x.strip(".,!?:;，。！？：；／/\\|*#@（）()[]{}<>「」『』")
    return x

# ── Quick Replies / Flex ───────────────────────────────────────────────────
def quick_reply_radius():
    def item(label, r):
        return {
            "type": "action",
            "action": {"type": "postback", "label": label, "data": f"radius={r}", "displayText": f"{label}"}
        }
    return {"items": [item("300m",300), item("500m",500), item("800m",800), item("1200m",1200), item("2000m",2000)]}

def _aspect_ratio(v: str) -> str:
    return v if v in {"1:1", "3:4", "20:13", "16:9"} else "20:13"

def _aspect_mode(v: str) -> str:
    return "fit" if str(v).lower() == "fit" else "cover"

def _gap(v: str) -> str:
    m = {"none": "none", "sm": "sm", "md": "md", "lg": "lg"}
    return m.get(str(v).lower(), "sm")

def build_gmaps_url(lat: float, lng: float) -> str:
    # 點位導向：用單一 query 參數（避免特殊符號）
    q = urlquote(f"{lat},{lng}", safe="")
    return f"https://www.google.com/maps/search/?api=1&query={q}"

def build_nearby_url(lat: float, lng: float, keyword: str = "餐廳") -> str:
    # 周邊搜尋：把「關鍵字 + 座標」合成一個 query 字串再編碼
    # 例：query="拉麵 near 22.984201,120.237191"
    q = urlquote(f"{keyword} near {lat},{lng}", safe="")
    return f"https://www.google.com/maps/search/?api=1&query={q}"

def build_flex_carousel(items: list[dict], user_lat: float | None = None, user_lng: float | None = None, liff_slot_url: str | None = None) -> dict:
    """
    items 需要至少包含：
      - title / name（店名）
      - address（可選，用於 subtitle）
      - photo（可選，無則 fallback）
      - lat, lng（地圖/周邊）
      - mapUrl（可選，若無則用 lat/lng 組）
    回傳可直接丟給 LINE 的 Flex Carousel 結構。
    """
    theme     = get_theme()
    btn_style = "primary" if theme.get("btnKind") == "primary" else "secondary"
    btn_color = theme.get("btnColor") or "#00B900"
    spacing   = _gap(theme.get("btnMargin"))
    aspect    = _aspect_ratio(theme.get("heroRatio"))
    mode      = _aspect_mode(theme.get("heroMode"))
    fallback  = theme.get("fallbackImageUrl") or "https://i.imgur.com/2JY3Szn.png"

    bubbles = []
    for it in items:
        photo   = it.get("photo") or fallback
        lat     = it.get("lat"); lng = it.get("lng")
        map_url = it.get("mapUrl") or (build_gmaps_url(lat, lng) if lat and lng else None)
        near_url= build_nearby_url(lat, lng, "餐廳") if (lat and lng) else None

        footer_buttons = []
        if map_url:
            footer_buttons.append({
                "type":"button","style":btn_style,"height":"sm","color":btn_color,
                "action":{"type":"uri","label":"開啟 Google 地圖","uri": map_url}
            })
        if near_url:
            footer_buttons.append({
                "type":"button","style":btn_style,"height":"sm","color":btn_color,
                "action":{"type":"uri","label":"查看周邊","uri": near_url}
            })

        bubbles.append({
            "type":"bubble",
            "hero":{
                "type":"image","url":photo,"size":"full",
                "aspectRatio":aspect,"aspectMode":mode
            },
            "body":{
                "type":"box","layout":"vertical","spacing":"sm","contents":[
                    {"type":"text","text": it.get("title") or it.get("name") or "店名",
                     "weight":"bold","size":"md","wrap":True},
                    *([{"type":"text","text": it.get("address") or it.get("subtitle") or "",
                        "size":"xs","color":"#8D8D8D","wrap":True}] if (it.get("address") or it.get("subtitle")) else [])
                ]
            },
            "footer":{
                "type":"box","layout":"vertical","spacing":spacing,
                "contents":footer_buttons,"flex":0
            }
        })

    return {"type": "carousel", "contents": bubbles}

def build_place_map_url(name: str | None, place_id: str | None) -> str:
    # https://www.google.com/maps/search/?api=1&query=<encoded>&query_place_id=<encoded>
    q  = urlquote((name or "").strip(), safe="")
    pid = urlquote((place_id or "").strip(), safe="")
    if pid:
        return f"https://www.google.com/maps/search/?api=1&query={q}&query_place_id={pid}"
    return f"https://www.google.com/maps/search/?api=1&query={q}"

def build_nearby_keyword_url(lat: float, lng: float, keyword: str = "餐廳") -> str:
    # 用 path 形式 + 編碼 keyword，避免未編碼中文字
    kw = urlquote(keyword, safe="")
    return f"https://www.google.com/maps/search/{kw}/@{lat},{lng},16z"

# ── Places：資料轉換與距離計算（補回缺的 helper） ─────────────────────────────
def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """回傳兩點間的大圓距離（公里）"""
    R = 6371.0
    rlat1, rlng1, rlat2, rlng2 = map(radians, [lat1, lng1, lat2, lng2])
    dlat = rlat2 - rlat1
    dlng = rlng2 - rlng1
    a = sin(dlat/2)**2 + cos(rlat1) * cos(rlat2) * sin(dlng/2)**2
    c = 2 * asin(sqrt(a))
    return R * c

def _transform_place_item(p: dict, user_lat: float, user_lng: float) -> dict:
    """
    把 Google Places 回傳的單筆 result 轉成我們 Flex 需要的結構：
    name/lat/lng/rating/total/vicinity/photo/mapUrl/distKm...
    """
    loc = ((p.get("geometry") or {}).get("location") or {})
    lat = loc.get("lat")
    lng = loc.get("lng")
    name = p.get("name")
    place_id = p.get("place_id")
    rating = p.get("rating")
    total = p.get("user_ratings_total") or p.get("userRatingsTotal") or 0
    addr = p.get("vicinity") or p.get("formatted_address") or ""

    # 第一張照片
    photo_url = None
    photos = p.get("photos") or []
    if photos:
        ref = photos[0].get("photo_reference")
        if ref and PLACES_KEY:
            # 用 Photo API 生成圖片 URL；LINE 端載入時才會打到 Google
            photo_url = (
                "https://maps.googleapis.com/maps/api/place/photo"
                f"?maxwidth=800&photo_reference={urlquote(ref, safe='')}&key={PLACES_KEY}"
            )

    # 距離（公里，四捨五入到 2 位）
    dist_km = None
    try:
        if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
            dist_km = round(_haversine_km(user_lat, user_lng, float(lat), float(lng)), 2)
    except Exception:
        dist_km = None

    return {
        "name": name,
        "placeId": place_id,
        "lat": lat,
        "lng": lng,
        "rating": rating,
        "total": total,
        "vicinity": addr,
        "photo": photo_url,  # 若沒有照片會是 None；build_flex_carousel 會用預設圖
        "mapUrl": build_place_map_url(name, place_id),
        "distKm": dist_km,
    }

# ── 偵錯 ──────────────────────────────────────────────
def _places_call(url: str, params: dict):
    # 不把 key 打在 log
    safe = {k: v for k, v in params.items() if k != "key"}
    r = httpx.get(url, params=params, timeout=10.0)
    data = r.json()
    print("PLACES", {"url": url.split("/")[-1], "status": data.get("status"),
                     "error": data.get("error_message"), "params": safe})
    r.raise_for_status()
    return data

def _nearby_once(lat: float, lng: float, radius: int, types: str, opennow: bool, limit: int, keyword: str | None = None):
    params = {
        "key": PLACES_KEY,
        "location": f"{lat},{lng}",
        "radius": radius,
        "type": types,
        "language": "zh-TW",
    }
    if opennow:
        params["opennow"] = "true"
    if keyword:
        params["keyword"] = keyword
    data = _places_call("https://maps.googleapis.com/maps/api/place/nearbysearch/json", params)
    return (data.get("results") or [])[:limit]

def _textsearch_once(lat: float, lng: float, radius: int, query: str, opennow: bool, limit: int):
    params = {
        "key": PLACES_KEY,
        "query": query,  # 例：餐廳|小吃|早午餐
        "location": f"{lat},{lng}",
        "radius": radius,
        "language": "zh-TW",
        "region": "tw"
    }
    if opennow:
        params["opennow"] = "true"
    data = _places_call("https://maps.googleapis.com/maps/api/place/textsearch/json", params)
    return (data.get("results") or [])[:limit]

def search_nearby_tiered(lat: float, lng: float, radii=(500, 800, 1200, 2000), limit=9, q: str | None = None):
    """
    策略順序：
      A. nearby: type=restaurant, opennow
      B. nearby: type=food|meal_takeaway|cafe, opennow
      C. textsearch: query=餐廳|小吃|早午餐, opennow
      D. nearby: type=restaurant（不限制營業中）
    找到就依距離+評分排序，取前 N。
    """
    # 先建策略：若有 q，優先用 q，否則走通用策略
    if q:
        q = q.strip()
        strategies = [
            ("nearby",  {"types": "restaurant",              "opennow": True,  "keyword": q}),           # A1: nearby + keyword
            ("text",    {"query": q,                          "opennow": True}),                           # A2: textsearch q
            ("text",    {"query": f"{q} 餐廳",                 "opennow": True}),                           # A3: textsearch q 餐廳
            ("nearby",  {"types": "food|meal_takeaway|cafe", "opennow": True,  "keyword": q}),           # A4: broader types + keyword
            ("nearby",  {"types": "restaurant",              "opennow": False, "keyword": q}),           # A5: nearby 不限營業中
        ]
    else:
        strategies = [
            ("nearby",  {"types": "restaurant",               "opennow": True}),
            ("nearby",  {"types": "food|meal_takeaway|cafe",  "opennow": True}),
            ("text",    {"query": "餐廳|小吃|早午餐",             "opennow": True}),
            ("nearby",  {"types": "restaurant",               "opennow": False}),
        ]

    pool = []
    used_radius = radii[-1]
    for r in radii:
        for kind, p in strategies:
            try:
                raw = []
                if kind == "nearby":
                    raw = _nearby_once(lat, lng, r, p["types"], p["opennow"], limit=30, keyword=p.get("keyword"))
                else:
                    raw = _textsearch_once(lat, lng, r, p["query"], p["opennow"], limit=30)
                items = [_transform_place_item(x, lat, lng) for x in raw]
                pool.extend(items)
                if pool:  # 有資料就停止擴半徑
                    used_radius = r
                    break
            except httpx.HTTPError:
                continue
        if pool:
            break

    # 去重（以 placeId），排序（距離優先，再來評分），只留前 N
    seen, uniq = set(), []
    for it in pool:
        pid = it.get("placeId")
        if pid and pid not in seen:
            seen.add(pid)
            uniq.append(it)
    uniq.sort(key=lambda x: (x.get("distKm") if x.get("distKm") is not None else 1e9,
                             -(x.get("rating") or 0)))
    return uniq[:limit], used_radius

# ── LINE Webhook ───────────────────────────────────────────────────────────
@https_fn.on_request(region="asia-east1")
def line(req: https_fn.Request) -> https_fn.Response:
    # 讓 LINE 後台 Verify（GET）通過
    if req.method != "POST":
        return https_fn.Response("ok", status=200)

    raw = req.data
    if not verify_signature(raw, req.headers.get("x-line-signature", "")):
        return https_fn.Response("invalid signature", status=401)

    body = json.loads(raw.decode() or "{}")
    events = body.get("events", [])

    for ev in events:
        etype = ev.get("type")
        uid = (ev.get("source") or {}).get("userId")
        trace_id = ev.get("webhookEventId") or (ev.get("message") or {}).get("id")

        if etype == "follow":
            upsert_user(uid, source=ev.get("source"))
            log_event(uid, "follow", ev)
            try:
                tops = get_top_food_prefs(uid, k=5)
                qr_items = [{"type":"action","action":{"type":"message","label":x,"text":x}} for x in tops][:5]
                set_next(uid, "expect_food")
                line_reply(ev["replyToken"], [{
                    "type":"text",
                    "text":"感謝加入！先輸入偏好食物（隨你慣用的寫法），再選搜尋半徑，最後分享你的位置 📍",
                    "quickReply": {"items": qr_items} if qr_items else None
                }], to_user=uid, trace_id=trace_id)
            except Exception:
                pass
            continue

        if etype == "postback":
            upsert_user(uid, source=ev.get("source"))
            data = (ev.get("postback") or {}).get("data") or ""
            if data.startswith("radius=") and uid:
                try:
                    radius = int(data.split("=",1)[1])
                    set_user_radius(uid, radius)
                    save_user_message(uid, {"type":"postback", "data": data})
                    log_event(uid, "postback", ev)
                    line_reply(ev["replyToken"], [{
                        "type":"text",
                        "text": f"已設定搜尋半徑為 {radius} 公尺，請分享你的位置 📍",
                        "quickReply": {"items":[{"type":"action","action":{"type":"location","label":"分享位置 📍"}}]}
                    }], to_user=uid, trace_id=trace_id)
                except ValueError:
                    line_reply(ev["replyToken"], [{"type":"text","text":"半徑格式不正確，請重新選擇一次喔。"}], to_user=uid, trace_id=trace_id)
            continue

        if etype == "message":
            upsert_user(uid, source=ev.get("source"))
            msg = ev.get("message") or {}
            mtype = msg.get("type")

            # 記錄對話
            content = {"type": mtype}
            if mtype == "text":
                content["text"] = (msg.get("text") or "")[:2000]
            elif mtype == "location":
                content.update({
                    "latitude": msg.get("latitude"),
                    "longitude": msg.get("longitude"),
                    "address": msg.get("address")
                })
            else:
                content["raw"] = msg
            if uid: save_user_message(uid, content)
            log_event(uid, "message", ev)

            # 關鍵字 → 距離選擇 + 分享位置
            if mtype == "text":
                text = (msg.get("text") or "").strip()

                # ✅ 若系統關閉，一開始輸入啟動詞就直接回覆
                if not is_maps_enabled() and text in ("現在吃什麼", "吃什麼", "我要吃什麼"):
                    line_reply(ev["replyToken"], [{
                        "type": "text",
                        "text": "目前餐廳查詢功能暫時關閉，請稍後再試 🙏"
                    }], to_user=uid, trace_id=trace_id)
                    continue

                # 會話狀態：若正在收偏好，就把本次文字當偏好，記錄後引導選半徑
                next_step = get_next(uid)
                msg_txt_raw = text
                msg_txt_norm = norm_food(msg_txt_raw)

                # 半徑格式（避免 2000m 被當成偏好）
                radius_match = re.match(r"^\s*(\d{2,5})\s*m\s*$", msg_txt_raw, flags=re.I)

                if next_step == "expect_food" and not radius_match:
                    if msg_txt_norm:
                        record_food_pref(uid, msg_txt_norm)
                        set_session_pref(uid, msg_txt_norm)  # ← 記住這次偏好
                    set_next(uid, "expect_radius")
                    line_reply(ev["replyToken"], [{
                        "type":"text",
                        "text": f"已記錄偏好：{msg_txt_raw} ✅\n請輸入搜尋半徑（例如：2000m），或點選下方常用選項。",
                        "quickReply": {
                            "items": [
                                {"type":"action","action":{"type":"message","label":"1000m","text":"1000m"}},
                                {"type":"action","action":{"type":"message","label":"1500m","text":"1500m"}},
                                {"type":"action","action":{"type":"message","label":"2000m","text":"2000m"}}
                            ]
                        }
                    }], to_user=uid, trace_id=trace_id)
                    continue

                # 1) 啟動流程 → 只請他選半徑
                if text in ("現在吃什麼", "吃什麼", "我要吃什麼"):
                    tops = get_top_food_prefs(uid, k=5)
                    qr_items = [{"type":"action","action":{"type":"message","label":x,"text":x}} for x in tops][:5]
                    set_next(uid, "expect_food")
                    line_reply(ev["replyToken"], [{
                        "type":"text",
                        "text":"請先輸入偏好食物（例如：牛肉麵、拉麵、滷味、燒臘、咖哩飯…照你的習慣打）",
                        "quickReply": {"items": qr_items} if qr_items else None
                    }], to_user=uid, trace_id=trace_id)
                    continue

                # 2) 要求擴大範圍 → 請他再分享位置
                if text in ("擴大範圍", "再找看看"):
                    line_reply(ev["replyToken"], [{
                        "type": "text",
                        "text": "請再分享一次位置，我會用更大的範圍幫你找 🔍",
                        "quickReply": {
                            "items": [
                                {"type": "action", "action": {"type": "location", "label": "分享位置 📍"}}
                            ]
                        }
                    }], to_user=uid, trace_id=trace_id)
                    continue  # 這個事件到此結束，避免後面又處理到

                # 3) 文字直接輸入半徑（例如 2000m）→ 設定並要求分享位置
                if radius_match:
                    try:
                        radius = int(radius_match.group(1))
                        set_user_radius(uid, radius)
                        set_next(uid, "expect_location")  # 可選：標記目前等待位置
                        line_reply(ev["replyToken"], [{
                            "type": "text",
                            "text": f"已設定搜尋半徑為 {radius} 公尺，請分享你的位置 📍",
                            "quickReply": {"items":[{"type":"action","action":{"type":"location","label":"分享位置 📍"}}]}
                        }], to_user=uid, trace_id=trace_id)
                    except ValueError:
                        line_reply(ev["replyToken"], [{"type":"text","text":"半徑格式不正確，請輸入像 2000m 這樣的格式。"}], to_user=uid, trace_id=trace_id)
                    continue

            # 位置 → Places
            if mtype == "location":
                # ✅ 先檢查後台一鍵關閉開關
                if not is_maps_enabled():
                    line_reply(ev["replyToken"], [{
                        "type": "text",
                        "text": "目前餐廳查詢功能暫時關閉，請稍後再試 🙏"
                    }], to_user=uid, trace_id=trace_id)
                    continue
                lat = msg.get("latitude"); lng = msg.get("longitude")
                prefer = get_user_radius(uid) if uid else None

                if not prefer:
                    line_reply(ev["replyToken"], [{
                        "type": "text",
                        "text": "還沒選搜尋半徑喔，先選一個距離再分享位置 📍",
                        "quickReply": quick_reply_radius()
                    }], to_user=uid, trace_id=trace_id)
                    continue

                items, used_radius = [], prefer
                try:
                    N = cards_per_reply()
                    qpref = get_session_pref(uid)  # 可能為 None
                    items, used_radius = search_nearby_tiered(lat, lng, radii=(prefer,), limit=N, q=qpref)
                except Exception as e:
                    print("PLACES_EXC", repr(e))
                    items = []

                if not items:
                    msg_txt = "這附近目前找不到有營業的餐廳😵，換個距離再找？"
                    if qpref:
                        msg_txt = f"在這附近找不到「{qpref}」😵，換個距離再找？或換個關鍵字試試。"
                    line_reply(ev["replyToken"], [{"type":"text","text": msg_txt, "quickReply": quick_reply_radius()}], to_user=uid, trace_id=trace_id)
                    set_session_pref(uid, None)
                    continue

                title = f"用 {used_radius} 公尺範圍找到這些：" if not qpref else f"用 {used_radius} 公尺找「{qpref}」："

                flex_contents = build_flex_carousel(items, lat, lng, LIFF_SLOT_URL)  # {"type":"carousel",...}

                ok = line_reply(ev["replyToken"], [
                    {"type": "text", "text": title},
                    {
                        "type": "flex",
                        "altText": (title[:380] + "（圖卡）"),  # altText 必填且 ≤ 400 字
                        "contents": flex_contents
                    }
                ], to_user=uid, trace_id=trace_id)

                if not ok:
                    # 不要再回覆第二次，只記錄需要降級回覆的資訊
                    print("FLEX_FALLBACK_NEEDED", {
                        "first": items[0].get("name"),
                        "mapUrl": items[0].get("mapUrl")
                    })

                set_next(uid, None)
                set_session_pref(uid, None)

                continue

    return https_fn.Response("ok", status=200)

@https_fn.on_request(region="asia-east1", secrets=["LINE_CHANNEL_ACCESS_TOKEN"])
def adminPush(req: https_fn.Request) -> https_fn.Response:
    """後台『特定行銷』推播 API（含精準計數：乘上收件人數）。"""
    try:
        _require_admin_from_idtoken(req.headers.get("Authorization", ""))   # 僅管理員

        if req.method != "POST":
            return https_fn.Response(json.dumps({"error": "POST_ONLY"}), status=405,
                                     headers={"Content-Type": "application/json"})

        data = req.get_json(silent=True) or {}
        targets = data.get("targets") or []
        msg     = data.get("message") or {}
        unit    = (data.get("unitName") or "").strip() or None
        notify  = bool(data.get("notificationDisabled") or False)
        trace   = data.get("traceId")

        if not isinstance(targets, list) or not targets:
            return https_fn.Response(json.dumps({"error": "NO_TARGETS"}), status=400,
                                     headers={"Content-Type": "application/json"})

        # 1) 組 LINE 訊息
        if msg.get("type") == "text":
            line_msg = {"type": "text", "text": str(msg.get("text") or "")[:5000]}
        elif msg.get("type") == "flex":
            bubble = _build_single_bubble(
                title=msg.get("title") or "",
                body=msg.get("body") or "",
                image=msg.get("image") or "",
                btn_label=msg.get("buttonLabel") or "查看詳情",
                btn_url=msg.get("buttonUrl") or "https://google.com"
            )
            line_msg = {
                "type": "flex",
                "altText": (msg.get("title") or "通知")[:390] + "（圖卡）",
                "contents": {"type": "carousel", "contents": [bubble]}
            }
        else:
            return https_fn.Response(json.dumps({"error": "BAD_MESSAGE"}), status=400,
                                     headers={"Content-Type": "application/json"})

        # 2) 送出（單人 / 多人）
        headers = {"Authorization": f"Bearer {LINE_TOKEN}", "Content-Type": "application/json"}
        ok = False
        if len(targets) == 1:
            payload = {"to": targets[0], "messages": [line_msg], "notificationDisabled": notify}
            r = httpx.post("https://api.line.me/v2/bot/message/push", headers=headers, json=payload, timeout=15.0)
            ok = (r.status_code < 400)
            if not ok: print("LINE_PUSH_ERR", r.status_code, r.text[:500])
        else:
            payload = {"to": targets, "messages": [line_msg], "notificationDisabled": notify}
            r = httpx.post("https://api.line.me/v2/bot/message/multicast", headers=headers, json=payload, timeout=30.0)
            ok = (r.status_code < 400)
            if not ok: print("LINE_MULTICAST_ERR", r.status_code, r.text[:500])

        # 3) 寫 outbox（標記為推播）
        try:
            get_db().collection("events").document("outbox").collection("logs").add({
                "ts": int(time.time()*1000),
                "channel": "line",
                "kind": "push",
                "targets": targets,
                "unitName": unit,
                "messages": [line_msg],
                "result": "ok" if ok else "failed",
                "traceId": trace,
            })
        except Exception as e:
            print("OUTBOX_PUSH_WRITE_FAIL", repr(e))

        # 4) 精準計數（乘上收件人數）
        try:
            summary = summarize_messages([line_msg])
            n = max(1, len(targets))
            date_id = _today_id()
            need_fallback = False
            diffs = {}

            def _acc(key, val):
                nonlocal need_fallback
                if val:
                    ok2 = stats_ping(key, val, date_id)
                    diffs[key] = diffs.get(key, 0) + int(val)
                    if not ok2:
                        need_fallback = True

            _acc("push_total",          summary["total"] * n)
            _acc("push_text",           summary["text"]  * n)
            _acc("push_image",          summary["image"] * n)
            _acc("push_flex_bubble",    summary["flexBubble"] * n)
            _acc("push_flex_carousel",  summary["flexCarousel"] * n)
            if unit:
                _acc(f"push_by_unit.{unit}", summary["total"] * n)

            if need_fallback and any(diffs.values()):
                _stats_inc_local(date_id, diffs)
        except Exception as e:
            print("USAGE_PUSH_SYNC_FAIL", repr(e))

        # 5) 簡單 job 紀錄
        get_db().collection("push_jobs").add({
            "ts": int(time.time()),
            "type": msg.get("type"),
            "targets": len(targets),
            "success": 1 if ok else 0,
            "fail": 0 if ok else 1,
            "unitName": unit
        })

        return https_fn.Response(json.dumps({"ok": ok}), headers={"Content-Type": "application/json"})

    except PermissionError as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=403,
                                 headers={"Content-Type": "application/json"})
    except Exception as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=500,
                                 headers={"Content-Type": "application/json"})

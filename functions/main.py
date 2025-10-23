# Cloud Functions for Firebase (Python)
# LINE Webhook + Google Places Nearby (open now) + Flex Carousel

from firebase_functions import https_fn
from firebase_functions.options import set_global_options
from firebase_admin import initialize_app

import os, json, hmac, hashlib, base64
import httpx

# ===== Global options =====
# 宣告地區與要掛載的 secrets（請先用 firebase functions:secrets:set 設好）
set_global_options(
    region="asia-east1",
    max_instances=10,
    secrets=["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "PLACES_API_KEY"]
)

# Firebase Admin（之後要寫 Firestore / Storage 會用到）
initialize_app()

# ===== Env / Secrets =====
LINE_TOKEN  = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_SECRET = os.environ.get("LINE_CHANNEL_SECRET", "")
PLACES_KEY  = os.environ.get("PLACES_API_KEY", "")
# 你的 LIFF 拉霸頁網址（可放環境變數；沒有就先顯示占位頁）
LIFF_SLOT_URL = os.environ.get("LIFF_SLOT_URL", "https://YOUR_HOSTING_DOMAIN/liff/slot.html")

# ===== Helpers =====
def verify_signature(raw_body: bytes, signature: str) -> bool:
    mac = hmac.new(LINE_SECRET.encode(), raw_body, hashlib.sha256).digest()
    expected = base64.b64encode(mac).decode()
    return hmac.compare_digest(signature or "", expected)

def line_reply(reply_token: str, messages: list):
    r = httpx.post(
        "https://api.line.me/v2/bot/message/reply",
        headers={"Authorization": f"Bearer {LINE_TOKEN}", "Content-Type": "application/json"},
        json={"replyToken": reply_token, "messages": messages},
        timeout=10.0
    )
    r.raise_for_status()

def places_nearby_open_restaurants(lat: float, lng: float, radius=800, limit=9):
    """呼叫 Places Nearby，過濾營業中餐廳"""
    params = {
        "key": PLACES_KEY,
        "location": f"{lat},{lng}",
        "radius": radius,
        "opennow": "true",
        "type": "restaurant",
        "language": "zh-TW",
    }
    r = httpx.get("https://maps.googleapis.com/maps/api/place/nearbysearch/json",
                  params=params, timeout=10.0)
    r.raise_for_status()
    data = r.json()
    results = (data.get("results") or [])[:limit]

    items = []
    for it in results:
        name = it.get("name")
        place_id = it.get("place_id")
        loc = (it.get("geometry") or {}).get("location") or {}
        rating = it.get("rating")
        total = it.get("user_ratings_total")
        vicinity = it.get("vicinity")

        # 照片
        photo_ref = None
        photos = it.get("photos") or []
        if photos:
            photo_ref = photos[0].get("photo_reference")
        photo_url = (f"https://maps.googleapis.com/maps/api/place/photo?maxwidth=800"
                     f"&photo_reference={photo_ref}&key={PLACES_KEY}") if photo_ref else None

        map_url = f"https://www.google.com/maps/search/?api=1&query={name}&query_place_id={place_id}"

        items.append({
            "name": name,
            "placeId": place_id,
            "lat": loc.get("lat"),
            "lng": loc.get("lng"),
            "rating": rating,
            "total": total,
            "vicinity": vicinity,
            "photo": photo_url,
            "mapUrl": map_url
        })
    return items

def build_flex_carousel(items: list, user_lat: float, user_lng: float, liff_url: str):
    """把餐廳清單組成 Flex Carousel，最後一張是拉霸入口"""
    bubbles = []
    for it in items:
        bubbles.append({
            "type": "bubble",
            "hero": {
                "type": "image",
                "url": it.get("photo") or "https://i.imgur.com/2JY3Szn.png",
                "size": "full", "aspectRatio": "20:13", "aspectMode": "cover"
            },
            "body": {
                "type": "box", "layout": "vertical", "spacing": "sm",
                "contents": [
                    {"type": "text", "text": it.get("name",""), "weight": "bold", "size": "md", "wrap": True},
                    {"type": "text", "text": it.get("vicinity") or "", "size": "sm", "color": "#555555", "wrap": True},
                    {"type": "text", "text": f"⭐ {it.get('rating','-')}（{it.get('total',0)}）", "size": "sm", "color": "#888888"}
                ]
            },
            "footer": {
                "type": "box", "layout": "vertical", "spacing": "sm", "contents": [
                    {"type": "button", "style": "primary", "height": "sm",
                     "action": {"type": "uri", "label": "開啟 Google 地圖", "uri": it.get("mapUrl")}},
                    {"type": "button", "style": "secondary", "height": "sm",
                     "action": {"type": "uri", "label": "查看周邊",
                                "uri": f"https://www.google.com/maps/search/餐廳/@{it.get('lat')},{it.get('lng')},16z"}}
                ], "flex": 0
            }
        })

    # 拉霸入口卡
    bubbles.append({
        "type": "bubble",
        "hero": {"type": "image",
                 "url": "https://i.imgur.com/0E0slot.png",
                 "size": "full", "aspectRatio": "20:13", "aspectMode": "cover"},
        "body": {"type": "box", "layout": "vertical", "contents": [
            {"type": "text", "text": "我選不出來！", "weight": "bold", "size": "lg"},
            {"type": "text", "text": "用拉霸機幫我決定今天吃什麼 🎰", "size": "sm", "color": "#666666", "wrap": True}
        ]},
        "footer": {"type": "box", "layout": "vertical", "spacing": "sm", "contents": [
            {"type": "button", "style": "primary",
             "action": {"type": "uri", "label": "開啟拉霸機",
                        "uri": f"{liff_url}?lat={user_lat}&lng={user_lng}"}}
        ], "flex": 0}
    })

    return {"type": "flex", "altText": "附近餐廳推薦", "contents": {"type": "carousel", "contents": bubbles}}

# ===== LINE Webhook Entry =====
@https_fn.on_request(region="asia-east1")
def line(req: https_fn.Request) -> https_fn.Response:
    # 1) 驗簽
    raw = req.data
    if not verify_signature(raw, req.headers.get("x-line-signature", "")):
        return https_fn.Response("invalid signature", status=401)

    body = json.loads(raw.decode() or "{}")
    events = body.get("events", [])

    for ev in events:
        if ev.get("type") != "message":
            continue

        msg = ev.get("message", {})
        mtype = msg.get("type")

        # A) 關鍵詞 → 請求分享位置
        if mtype == "text":
            text = (msg.get("text") or "").strip()
            if text in ("現在吃什麼", "吃什麼", "我要吃什麼"):
                line_reply(ev["replyToken"], [{
                    "type": "text",
                    "text": "請分享你現在的位置，我幫你找附近有營業的餐廳 🍱",
                    "quickReply": {
                        "items": [{
                            "type": "action",
                            "action": {"type": "location", "label": "分享位置 📍"}
                        }]
                    }
                }])

        # B) 收到位置 → 查 Places → 回 Flex
        if mtype == "location":
            lat = msg.get("latitude")
            lng = msg.get("longitude")
            try:
                items = places_nearby_open_restaurants(lat, lng, radius=800, limit=9)
                if not items:
                    line_reply(ev["replyToken"], [{
                        "type": "text",
                        "text": "這附近目前找不到有營業的餐廳😵，要不要換個距離或時段再試試？"
                    }])
                else:
                    flex = build_flex_carousel(items, lat, lng, LIFF_SLOT_URL)
                    line_reply(ev["replyToken"], [flex])
            except httpx.HTTPError:
                line_reply(ev["replyToken"], [{
                    "type": "text",
                    "text": "搜尋餐廳時出錯了，等一下再試試 🙏"
                }])

    return https_fn.Response("ok", status=200)

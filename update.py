#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
反诈信息日报 · 每日搜集更新脚本
================================
用法：
  python3 update.py            # 联网抓取最新反诈资讯，逐条确认后写入 data.js
  python3 update.py --auto     # 全自动：抓取、去重、直接写入（适合定时任务）
  python3 update.py --manual   # 手动模式：粘贴标题/摘要/链接生成条目
  python3 update.py --dry-run  # 只抓取预览，不写入文件

原理：
  1) 从多个公开新闻源（RSS）抓取条目，用反诈关键词过滤；
  2) 与 data.js 中已有条目去重（链接 + 标题相似度）；
  3) 将新条目插入 data.js 的 items 数组头部，并更新 updatedAt；
  4) 同时把当天新增案例汇总进"反诈日报"。

要求：Python 3.6+，仅标准库（urllib），无需安装依赖。
"""
import argparse
import json
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, date
from html.parser import HTMLParser

DATA_FILE = "data.js"

# ---------- 反诈关键词 ----------
KEYWORDS = [
    "诈骗", "反诈", "电诈", "电信网络诈骗", "骗局", "被骗", "96110",
    "刷单", "杀猪盘", "养老诈骗", "洗钱", "帮信", "预警", "冒充公检法",
    "冒充客服", "虚假投资", "虚假贷款", "AI换脸", "AI拟声", "验证码",
    "账户冻结", "安全账户", "退改签", "运金", "跑分", "止付",
]
TYPE_KEYWORDS = [
    ("刷单", "刷单返利"), ("投资", "投资理财"), ("贷款", "虚假网贷"),
    ("客服", "冒充客服"), ("公检法", "冒充公检法"), ("征信", "虚假征信"),
    ("领导", "冒充领导"), ("杀猪盘", "杀猪盘"), ("交友", "交友诈骗"),
    ("游戏", "游戏交易"), ("军警", "冒充军警"), ("AI", "AI诈骗"),
    ("换脸", "AI诈骗"), ("退改签", "机票退改签"), ("黄金", "线下运金"),
    ("运金", "线下运金"),
]

# ---------- 信息源（每个源独立容错） ----------
SOURCES = [
    {
        "name": "中国新闻网滚动",
        "url": "http://www.chinanews.com.cn/rss/scroll-news.xml",
        "kind": "rss",
    },
    {
        "name": "央视网要闻",
        "url": "https://news.cctv.com/rss/news.xml",
        "kind": "rss",
    },
    {
        "name": "澎湃新闻",
        "url": "https://feedx.net/rss/thepaper.xml",
        "kind": "rss",
    },
    {
        "name": "腾讯新闻",
        "url": "https://rsshub.app/tencent/news",
        "kind": "rss",
    },
]

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


# ---------- RSS 解析 ----------
class RSSParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_item = False
        self.cur = {}
        self.cur_tag = None
        self.items = []

    def handle_starttag(self, tag, attrs):
        if tag == "item":
            self.in_item = True
            self.cur = {}
        elif self.in_item and tag in ("title", "link", "description", "pubDate"):
            self.cur_tag = tag
            self.cur.setdefault(tag, [])

    def handle_endtag(self, tag):
        if tag == "item":
            self.in_item = False
            if self.cur.get("title") and self.cur.get("link"):
                self.items.append({
                    "title": "".join(self.cur.get("title", [])).strip(),
                    "link": "".join(self.cur.get("link", [])).strip(),
                    "description": "".join(self.cur.get("description", [])).strip(),
                    "pubDate": "".join(self.cur.get("pubDate", [])).strip(),
                })
            self.cur = {}
        elif self.in_item and tag == self.cur_tag:
            self.cur_tag = None

    def handle_data(self, data):
        if self.in_item and self.cur_tag:
            self.cur[self.cur_tag].append(data)


def fetch_rss(url):
    """抓取并解析 RSS，返回条目列表。"""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            text = raw.decode(enc)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    else:
        text = raw.decode("utf-8", errors="replace")
    p = RSSParser()
    p.feed(text)
    return p.items


def guess_type(title):
    for kw, t in TYPE_KEYWORDS:
        if kw in title:
            return t
    return "综合"


def guess_risk(title):
    high = ["AI", "换脸", "拟声", "刷单", "公检法", "运金", "退改签", "杀猪盘",
            "投资", "止付", "洗钱", "安全账户", "冻结"]
    for kw in high:
        if kw in title:
            return "high"
    return "medium"


def parse_pubdate(s):
    """解析 RSS pubDate（RFC 2822）→ YYYY-MM-DD 与 HH:MM。"""
    if not s:
        return None, None
    try:
        dt = datetime.strptime(s.strip(), "%a, %d %b %Y %H:%M:%S %z")
    except ValueError:
        try:
            dt = datetime.strptime(s.strip(), "%a, %d %b %Y %H:%M:%S %Z")
        except ValueError:
            return None, None
    return dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M")


def normalize_url(u):
    u = u.split("#")[0].strip()
    return u


# ---------- data.js 读写 ----------
def read_data():
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return f.read()


def load_items(text):
    """从 data.js 文本中解析出 items 数组（轻量提取 id/title/url/date）。"""
    m = re.search(r"items:\s*\[(.*?)\n\s*\],", text, re.DOTALL)
    if not m:
        return []
    body = m.group(1)
    items = []
    for obj in re.finditer(r"\{\s*id:\s*\"([^\"]+)\"[^{}]*?url:\s*\"([^\"]*)\"[^{}]*?date:\s*\"([^\"]+)\"", body, re.DOTALL):
        items.append({"id": obj.group(1), "url": obj.group(2), "date": obj.group(3)})
    return items


def item_js(it, indent="    "):
    lines = []
    lines.append(indent + "{")
    lines.append(indent + "      id: %r," % it["id"])
    lines.append(indent + "      date: %r," % it["date"])
    lines.append(indent + "      time: %r," % it["time"])
    lines.append(indent + "      source: %r," % it["source"])
    lines.append(indent + "      type: %r," % it["type"])
    lines.append(indent + "      risk: %r," % it["risk"])
    lines.append(indent + "      title: %r," % it["title"])
    lines.append(indent + "      summary: %r," % it["summary"])
    lines.append(indent + "      reason: %r," % it["reason"])
    lines.append(indent + "      selected: %s," % ("true" if it.get("selected") else "false"))
    lines.append(indent + "      url: %r," % it.get("url", ""))
    lines.append(indent + "      dups: %s" % json.dumps(it.get("dups", []), ensure_ascii=False))
    lines.append(indent + "}")
    return "\n".join(lines)


def build_new_items(candidates, existing):
    """candidates: 抓取到的新条目 dict；existing: 现有条目（id/title/url/date）。
    返回与 data.js 格式一致的新条目列表。"""
    seen_urls = {normalize_url(e["url"]) for e in existing if e["url"]}
    seen_ids = {e["id"] for e in existing}
    new_items = []
    for c in candidates:
        url = normalize_url(c.get("link", ""))
        if url and url in seen_urls:
            continue
        title = c.get("title", "").strip()
        if not title:
            continue
        # 简单标题相似度去重
        dup = False
        for e in existing:
            if e["title"] and (title in e["title"] or e["title"] in title):
                dup = True
                break
        if dup:
            continue
        d, t = parse_pubdate(c.get("pubDate", ""))
        if not d:
            d = date.today().isoformat()
        if not t:
            t = datetime.now().strftime("%H:%M")
        n = len(seen_ids) + len(new_items) + 1
        it = {
            "id": "it-auto-%s-%03d" % (datetime.now().strftime("%Y%m%d"), n),
            "date": d,
            "time": t,
            "source": c.get("source", "自动采集"),
            "type": guess_type(title),
            "risk": guess_risk(title),
            "title": title,
            "summary": c.get("description", "").strip()[:180],
            "reason": "由每日更新脚本自动采集，请核实来源后补充警示要点。",
            "selected": False,
            "url": url,
            "dups": [],
        }
        new_items.append(it)
        if url:
            seen_urls.add(url)
    return new_items


def write_back(text, new_items, new_alerts=None, new_daily=None):
    """把新条目插入 data.js，更新 updatedAt 与日报。"""
    # 1) 更新 updatedAt
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    text = re.sub(r'updatedAt:\s*"[^"]*"', 'updatedAt: "%s"' % now, text, count=1)

    # 2) 插入 items
    if new_items:
        head = "  items: [\n"
        idx = text.find(head)
        if idx != -1:
            insert_at = idx + len(head)
            new_block = "\n".join(item_js(it) for it in new_items) + ",\n"
            text = text[:insert_at] + new_block + text[insert_at:]

    # 3) 插入/更新日报
    if new_daily:
        dl_head = "  dailies: [\n"
        dli = text.find(dl_head)
        if dli != -1:
            insert_at = dli + len(dl_head)
            daily_js = (
                '    {\n'
                '      id: %r,\n' % new_daily["id"] +
                '      date: %r,\n' % new_daily["date"] +
                '      title: %r,\n' % new_daily["title"] +
                '      stats: %r,\n' % new_daily["stats"] +
                '      content: %s\n' % json.dumps(new_daily["content"], ensure_ascii=False) +
                '    },\n'
            )
            text = text[:insert_at] + daily_js + text[insert_at:]
    return text


# ---------- 手动模式 ----------
def manual_mode():
    print("== 手动录入新条目（Ctrl+C 结束）==")
    items = []
    while True:
        print("-" * 40)
        title = input("标题: ").strip()
        if not title:
            break
        summary = input("摘要(回车跳过): ").strip()
        url = input("来源链接(回车跳过): ").strip()
        source = input("来源名称(回车默认'手动录入'): ").strip() or "手动录入"
        typ = input("类型(回车自动判断): ").strip()
        risk = input("风险等级 high/medium/low(回车默认 medium): ").strip() or "medium"
        d = date.today().isoformat()
        t = datetime.now().strftime("%H:%M")
        it = {
            "id": "it-manual-%s-%03d" % (datetime.now().strftime("%Y%m%d"), len(items) + 1),
            "date": d, "time": t, "source": source,
            "type": typ or guess_type(title),
            "risk": risk if risk in ("high", "medium", "low") else "medium",
            "title": title, "summary": summary, "reason": "",
            "selected": False, "url": url, "dups": [],
        }
        items.append(it)
        print("已添加：%s" % title)
    if not items:
        print("未录入任何条目。")
        return None
    text = read_data()
    new_text = write_back(text, items)
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        f.write(new_text)
    print("已写入 %d 条到 data.js。" % len(items))
    return items


# ---------- 自动模式 ----------
def auto_mode(dry_run=False, confirm=True):
    print("== 开始抓取反诈资讯 ==")
    candidates = []
    for src in SOURCES:
        try:
            items = fetch_rss(src["url"])
            hits = [it for it in items if any(kw in it["title"] for kw in KEYWORDS)]
            for h in hits:
                h["source"] = src["name"]
            print("  [%s] 抓取 %d 条，其中反诈相关 %d 条" % (src["name"], len(items), len(hits)))
            candidates.extend(hits)
        except Exception as e:
            print("  [%s] 抓取失败：%s" % (src["name"], e))
    if not candidates:
        print("本次未抓到反诈相关条目。可尝试：\n  1) 稍后重跑\n  2) python3 update.py --manual 手动录入")
        return

    text = read_data()
    existing = load_items(text)
    new_items = build_new_items(candidates, existing)
    print("== 去重后新增候选 %d 条 ==" % len(new_items))
    for i, it in enumerate(new_items, 1):
        print("  %d) [%s] %s" % (i, it["date"], it["title"]))

    if not new_items:
        print("没有新条目，data.js 已是最新。")
        return

    if confirm and not dry_run:
        print("逐条确认：输入 y 添加 / n 跳过 / a 全部添加 / q 退出")
        kept = []
        for it in new_items:
            ans = input("  添加? [%s] %s (y/n/a/q): " % (it["date"], it["title"])).strip().lower()
            if ans == "a":
                kept = new_items[new_items.index(it):]
                break
            if ans == "q":
                break
            if ans == "y" or ans == "":
                kept.append(it)
        new_items = kept

    if not new_items:
        print("未选择任何条目，未写入。")
        return

    # 生成今日日报
    today = date.today().isoformat()
    today_items = [it for it in new_items if it["date"] == today]
    new_daily = None
    if today_items:
        new_daily = {
            "id": "dl-" + today.replace("-", ""),
            "date": today,
            "title": "反诈日报 · %s" % today,
            "stats": "新增风险案例 %d 起 | 自动采集汇总" % len(today_items),
            "content": ["自动采集：%s" % it["title"] for it in today_items[:5]] +
                       ["遇可疑情况请拨打 96110 咨询，被骗后立即拨打 110 止付。"],
        }

    if dry_run:
        print("== dry-run：以下内容将写入 data.js ==")
        for it in new_items:
            print("  + %s" % it["title"])
        if new_daily:
            print("  + 日报：%s" % new_daily["title"])
        print("（未写入文件）")
        return

    new_text = write_back(text, new_items, new_daily=new_daily)
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        f.write(new_text)
    print("== 完成：已写入 %d 条新资讯%s到 data.js ==" % (
        len(new_items), "（含当日日报）" if new_daily else ""))


def main():
    ap = argparse.ArgumentParser(description="反诈信息日报每日更新脚本")
    ap.add_argument("--auto", action="store_true", help="全自动模式（不逐条确认）")
    ap.add_argument("--manual", action="store_true", help="手动录入模式")
    ap.add_argument("--dry-run", action="store_true", help="只抓取预览，不写入文件")
    args = ap.parse_args()

    if args.manual:
        manual_mode()
        return
    auto_mode(dry_run=args.dry_run, confirm=not args.auto)


if __name__ == "__main__":
    main()

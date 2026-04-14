#!/usr/bin/env python3
"""
Knot Skill 市场检索脚本
用法：
  python3 search_skills.py --keyword <关键词> [--page <页码>] [--size <每页数量>]
  python3 search_skills.py --list-tags          # 列出所有可用标签
  python3 search_skills.py --tags <tag_id1,tag_id2>  # 按标签ID过滤

Token 自动从环境变量 KNOT_JWT_TOKEN / KNOT_USERNAME 中获取，无需手动传入。
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error
import ssl


API_URL = "https://knot.woa.com/apigw/openapi/v1/skills/get"
GET_CONFIG_URL = "https://knot.woa.com/apigw/api/v1/mcpport/get_config"
GET_TAGS_URL = "https://knot.woa.com/apigw/openapi/v1/skills/get_skill_tags"


def _create_ssl_context() -> ssl.SSLContext:
    """创建忽略 SSL 证书验证的上下文，解决企业内网证书链无法验证的问题"""
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE
    return ssl_ctx


def get_username() -> str:
    """从环境变量获取用户名"""
    return os.environ.get("KNOT_USERNAME", "")


def fetch_knot_api_token() -> str:
    """
    通过 curl 命令从 Knot 平台获取 API Token。
    使用 KNOT_JWT_TOKEN 和 KNOT_USERNAME 环境变量进行鉴权。
    """
    cmd = [
        "curl", "-s", "-k",  # -k 忽略 SSL 证书验证，解决企业内网证书链无法验证的问题
        GET_CONFIG_URL,
        "--header", f"X-Username: {os.environ.get('KNOT_USERNAME', '')}",
        "--header", "Content-Type: application/json",
        "-d", json.dumps({
            "jwt_token": os.environ.get("KNOT_JWT_TOKEN", ""),
            "for_knot_api_token": True,
        }),
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except FileNotFoundError:
        print("[错误] 未找到 curl 命令，请确认已安装", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"[错误] 执行 curl 获取 Token 失败: {e}", file=sys.stderr)
        sys.exit(1)

    if result.returncode != 0:
        print(f"[错误] curl 返回非零退出码 {result.returncode}: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        print(f"[错误] 解析 Token 响应失败: {e}\n原始输出:\n{result.stdout}", file=sys.stderr)
        sys.exit(1)

    # 响应结构：{"code": 0, "data": {"knot_api_token": "..."}}
    if data.get("code") != 0:
        print(f"[错误] 获取 Token 失败: code={data.get('code')}, msg={data.get('msg')}", file=sys.stderr)
        sys.exit(1)

    token = data.get("data", {}).get("knot_api_token", "")
    if not token:
        print(f"[错误] 响应中未找到 knot_api_token 字段，完整响应:\n{json.dumps(data, indent=2)}", file=sys.stderr)
        sys.exit(1)

    return token


def fetch_skill_tags(token: str, username: str) -> list:
    """
    获取所有可用的技能标签列表

    Args:
        token: API Token
        username: 用户名

    Returns:
        标签列表，每项包含 id、name 等字段
    """
    req = urllib.request.Request(
        GET_TAGS_URL,
        data=b"{}",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-knot-api-token": token,
            "X-Username": username,
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30, context=_create_ssl_context()) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"[错误] HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"[错误] 网络请求失败: {e.reason}", file=sys.stderr)
        sys.exit(1)

    if result.get("code") != 0:
        print(f"[错误] API 返回错误: code={result.get('code')}, msg={result.get('msg')}", file=sys.stderr)
        sys.exit(1)

    return result.get("data", [])


def print_tags(tags: list):
    """格式化打印标签列表"""
    if not tags:
        print("暂无可用标签。")
        return

    print(f"共 {len(tags)} 个可用标签：\n")
    print(f"{'ID':<6} {'英文标识':<20} {'显示名称'}")
    print("-" * 50)
    for tag in tags:
        tag_id = tag.get("id", "-")
        tag_name = tag.get("tag_name", "-")
        display_name = tag.get("display_name", "-")
        print(f"{tag_id:<6} {tag_name:<20} {display_name}")

    print()
    print("=== JSON_OUTPUT_START ===")
    print(json.dumps(tags, ensure_ascii=False, indent=2))
    print("=== JSON_OUTPUT_END ===")


def search_skills(token: str, username: str, keyword: str = "",
                  category: str = "", page_num: int = 1,
                  page_size: int = 20, order_by: str = "download_count",
                  tag_ids: list = None) -> dict:
    """
    检索 Knot Skill 市场中的技能

    Args:
        token: API Token
        username: 用户名
        keyword: 搜索关键词
        category: 分类（"" 全部 / "official" 官方 / "managed" 我管理的 / "starred" 我收藏的 / "security" 已安全认证的）
        page_num: 页码（从 1 开始）
        page_size: 每页数量（最大 100）
        order_by: 排序方式（"download_count" 按下载量 / "created_at" 按时间）
        tag_ids: 标签ID列表，用于过滤（可选，传入标签ID的字符串列表，如 ["38", "45"]）

    Returns:
        包含技能列表的字典
    """
    payload = {
        "keyword": keyword,
        "category": category,
        "page_num": page_num,
        "page_size": page_size,
        "order_by": order_by,
    }

    if tag_ids:
        payload["tag_ids"] = tag_ids

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-knot-api-token": token,
            "X-Username": username,
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30, context=_create_ssl_context()) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"[错误] HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"[错误] 网络请求失败: {e.reason}", file=sys.stderr)
        sys.exit(1)

    if result.get("code") != 0:
        print(f"[错误] API 返回错误: code={result.get('code')}, msg={result.get('msg')}", file=sys.stderr)
        sys.exit(1)

    return result.get("data", {})


def print_skills(data: dict):
    """格式化打印技能列表"""
    skills = data if isinstance(data, list) else data.get("list", [])
    total = data.get("total_count", len(skills)) if isinstance(data, dict) else len(skills)

    if not skills:
        print("未找到匹配的技能。")
        return

    print(f"共找到 {total} 个技能，当前显示 {len(skills)} 个：\n")
    print(f"{'ID':<6} {'下载量':<8} {'类型':<8} {'安全验证':<12} {'名称'}")
    print("-" * 72)
    for skill in skills:
        skill_id = skill.get("id", "-")
        name = skill.get("display_name") or skill.get("name", "-")
        downloads = skill.get("download_count", 0)
        skill_type = "官方" if skill.get("type") == "official" else "自定义"
        security_status = skill.get("security_scan_status")
        security_label = "✅ 已通过" if security_status == "passed" else "❌ 未通过"
        print(f"{skill_id:<6} {downloads:<8} {skill_type:<8} {security_label:<12} {name}")

    print()
    # 输出完整 JSON 供调用方解析
    print("=== JSON_OUTPUT_START ===")
    print(json.dumps(skills, ensure_ascii=False, indent=2))
    print("=== JSON_OUTPUT_END ===")


def main():
    parser = argparse.ArgumentParser(description="检索 Knot Skill 市场")
    parser.add_argument("--keyword", "-k", default="", help="搜索关键词")
    parser.add_argument("--username", "-u", default="", help="用户名（也可通过 KNOT_USERNAME 环境变量设置）")
    parser.add_argument("--category", "-c", default="",
                        choices=["", "official", "managed", "starred", "security"],
                        help="分类筛选")
    parser.add_argument("--page", "-p", type=int, default=1, help="页码（默认 1）")
    parser.add_argument("--size", "-s", type=int, default=20, help="每页数量（默认 20）")
    parser.add_argument("--order", "-o", default="download_count",
                        choices=["download_count", "created_at"],
                        help="排序方式")
    parser.add_argument("--tags", "-t", default="",
                        help="按标签ID过滤，多个ID用英文逗号分隔，例如：--tags 1,2,3")
    parser.add_argument("--list-tags", action="store_true",
                        help="列出所有可用标签（及其ID）后退出")
    args = parser.parse_args()

    # 自动获取 Token，无需用户传入
    token = fetch_knot_api_token()
    username = args.username or get_username()

    # 若只是列出标签，则获取并打印后退出
    if args.list_tags:
        tags = fetch_skill_tags(token, username)
        print_tags(tags)
        return

    # 解析标签ID列表（接口返回的 id 为字符串类型，直接传字符串即可）
    tag_ids = []
    if args.tags:
        tag_ids = [t.strip() for t in args.tags.split(",") if t.strip()]

    data = search_skills(
        token=token,
        username=username,
        keyword=args.keyword,
        category=args.category,
        page_num=args.page,
        page_size=args.size,
        order_by=args.order,
        tag_ids=tag_ids if tag_ids else None,
    )
    print_skills(data)


if __name__ == "__main__":
    main()
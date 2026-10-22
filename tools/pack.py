"""pack.py — 发布打包（方案 5.5 / 5.6 内网分发要求）

产物（输出到 dist/）：
  table-export-v<version>.zip          可直接"开发者模式加载"的安装包（仅运行时文件）
  table-export-v<version>.zip.sha256   分发前核验用摘要

用法：python tools/pack.py
"""
import hashlib
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")

# 安装包仅包含运行时文件；tools/tests 不进入发布包
INCLUDE = [
    "manifest.json",
    "src/popup/popup.html",
    "src/popup/popup.css",
    "src/popup/popup.js",
    "src/popup/exporter.js",
    "src/core/detect.js",
    "src/core/extract.js",
    "src/lib/exceljs.min.js",
    "src/lib/exceljs.LICENSE",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
]


def read_version():
    import json
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        return json.load(f)["version"]


def main():
    version = read_version()
    os.makedirs(DIST, exist_ok=True)
    zip_path = os.path.join(DIST, f"table-export-v{version}.zip")

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in INCLUDE:
            full = os.path.join(ROOT, rel)
            if not os.path.exists(full):
                raise SystemExit(f"[打包失败] 缺少文件：{rel}")
            zf.write(full, arcname="table-export/" + rel)

    # SHA-256 摘要（内网管理员分发前核验）
    with open(zip_path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    sha_path = zip_path + ".sha256"
    with open(sha_path, "w", encoding="utf-8") as f:
        f.write(f"{digest}  table-export-v{version}.zip\n")

    size_kb = os.path.getsize(zip_path) / 1024
    print(f"[打包完成] {zip_path}  ({size_kb:.0f} KB)")
    print(f"[SHA-256]  {digest}")
    print(f"[摘要文件] {sha_path}")


if __name__ == "__main__":
    main()

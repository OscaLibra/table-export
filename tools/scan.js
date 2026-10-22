/*
 * scan.js — 构建期静态扫描（方案 4.5.2 执行保障第二道关）
 *
 * 扫描注入源文件（src/core/）中出现的高危关键字：
 * 任何"模拟用户操作 / 修改页面"的 API 出现即报错退出（exit 1）。
 *
 * 用法：node tools/scan.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const CORE_DIR = path.join(__dirname, "..", "src", "core");

/** 禁止出现在注入源文件中的 API 与模式（方案 4.5.2 禁止清单） */
const FORBIDDEN_PATTERNS = [
  { re: /\.click\s*\(/, why: "元素点击（模拟用户点击）" },
  { re: /\bdispatchEvent\s*\(/, why: "派发合成事件" },
  { re: /\bscrollTo\s*\(|\bscrollBy\s*\(|scrollIntoView\s*\(/, why: "调用页面滚动接口" },
  { re: /\.focus\s*\(|\.blur\s*\(/, why: "聚焦/失焦（模拟交互）" },
  { re: /\.submit\s*\(/, why: "触发表单提交" },
  { re: /\.value\s*(?:[+\-*/%]=|=(?!=))/, why: "修改表单控件值（修改页面）" },
  { re: /innerHTML\s*=/, why: "修改页面 DOM" },
  { re: /\.appendChild\s*\(|\.removeChild\s*\(|\.insertBefore\s*\(/, why: "修改页面 DOM 结构" },
  { re: /\.setAttribute\s*\(/, why: "修改页面元素属性" },
  { re: /document\.write\s*\(/, why: "改写页面文档" },
  { re: /history\.(pushState|replaceState|back|forward)/, why: "修改页面历史记录" },
  { re: /location\s*=|location\.(href|assign|replace)\s*[=(]/, why: "修改页面地址" },
  { re: /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/, why: "发起网络请求" },
  { re: /\.animate\s*\(|requestAnimationFrame\s*\(/, why: "驱动页面动画" },
  { re: /\bsetInterval\s*\(/, why: "后台周期任务（无用户动作不得执行）" },
];

let failed = false;
const files = fs.readdirSync(CORE_DIR).filter(f => f.endsWith(".js"));

for (const file of files) {
  const full = path.join(CORE_DIR, file);
  const src = fs.readFileSync(full, "utf8");
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    // 跳过注释行：允许在注释中说明"禁止点击"等设计意图
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    for (const p of FORBIDDEN_PATTERNS) {
      if (p.re.test(code)) {
        failed = true;
        console.error(`[违反合规清单] ${file}:${i + 1}  ${p.why}`);
        console.error(`    ${line.trim()}`);
      }
    }
  });
}

if (failed) {
  console.error("\n静态扫描未通过：注入源文件包含禁止操作，请修正后重新构建。");
  process.exit(1);
} else {
  console.log(`静态扫描通过：${files.length} 个注入源文件均未出现禁止操作（${FORBIDDEN_PATTERNS.length} 条规则）。`);
}

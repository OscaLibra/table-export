/*
 * smoke.test.js — detect/extract 逻辑冒烟测试（jsdom 环境）
 *
 * 运行：NODE_PATH=<workspace>/node_modules node tests/smoke.test.js
 * 说明：jsdom 无真实布局引擎，测试中对 getClientRects 做最小 shim
 *       （保留 display:none 的可见性语义），仅用于验证逻辑正确性。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
let passed = 0, failedCnt = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failedCnt++; console.error("  ✗ " + msg); }
}

const html = fs.readFileSync(path.join(ROOT, "tests", "sample-page.html"), "utf8");
const dom = new JSDOM(html, { url: "http://localhost/sample.html", pretendToBeVisual: true, runScripts: "outside-only" });
const { window } = dom;

// ---- jsdom 布局 shim：模拟"未被 display:none 隐藏的元素有尺寸" ----
const origRects = window.Element.prototype.getClientRects;
window.Element.prototype.getClientRects = function () {
  const cs = window.getComputedStyle(this);
  if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") {
    return [];
  }
  return [{ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }];
};

// ---- 注入核心模块 ----
window.eval(fs.readFileSync(path.join(ROOT, "src", "core", "detect.js"), "utf8"));
window.eval(fs.readFileSync(path.join(ROOT, "src", "core", "extract.js"), "utf8"));

const tables = window.__TEX__.detect();
console.log(`检测到 ${tables.length} 张表格：`);
tables.forEach(t => console.log(`  - [${t.type}] ${t.name}  ${t.rowCount}行×${t.columnCount}列  隐藏列[${t.hiddenColumns}]`));

console.log("\n[用例] 样例1 原生静态表");
const basic = tables.find(t => t.name === "员工清单");
ok(!!basic, "找到『员工清单』");
if (basic) {
  ok(basic.rowCount === 3, `数据行 3（实际 ${basic.rowCount}）`);
  ok(basic.columnCount === 6, `列数 6（实际 ${basic.columnCount}）`);
  ok(basic.hiddenColumns.length === 1 && basic.hiddenColumns[0] === 2, "识别隐藏列（内部备注，索引 2）");
  const sel = [0, 1, 3, 4, 5];
  const r = window.__TEX_EXTRACT__.extract(basic.tableIndex ?? tables.indexOf(basic), sel, 0, 100);
  ok(!r.error, "提取无错误");
  ok(r.columns.join("|") === "工号|姓名|月薪|证件号|入职日期", "列名正确: " + r.columns.join("|"));
  const row0 = r.rows[0];
  ok(row0[0] === "0012", "前导零工号保留为文本『0012』");
  ok(row0[2] === "12,500.50", "千分位金额原样提取: " + row0[2]);
  ok(row0[3] === "110101199001011234", "长证件号原样提取");
  ok(r.warnings.length > 0, "返回警告信息");
}

console.log("\n[用例] 样例2 合并单元格");
const mergedByPos = tables.find(t => t.headers.some(h => String(h).includes("销售额")));
ok(!!mergedByPos, "找到合并单元格表");
if (mergedByPos) {
  ok(mergedByPos.columnCount === 4, `展平后列数 4（实际 ${mergedByPos.columnCount}）`);
  ok(mergedByPos.headers.join("|") === "区域-省份|区域-城市|销售额|同比", "多级表头展平: " + mergedByPos.headers.join("|"));
  const r2 = window.__TEX_EXTRACT__.extract(tables.indexOf(mergedByPos), [0, 1, 2, 3], 0, 100);
  ok(r2.rows[1][0] === "华东", "rowspan 值下穿：第 2 行第 1 列为『华东』（实际 " + r2.rows[1][0] + "）");
  ok(r2.rows[1][1] === "杭州", "第 2 行城市为『杭州』");
  ok(r2.rows[2][0] === "华北", "第 3 行为『华北』");
}

console.log("\n[用例] 样例3 语义网格 + aria-rowcount");
const grid = tables.find(t => t.type === "grid");
ok(!!grid, "识别 role=grid 语义网格");
if (grid) {
  ok(grid.name === "订单列表", "表名取自 aria-label: " + grid.name);
  ok(grid.rowCount === 2, `渲染行数 2（实际 ${grid.rowCount}）`);
  ok(grid.truncation && grid.truncation.kind === "virtual" && grid.truncation.totalRows === 1200,
    "截断标注：virtual，总行数 1200");
}

console.log("\n[用例] 样例4 分页容器提示");
const paged = tables.find(t => t.truncation && t.truncation.kind === "pagination");
ok(!!paged, "识别分页表格（truncation.kind=pagination）");
if (paged) {
  const rp = window.__TEX_EXTRACT__.extract(tables.indexOf(paged), [0, 1], 0, 100);
  ok(rp.warnings.some(w => w.includes("仅导出当前页")), "警告含『仅导出当前页』: " + rp.warnings[0]);
}

console.log("\n[用例] 样例5 可编辑单元格取控件值");
const editable = tables.find(t => /可编辑|项目/.test(t.name) || t.name.includes("表格 5") || t.name.includes("表格 4"));
const editTable = tables.find(t => {
  if (t.type !== "table") return false;
  return t.headers.join("|") === "项目|进度";
});
if (editTable) {
  const re = window.__TEX_EXTRACT__.extract(tables.indexOf(editTable), [0, 1], 0, 100);
  ok(re.rows[0][1] === "100%", "input 控件读取当前值（实际 " + re.rows[0][1] + "）");
} else {
  console.error("  ✗ 未找到可编辑表");
  failedCnt++;
}

console.log("\n[用例] 样例7 空表格不入清单");
ok(!tables.some(t => t.rowCount === 0), "零数据行表格已被排除");

console.log(`\n结果：${passed} 通过，${failedCnt} 失败`);
process.exit(failedCnt ? 1 : 0);

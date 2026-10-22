/*
 * exporter.test.js — 类型推断与 Excel 生成测试
 *
 * 浏览器 bundle（src/lib/exceljs.min.js）在 jsdom 窗口环境中执行，
 * 与弹窗页面环境同构；读回校验用 npm 的 Node 版 ExcelJS（等价于任意 xlsx 读取器）。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node tests/exporter.test.js
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

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "chrome-extension://abc/src/popup/popup.html",
  runScripts: "outside-only",
  pretendToBeVisual: true
});
const { window } = dom;

// 弹窗脚本依赖：ExcelJS 供应商化 bundle + exporter.js
window.eval(fs.readFileSync(path.join(ROOT, "src", "lib", "exceljs.min.js"), "utf8"));
window.eval(fs.readFileSync(path.join(ROOT, "src", "popup", "exporter.js"), "utf8"));
const EXP = window.__EXPORTER__;
ok(!!EXP, "exporter.js 在弹窗环境加载成功");
ok(!!window.ExcelJS, "ExcelJS 浏览器 bundle 挂载 window.ExcelJS");

/*
 * jsdom 专项：Node 上下文创建的数组是"跨域数组"，ExcelJS 内部的 instanceof
 * 判断会失败（真实弹窗中所有代码同域，不存在此问题）。测试统一通过
 * 窗口域内 JSON.parse 构造同域数组。
 */
window.eval("window.__buildWorkbookT = function(h, r, n) { return window.__EXPORTER__.buildWorkbook(JSON.parse(h), JSON.parse(r), n); }");
const buildT = (headers, rows, name) =>
  window.__buildWorkbookT(JSON.stringify(headers), JSON.stringify(rows), name);

console.log("[用例] 保守类型推断");
ok(EXP.inferCell("12,500.50") === 12500.5, "千分位金额 → 数值");
ok(EXP.inferCell("¥9,800") === 9800, "货币符号 → 数值");
ok(EXP.inferCell("15600") === 15600, "普通整数 → 数值");
ok(EXP.inferCell("0012") === "0012", "前导零编号保留文本: " + JSON.stringify(EXP.inferCell("0012")));
ok(EXP.inferCell("110101199001011234") === "110101199001011234", "17 位证件号保留文本（超 15 位）");
ok(EXP.inferCell("123456789012345") === 123456789012345, "15 位整数为数值");
ok(EXP.inferCell("2021-03-05") === "2021-03-05", "日期不做转换，保留文本");
ok(EXP.inferCell("+12%") === "+12%", "百分号混合串保留文本");
ok(EXP.inferCell("SO-2026-0001") === "SO-2026-0001", "混合串保留文本");
ok(EXP.inferCell("") === "", "空串");
ok(EXP.inferCell("  42 ") === 42, "首尾空格容错");

console.log("[用例] 文件名清洗");
ok(!/[\\/:*?"<>|]/.test(EXP.makeFilename('页面:标题*A/B', "表格<1>")), "非法字符被过滤");
ok(/\.xlsx$/.test(EXP.makeFilename("页面", "表格")), "以 .xlsx 结尾");
console.log("  示例: " + EXP.makeFilename("后台管理系统", "订单列表"));

console.log("[用例] Excel 生成（浏览器 bundle 真实构建）");
(async () => {
  const headers = ["工号", "姓名", "月薪", "证件号", "入职日期"];
  const rows = [
    ["0012", "张三", 12500.5, "110101199001011234", "2021-03-05"],
    ["0107", "李四", 9800, "110101199202022345", "2020-11-20"]
  ];
  const buf = await buildT(headers, rows, "员工清单");
  ok(buf && buf.byteLength > 4000, `文件体积合理（${buf.byteLength} 字节）`);
  const u8 = new Uint8Array(buf);
  ok(u8[0] === 0x50 && u8[1] === 0x4b, "产出为 zip 容器（PK 头）");

  // 读回验证（Node 版 ExcelJS，等价任意读取器）
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(buf));
  const ws = wb.worksheets[0];
  ok(ws.name === "员工清单", "工作表名正确: " + ws.name);
  ok(ws.rowCount === 3, `行数 1 表头 + 2 数据（实际 ${ws.rowCount}）`);
  ok(ws.getRow(1).getCell(1).value === "工号", "表头写入");
  ok(ws.getRow(1).font && ws.getRow(1).font.bold === true, "表头加粗");
  ok(ws.views && ws.views[0] && ws.views[0].state === "frozen" && ws.views[0].ySplit === 1, "冻结首行");
  ok(ws.getRow(2).getCell(1).value === "0012", "前导零工号以文本写入: " + JSON.stringify(ws.getRow(2).getCell(1).value));
  ok(ws.getRow(2).getCell(3).value === 12500.5, "金额以数值写入");
  ok(ws.getRow(2).getCell(4).value === "110101199001011234", "证件号以文本写入");
  ok(ws.getRow(2).getCell(1).type === ExcelJS.ValueType.String, "单元格类型为字符串（前导零保护）");
  ok(ws.getRow(2).getCell(3).type === ExcelJS.ValueType.Number, "金额单元格类型为数值");
  ok(ws.getColumn(3).width >= 8, "列宽自适应生效: " + ws.getColumn(3).width);

  console.log(`\n结果：${passed} 通过，${failedCnt} 失败`);
  process.exit(failedCnt ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

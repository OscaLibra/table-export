/*
 * exporter.js — Excel 生成模块（弹窗页面内执行，方案 4.4.4 / 4.4.5）
 *
 * 依赖：src/lib/exceljs.min.js（供应商化 ExcelJS 4.4.0，UMD 挂载 window.ExcelJS）
 * 约束：全部本地生成，不发起任何网络请求；下载走 Blob + 锚点，无需 downloads 权限。
 */
(function () {
  "use strict";

  /** 数值列宽采样上限 */
  var WIDTH_SAMPLE_ROWS = 50;
  var WIDTH_MIN = 8;
  var WIDTH_MAX = 50;

  /**
   * 保守类型推断（方案 4.4.3）：
   *  - 去除千分位分隔符与货币符号后为完整数字 → 数值单元格；
   *  - 带前导零、位数 > 15、混合字符 → 一律文本；
   *  - 日期时间不做自动转换，保留渲染文本。
   */
  function inferCell(raw) {
    if (raw == null) return "";
    var s = String(raw).trim();
    if (s === "") return "";
    // 去货币符号与空格、连续千分位
    var t = s.replace(/[¥￥$€\s]/g, "");
    var plain = /^[+-]?\d+(\.\d+)?$/.test(t);
    var grouped = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t);
    if (!plain && !grouped) return s;
    var num = t.replace(/,/g, "");
    var digits = num.replace(/[^0-9]/g, "");
    // 前导零保护（编号 001）：保留为文本
    if (/^[+-]?0\d/.test(num)) return s;
    // 超 15 位有效数字（证件号、卡号）：Excel 数值精度不足，保留为文本
    if (digits.length > 15) return s;
    var n = Number(num);
    if (!isFinite(n)) return s;
    return n;
  }

  /** 文件名非法字符过滤（Windows + 通用） */
  function sanitizeName(name) {
    return String(name || "")
      .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  }

  function makeFilename(pageTitle, tableName) {
    var ts = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    var stamp = ts.getFullYear() + p(ts.getMonth() + 1) + p(ts.getDate()) +
      "_" + p(ts.getHours()) + p(ts.getMinutes()) + p(ts.getSeconds());
    var parts = [sanitizeName(pageTitle), sanitizeName(tableName), stamp].filter(Boolean);
    return parts.join("_") + ".xlsx";
  }

  /** 估算显示宽度：CJK 记 2 */
  function displayWidth(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      w += s.charCodeAt(i) > 0xff ? 2 : 1;
    }
    return w;
  }

  /**
   * 构建工作簿：表头加粗 + 冻结首行 + 列宽自适应 + 数值列数值写入
   * @returns {Promise<ArrayBuffer>}
   */
  function buildWorkbook(headers, rows, sheetName) {
    var wb = new ExcelJS.Workbook();
    wb.creator = "表格导出 Excel";
    wb.created = new Date();

    var safeSheet = sanitizeName(sheetName || "数据").replace(/[\[\]\*\?\/\\:]/g, "");
    var ws = wb.addWorksheet(safeSheet.slice(0, 31) || "数据");

    // 表头（加粗）
    var headerRow = ws.addRow(headers.map(function (h) { return String(h); }));
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: "middle" };

    // 数据（类型推断后写入）
    rows.forEach(function (r) {
      ws.addRow(r.map(inferCell));
    });

    // 冻结首行（ExcelJS 视图使用 xSplit/ySplit 键名）
    ws.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

    // 列宽自适应（按采样字符数，限制在合理区间）。
    // 注意：ExcelJS 的 DEFAULT_COLUMN_WIDTH === 9，宽度恰为 9 的列会被当作
    // "默认宽度"而不写入 <cols>，故对 9 做微调以保证确定性输出（9.5 视觉上无差异）。
    for (var c = 1; c <= headers.length; c++) {
      var max = displayWidth(String(headers[c - 1]));
      var sample = Math.min(rows.length, WIDTH_SAMPLE_ROWS);
      for (var r2 = 0; r2 < sample; r2++) {
        var v = rows[r2][c - 1];
        if (v != null) max = Math.max(max, displayWidth(String(v)));
      }
      var w = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, max + 2));
      if (w === 9) w = 9.5;
      ws.getColumn(c).width = w;
    }

    return wb.xlsx.writeBuffer();
  }

  /** 触发浏览器标准下载（Blob 地址 + 锚点，用后即释放） */
  function downloadBuffer(buffer, filename) {
    var blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  window.__EXPORTER__ = {
    inferCell: inferCell,
    buildWorkbook: buildWorkbook,
    makeFilename: makeFilename,
    downloadBuffer: downloadBuffer
  };
})();

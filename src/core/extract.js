/*
 * extract.js — 数据提取模块（注入函数源，零依赖纯函数）
 *
 * 「仅导出已渲染数据」约束的执行者（方案 4.4.3 / 4.5）：
 *   - 只遍历渲染状态可见的行，行内优先读 innerText，可编辑控件读当前值；
 *   - 分页 / 懒加载 / 虚拟滚动场景不做任何补偿操作；
 *   - 禁止点击、滚动、派发事件、修改 DOM（对应 4.5.2 禁止清单，构建期扫描对象）。
 *
 * 对外接口（入参/返回值均可 JSON 序列化）：
 *   window.__TEX_EXTRACT__.extract(tableIndex, columns, rowStart, rowLimit)
 */
(function () {
  "use strict";

  if (window.__TEX_EXTRACT__ && window.__TEX_EXTRACT__._ready) return;

  function isVisibleEl(el) {
    if (!el || el.nodeType !== 1) return false;
    var cs;
    try { cs = window.getComputedStyle(el); } catch (e) { return false; }
    if (!cs || cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    var rects = el.getClientRects();
    return rects && rects.length > 0 && !(rects[0].width === 0 && rects[0].height === 0);
  }

  /** 单元格取值：可编辑控件读当前值，其余读可见文本（innerText 语义） */
  function readCellText(cell) {
    if (!cell) return "";
    var ctrl = cell.querySelector("input,select,textarea");
    if (ctrl) {
      var tag = ctrl.tagName;
      var type = (ctrl.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") return ctrl.checked ? "是" : "否";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
        if (!isVisibleEl(ctrl)) return "";
        return String(ctrl.value == null ? "" : ctrl.value);
      }
    }
    var t = cell.innerText;
    if (t == null) t = cell.textContent || "";
    return String(t).replace(/\u00a0/g, " ").trim();
  }

  function spanOf(cell, attrs) {
    for (var i = 0; i < attrs.length; i++) {
      var v = parseInt(cell.getAttribute(attrs[i]), 10);
      if (!isNaN(v) && v >= 1) return Math.min(v, 1000); // 防御异常大跨度
    }
    return 1;
  }

  function cellsOfRow(row, kind) {
    if (kind === "native") return Array.prototype.slice.call(row.cells || []);
    var out = [];
    var children = row.children || [];
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      var role = c.getAttribute("role");
      if (role === "cell" || role === "gridcell" || role === "columnheader" ||
          c.tagName === "TD" || c.tagName === "TH") out.push(c);
    }
    return out;
  }

  /** 按方案 4.5.3 生成截断/范围警告（数字优先原则） */
  function buildWarnings(t) {
    var warns = [];
    var n = t.dataRowEls.length;
    var tr = t.truncation;
    if (tr && tr.kind === "pagination") {
      var msg = "仅导出当前页 " + n + " 行";
      if (tr.totalRows) msg += "，共 " + tr.totalRows + " 行";
      warns.push(msg + "。如需更多数据，请自行翻页后再次导出，插件不会代替您翻页。");
    } else if (tr && tr.kind === "virtual") {
      warns.push("已渲染 " + n + " 行、共 " + tr.totalRows + " 行。插件只导出当前已渲染的行，可自行滚动加载后再次导出。");
    } else {
      warns.push("本次导出 " + n + " 行。若页面数据未完全加载，导出行数以页面当前显示为准。");
    }
    if (!t.hasHeader) warns.push("未识别到表头，已按“第 N 列”占位命名。");
    if (t.hiddenColumns.length) warns.push("检测到 " + t.hiddenColumns.length + " 个隐藏列，未包含在导出范围中。");
    return warns;
  }

  /**
   * 定位表格：优先复用 detect 阶段的扫描缓存（同一次用户手势内，
   * 页面 DOM 未变，序号严格一致且免去二次全页扫描）；缓存缺失或
   * 过期（>60s）时回退到重新扫描。
   */
  function locateTable(tableIndex) {
    var cache = window.__TEX__ && window.__TEX__._lastScan;
    if (cache && cache.tables && cache.tables.length &&
        (Date.now() - cache.at) < 60000 &&
        tableIndex < cache.tables.length) {
      return cache.tables[tableIndex];
    }
    var tables = window.__TEX__.scan();
    return tables[tableIndex];
  }

  /**
   * 提取已渲染数据（支持行区间分片，供大表分批回传）
   * @param {number} tableIndex scan() 结果序号
   * @param {number[]} columns  选中的列索引（升序，不含隐藏列）
   * @param {number} rowStart   起始数据行
   * @param {number} rowLimit   本批行数上限
   */
  function extract(tableIndex, columns, rowStart, rowLimit) {
    try {
      return extractInner(tableIndex, columns, rowStart, rowLimit);
    } catch (e) {
      // 页面侧任何异常都必须回传弹窗，绝不静默悬挂
      return {
        error: "exception",
        message: "提取过程发生异常：" + (e && e.message ? e.message : String(e)),
        detail: e && e.stack ? String(e.stack).split("\n").slice(0, 4).join(" | ") : ""
      };
    }
  }

  function extractInner(tableIndex, columns, rowStart, rowLimit) {
    var t0 = Date.now();
    var t = locateTable(tableIndex);
    try { console.debug("[表格导出] extract 定位耗时 " + (Date.now() - t0) + "ms, tableIndex=" + tableIndex + ", 缓存=" + !!(window.__TEX__ && window.__TEX__._lastScan)); } catch (ig) {}
    if (!t) return { error: "table_not_found", message: "表格定位失败，请重新打开插件。" };

    var total = t.dataRowEls.length;
    var start = Math.max(0, rowStart | 0);
    var end = Math.min(total, start + Math.max(1, rowLimit | 0));
    var cols = (columns || []).filter(function (c) { return c >= 0 && c < t.columnCount; });
    if (!cols.length) return { error: "no_columns", message: "未选择任何列。" };

    // 限制单次提取规模，防止消息体积失控
    if (end - start > 5000) end = start + 5000;

    var kind = t.kind;
    var carry = new Map(); // col -> { value, remaining }
    var rows = [];

    for (var r = start; r < end; r++) {
      var row = t.dataRowEls[r];
      if (!isElementVisibleTree(row)) continue; // 双重保险：仅导出可见行
      var cells = cellsOfRow(row, kind);
      var slots = new Array(t.columnCount).fill(null);
      var c = 0;

      // 先落上一行延续下来的 rowspan 值（值下穿填充）
      carry.forEach(function (p, col) {
        if (p.remaining > 0 && col < t.columnCount) slots[col] = { v: p.value, rs: 0 };
      });

      for (var i = 0; i < cells.length; i++) {
        while (c < t.columnCount && slots[c]) c++;
        if (c >= t.columnCount) break;
        var cell = cells[i];
        var cs = spanOf(cell, ["colspan", "aria-colspan"]);
        var rs = spanOf(cell, ["rowspan", "aria-rowspan"]);
        var v = readCellText(cell);
        for (var k = 0; k < cs && c + k < t.columnCount; k++) {
          slots[c + k] = { v: v, rs: k === 0 ? rs : 0, spanMark: k > 0 };
        }
        c += cs;
      }

      // 扣减延续计数，登记新出现的跨行单元格
      carry.forEach(function (p, col) { p.remaining--; if (p.remaining <= 0) carry.delete(col); });
      for (var col = 0; col < t.columnCount; col++) {
        var s = slots[col];
        if (s && s.rs > 1) carry.set(col, { value: s.v, remaining: s.rs - 1 });
      }

      rows.push(cols.map(function (ci) { return slots[ci] ? slots[ci].v : ""; }));
    }

    try { console.debug("[表格导出] extract 完成 rows=" + rows.length + ", 总耗时 " + (Date.now() - t0) + "ms"); } catch (ig) {}
    return {
      columns: cols.map(function (ci) { return t.headers[ci] || "第" + (ci + 1) + "列"; }),
      rows: rows,
      rowCount: total,
      warnings: buildWarnings(t)
    };
  }

  window.__TEX_EXTRACT__ = { _ready: true, extract: extract };

  function isElementVisibleTree(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      if (!isVisibleEl(node)) return false;
      node = node.host || node.parentElement;
    }
    return true;
  }
})();

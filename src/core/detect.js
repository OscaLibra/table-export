/*
 * detect.js — 表格检测模块（注入函数源，零依赖纯函数）
 *
 * 注入位置：内容脚本隔离环境（与页面 JS 互不可见）。
 * 设计约束（对应方案 4.5.2 允许操作清单）：本文件只允许读取 DOM
 * （文本、属性、计算样式、盒模型尺寸），禁止任何交互与修改操作。
 *
 * 对外接口：
 *   window.__TEX__.detect()            -> 可 JSON 序列化的表格描述数组
 *   window.__TEX__.scan()              -> 内部扫描结果（含元素引用，供 extract.js 使用，禁止外传）
 */
(function () {
  "use strict";

  if (window.__TEX__ && window.__TEX__._ready) return;

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  /** 深度查询：穿透 open 状态的 Shadow DOM（closed 无法访问，列入限制） */
  function deepQueryAll(rootEl, selector) {
    var out = [];
    var stack = [rootEl];
    while (stack.length) {
      var node = stack.pop();
      if (!node || !node.querySelectorAll) continue;
      try {
        out.push.apply(out, node.querySelectorAll(selector));
      } catch (e) { /* 无效选择器等，忽略 */ }
      // 递归 open shadow root（document 全序近似：栈实现为倒序，最终按出现顺序整理）
      var all = node.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) stack.push(all[i].shadowRoot);
      }
    }
    // 恢复文档顺序（querySelectorAll 本身有序，多 root 合并后去重排序）。
    // 比较器必须三态且自洽：相等返回 0，否则 V8 的 TimSort 可能行为未定义。
    out.sort(function (a, b) {
      if (a === b) return 0;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    // 去重
    var seen = new Set();
    return out.filter(function (el) {
      if (seen.has(el)) return false;
      seen.add(el);
      return true;
    });
  }

  /** 只读可见性判定：display/visibility/尺寸，零修改 */
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el instanceof HTMLInputElement && el.type === "hidden") return false;
    var cs;
    try { cs = window.getComputedStyle(el); } catch (e) { return false; }
    if (!cs || cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    var rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    if (rects[0].width === 0 && rects[0].height === 0) return false;
    return true;
  }

  function isElementVisibleTree(el) {
    // 元素自身及其祖先均需可见才算页面呈现
    var node = el;
    while (node && node.nodeType === 1) {
      if (!isVisible(node)) return false;
      node = node.host || node.parentElement; // 穿透 shadow host
    }
    return true;
  }

  function textOf(el) {
    return (el && (el.getAttribute("aria-label") || el.title || el.textContent || "")).trim();
  }

  /* ------------------------------------------------------------------ *
   * 网格展开（colspan / rowspan）—— 表头与数据共用的纯逻辑
   * ------------------------------------------------------------------ */

  /** 展开单元格跨度占位矩阵：occupancy[r][c] = { el, name } 或 null */
  function expandGrid(rowCellsList, colCountLimit) {
    var occupancy = [];
    var pending = []; // 行间 rowspan 延续：{ col, el, remaining }
    var maxCols = 0;

    rowCellsList.forEach(function (cells, r) {
      occupancy[r] = occupancy[r] || [];
      var c = 0;
      // 先落 rowspan 延续
      pending = pending.filter(function (p) { return p.remaining > 0; });
      var carried = pending.slice();
      carried.forEach(function (p) {
        occupancy[r][p.col] = { el: p.el, fromSpan: true };
        c = Math.max(c, p.col + 1);
      });

      for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        while (occupancy[r][c]) c++;
        var cs = parseInt(cell.getAttribute("colspan") || cell.getAttribute("aria-colspan") || "1", 10) || 1;
        var rs = parseInt(cell.getAttribute("rowspan") || cell.getAttribute("aria-rowspan") || "1", 10) || 1;
        if (colCountLimit) { cs = Math.min(cs, colCountLimit - c); if (cs <= 0) continue; }
        for (var k = 0; k < cs; k++) {
          occupancy[r][c + k] = { el: cell, fromSpan: k > 0 };
          if (rs > 1) pending.push({ col: c + k, el: cell, remaining: rs - 1 });
        }
        c += cs;
        maxCols = Math.max(maxCols, c);
      }
      // 本行结束后扣减
      pending.forEach(function (p) { p.remaining--; });
    });
    return { occupancy: occupancy, columnCount: maxCols };
  }

  /* ------------------------------------------------------------------ *
   * 表头识别与列名解析（三级优先，均失败用占位列名）
   * ------------------------------------------------------------------ */

  function looksLikeHeader(cells) {
    if (!cells.length) return false;
    var thCount = cells.filter(function (c) {
      return c.tagName === "TH" || c.getAttribute("role") === "columnheader";
    }).length;
    if (thCount === cells.length) return true;
    // 启发式：首行全为短文本（<=20 字），且不含纯数字单元格
    var shortText = cells.every(function (c) {
      var t = (c.innerText || c.textContent || "").trim();
      return t.length > 0 && t.length <= 20 && !/^[+-]?[\d,.¥￥$€%\s]+$/.test(t);
    });
    return shortText;
  }

  function placeholderHeaders(n) {
    var out = [];
    for (var i = 1; i <= n; i++) out.push("第" + i + "列");
    return out;
  }

  /** 由表头行集合解析单行列名（多级表头以 "-" 连接，有损展平） */
  function parseHeaders(headerRows) {
    if (!headerRows.length) return null;
    var cellsPerRow = headerRows.map(function (row) {
      return Array.prototype.slice.call(row.cells || row.children || []);
    });
    var expanded = expandGrid(cellsPerRow, null);
    var occ = expanded.occupancy;
    var colCount = expanded.columnCount;
    if (!colCount) return null;
    var names = [];
    for (var c = 0; c < colCount; c++) {
      var levels = [];
      for (var r = 0; r < occ.length; r++) {
        var slot = occ[r][c];
        if (!slot) continue;
        var t = (slot.el.innerText || slot.el.textContent || "").trim();
        if (t && levels.indexOf(t) === -1) levels.push(t);
      }
      names.push(levels.join("-") || "第" + (c + 1) + "列");
    }
    return { headers: names, columnCount: colCount, headerRowEls: headerRows };
  }

  /* ------------------------------------------------------------------ *
   * 截断检测（ARIA 标注优先，分页容器识别为辅；无标注不强猜）
   * ------------------------------------------------------------------ */

  function detectTruncation(root, renderedRows) {
    // 1) ARIA 行数标注
    var ariaCount = root.getAttribute("aria-rowcount");
    if (ariaCount) {
      var total = parseInt(ariaCount, 10);
      if (!isNaN(total) && total > 0 && total !== renderedRows) {
        return { kind: "virtual", renderedRows: renderedRows, totalRows: total };
      }
    }
    // 2) 常见分页导航容器（自身或祖先 3 层内可见）
    var SEL = '.pagination,.ant-pagination,.el-pagination,.vxe-pager,[class*="pagination"],[class*="pager"],[class*=" Paging"],nav[aria-label*="页"]';
    var node = root;
    for (var depth = 0; node && depth < 4; depth++) {
      var scope = node.parentElement || (node.host ? node.host : null);
      node = scope;
      if (!node || !node.querySelectorAll) break;
      var pagers = node.querySelectorAll(SEL);
      for (var i = 0; i < pagers.length; i++) {
        if (isElementVisibleTree(pagers[i])) {
          return { kind: "pagination", renderedRows: renderedRows, totalRows: null };
        }
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 表格扫描（detect 与 extract 共用的唯一定位来源，保证序号一致）
   * ------------------------------------------------------------------ */

  function collectCandidates() {
    var semanticRoots = deepQueryAll(document, '[role="table"],[role="grid"]').filter(function (el) {
      return isElementVisibleTree(el) && el.querySelectorAll('[role="row"],tr').length > 0;
    });
    function insideAny(el, list) {
      return list.some(function (root) {
        return root !== el && root.contains(el);
      });
    }
    // 语义根中去掉互相嵌套的（保留外层）
    var outerSemantic = semanticRoots.filter(function (el) { return !insideAny(el, semanticRoots); });
    // 原生表：外层优先，且不位于语义根内部
    var nativeTables = deepQueryAll(document, "table").filter(function (t) {
      if (!isElementVisibleTree(t)) return false;
      if (insideAny(t, outerSemantic)) return false;
      var p = t.parentElement;
      while (p) { if (p.tagName === "TABLE") return false; p = p.parentElement; }
      return true;
    });
    return outerSemantic.map(function (el) { return { kind: "grid", el: el }; })
      .concat(nativeTables.map(function (el) { return { kind: "native", el: el }; }));
  }

  function rowsOf(root, kind) {
    if (kind === "native") return Array.prototype.slice.call(root.rows || []);
    return deepQueryAll(root, '[role="row"],tr');
  }

  function cellsOf(row, kind) {
    if (kind === "native") return Array.prototype.slice.call(row.cells || []);
    return Array.prototype.slice.call(row.children).filter(function (c) {
      var role = c.getAttribute("role");
      return role === "cell" || role === "gridcell" || role === "columnheader" ||
        c.tagName === "TD" || c.tagName === "TH";
    });
  }

  function tableName(root, index, kind) {
    var cap = root.tagName === "TABLE" && root.caption ? root.caption.textContent.trim() : "";
    var label = root.getAttribute("aria-label") || "";
    var summary = root.getAttribute("summary") || "";
    var name = cap || label || summary;
    if (!name) {
      // 向上查找邻近标题
      var p = root.parentElement;
      while (p && !name) {
        var hs = p.previousElementSibling;
        for (var hop = 0; hs && hop < 3; hop++) {
          if (/^H[1-6]$/.test(hs.tagName || "")) { name = hs.textContent.trim(); break; }
          hs = hs.previousElementSibling;
        }
        p = p.parentElement;
      }
    }
    return name || (kind === "grid" ? "语义表格" : "表格") + " " + (index + 1);
  }

  function scanTables() {
    var cands = collectCandidates();
    var tables = [];
    cands.forEach(function (cand, index) {
      var root = cand.el, kind = cand.kind;
      var allRows = rowsOf(root, kind);
      if (!allRows.length) return;

      // 表头识别（三级）
      var headerRows = [];
      var dataRows = [];
      if (kind === "native" && root.tHead && root.tHead.rows.length) {
        headerRows = Array.prototype.slice.call(root.tHead.rows);
        dataRows = allRows.filter(function (r) { return !headerRows.includes(r); });
      } else {
        // 首行语义列头 / 启发式
        var firstCells = cellsOf(allRows[0], kind);
        if (firstCells.some(function (c) { return c.getAttribute("role") === "columnheader"; })) {
          // 连续的列头行全部并入表头
          var i = 0;
          while (i < allRows.length) {
            var cs = cellsOf(allRows[i], kind);
            if (cs.some(function (c) { return c.getAttribute("role") === "columnheader"; })) {
              headerRows.push(allRows[i]); i++;
            } else break;
          }
          dataRows = allRows.slice(headerRows.length);
        } else if (looksLikeHeader(firstCells) && allRows.length > 1) {
          headerRows = [allRows[0]];
          dataRows = allRows.slice(1);
        } else {
          dataRows = allRows;
        }
      }

      var headerInfo = parseHeaders(headerRows.map(function (r) {
        return { cells: kind === "native" ? Array.prototype.slice.call(r.cells || []) : cellsOf(r, kind) };
      }));

      // 兼容 grid 行对象（无 .cells）
      function cellsForRow(row) {
        return kind === "native" ? Array.prototype.slice.call(row.cells || []) : cellsOf(row, kind);
      }

      // 只统计渲染可见的数据行
      var visibleDataRows = dataRows.filter(isElementVisibleTree);
      var columnCount = headerInfo ? headerInfo.columnCount : 0;
      if (!columnCount) {
        columnCount = visibleDataRows.reduce(function (m, r) {
          return Math.max(m, cellsForRow(r).length);
        }, 0);
      }
      if (columnCount < 1 || visibleDataRows.length < 1) return;

      // 隐藏列：以列头单元格可见性判定（无表头时回退首行同位置单元格）
      var hidden = [];
      for (var cIdx = 0; cIdx < columnCount; cIdx++) {
        var headCell = headerRows.length ? cellsForRow(headerRows[0])[cIdx] : null;
        var probeCell = headCell;
        if (!probeCell && visibleDataRows.length) {
          var firstRowCells = cellsForRow(visibleDataRows[0]);
          probeCell = firstRowCells[cIdx] || null;
        }
        if (probeCell && !isVisible(probeCell)) hidden.push(cIdx);
      }

      var truncation = detectTruncation(root, visibleDataRows.length);

      tables.push({
        el: root,
        kind: kind,
        index: index,
        name: tableName(root, index, kind),
        headers: headerInfo ? headerInfo.headers : placeholderHeaders(columnCount),
        hasHeader: !!headerInfo,
        columnCount: columnCount,
        headerRowEls: headerRows,
        dataRowEls: visibleDataRows,
        allDataRowEls: dataRows,
        hiddenColumns: hidden,
        truncation: truncation
      });
    });
    return tables;
  }

  /** 可序列化检测结果（附录 B 结构） */
  function detect() {
    var scanned = scanTables();
    // 缓存本次扫描结果（含元素引用）：extract 直接复用，避免对同一页面
    // 重复全量扫描，且保证检测与提取的表格序号严格一致。
    // 缓存带时间戳，超过 60 秒或页面发生导航后由 extract 侧判断是否重建。
    window.__TEX__._lastScan = { at: Date.now(), tables: scanned };
    return scanned.map(function (t, i) {
      return {
        key: "t" + i,
        type: t.kind === "grid" ? "grid" : "table",
        name: t.name,
        headers: t.headers,
        columnCount: t.columnCount,
        rowCount: t.dataRowEls.length,
        hiddenColumns: t.hiddenColumns,
        hasHeader: t.hasHeader,
        truncation: t.truncation
      };
    });
  }

  window.__TEX__ = {
    _ready: true,
    scan: scanTables,     // 内部用：含元素引用，禁止跨边界传递
    detect: detect,       // 外部用：可 JSON 序列化
    _lastScan: null       // detect 时的扫描缓存，供 extract 复用
  };
})();

/*
 * popup.js — 弹窗主控（方案 4.2 / 4.3）
 *
 * 流程：注入核心模块 → 检测聚合 → 列选择（默认全选、隐藏列置灰）
 *       → 可选预览 → 分片提取 → ExcelJS 生成 → Blob 下载。
 * 全部数据流走扩展消息通道，不经过任何网络。
 */
(function () {
  "use strict";

  /* ---------- 常量（性能预算见方案 4.4.3，P0 实测后校准） ---------- */
  var CHUNK_ROWS = 2000;        // 单次提取分片行数
  var PREVIEW_ROWS = 10;        // 预览限行
  var CONFIRM_ROWS = 50000;     // 超过需确认
  var MAX_ROWS = 200000;        // 硬上限

  /* ---------- 状态 ---------- */
  var state = {
    tabId: null,
    pageTitle: "",
    tables: [],        // 聚合后的表格描述（附录 B 结构 + frameId/tableIndex）
    currentKey: null,
    selectedCols: new Set(),
    exporting: false
  };

  /* ---------- DOM ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    loading: $("state-loading"), error: $("state-error"), errMsg: $("error-msg"),
    main: $("state-main"), select: $("table-select"), meta: $("table-meta"),
    cols: $("column-list"), opAll: $("op-all"), opNone: $("op-none"),
    previewBox: $("preview-box"), previewBody: $("preview-body"),
    btnPreview: $("btn-preview"), btnExport: $("btn-export"),
    progress: $("progress-wrap"), fill: $("progress-fill"), progressText: $("progress-text"),
    status: $("status"), warnings: $("warnings"), pageTitle: $("page-title")
  };

  function showError(msg) {
    el.loading.classList.add("hidden");
    el.main.classList.add("hidden");
    el.error.classList.remove("hidden");
    el.errMsg.textContent = msg;
  }

  function setStatus(msg, kind) {
    el.status.textContent = msg || "";
    el.status.className = "status" + (kind ? " " + kind : "");
  }

  function showWarnings(list) {
    el.warnings.innerHTML = "";
    (list || []).forEach(function (w) {
      var d = document.createElement("div");
      d.className = "warn-item";
      d.textContent = w;
      el.warnings.appendChild(d);
    });
  }

  /* ---------- 注入与检测（两段式：文件注入 + 薄封装调用） ---------- */

  function getActiveTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve(tabs && tabs[0]);
      });
    });
  }

  /** 为 chrome.scripting 的 Promise 加超时兜底：永不落定时给出明确错误而非卡死 */
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error(label + " 超时（" + (ms / 1000) + " 秒）：页面可能过于繁忙或脚本执行被阻塞"));
        }, ms);
      })
    ]);
  }

  /** 安全执行 executeScript：同步异常与 Promise 拒绝统一转成 Error 抛出 */
  function execScriptSafe(options, label, timeoutMs) {
    try {
      return withTimeout(chrome.scripting.executeScript(options), timeoutMs || 20000, label);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  function injectCoreFiles() {
    return execScriptSafe({
      target: { tabId: state.tabId, allFrames: true },
      files: ["src/core/detect.js", "src/core/extract.js"]
    }, "注入核心模块", 20000);
  }

  function callDetectAllFrames() {
    return execScriptSafe({
      target: { tabId: state.tabId, allFrames: true },
      func: function () {
        try {
          return window.__TEX__ ? window.__TEX__.detect() : null;
        } catch (e) {
          return { detectError: "检测异常：" + (e && e.message ? e.message : String(e)) };
        }
      }
    }, "表格检测", 20000);
  }

  function callExtract(frameId, tableIndex, columns, rowStart, rowLimit) {
    var t0 = Date.now();
    diag("extract 开始 frame=" + frameId + " table=" + tableIndex + " cols=" + columns + " rows=" + rowStart + "+" + rowLimit);
    return execScriptSafe({
      // 注意：InjectionTarget 的属性是 frameIds（复数、数组），不存在单数 frameId
      target: { tabId: state.tabId, frameIds: [frameId] },
      func: function (i, c, s, l) {
        return window.__TEX_EXTRACT__
          ? window.__TEX_EXTRACT__.extract(i, c, s, l)
          : { error: "not_injected", message: "核心模块未注入。" };
      },
      args: [tableIndex, columns, rowStart, rowLimit]
    }, "数据提取", 20000).then(function (res) {
      diag("extract 返回，耗时 " + (Date.now() - t0) + "ms");
      return res && res[0] ? res[0].result : null;
    }, function (e) {
      diag("extract 失败：", e && e.message);
      throw e;
    });
  }

  /** 诊断日志：右键弹窗 → 检查，在弹窗控制台可见 */
  function diag() {
    if (state.debug !== false) {
      var args = Array.prototype.slice.call(arguments);
      args.unshift("[表格导出]");
      console.log.apply(console, args);
    }
  }

  function init() {
    getActiveTab().then(function (tab) {
      if (!tab || !tab.id) { showError("未找到活动标签页。"); return; }
      state.tabId = tab.id;
      state.pageTitle = tab.title || "";
      el.pageTitle.textContent = state.pageTitle;
      el.pageTitle.title = state.pageTitle;

      var url = tab.url || "";
      if (!/^(https?|file):/i.test(url)) {
        showError("当前页面类型不支持导出。\n浏览器内部页面（chrome:// 等）、应用商店等受限页面无法访问，请切换到普通网页后重试。");
        return;
      }

      injectCoreFiles().then(callDetectAllFrames).then(function (results) {
        aggregate(results || []);
      }).catch(function (e) {
        var detail = e && e.message ? "\n细节：" + e.message : "";
        showError("无法访问该页面（可能为浏览器受限页面，或需要授予文件访问权限）。" + detail + "\n请切换到普通网页后重新打开插件。");
      });
    });
  }

  /* ---------- 聚合与渲染 ---------- */

  function aggregate(frameResults) {
    // 某帧检测异常时优先呈现原因
    for (var k = 0; k < frameResults.length; k++) {
      var rr = frameResults[k] && frameResults[k].result;
      if (rr && rr.detectError) {
        el.loading.classList.add("hidden");
        showError("表格检测出现问题。\n" + rr.detectError + "\n请刷新页面后重开插件；若仍失败请反馈该提示文本。");
        return;
      }
    }

    state.tables = [];
    frameResults.forEach(function (fr) {
      var tables = fr.result;
      if (!tables || !tables.length) return;
      tables.forEach(function (t, i) {
        t.frameId = fr.frameId;
        t.tableIndex = i;
        t.key = "f" + fr.frameId + "-t" + i;
        state.tables.push(t);
      });
    });

    el.loading.classList.add("hidden");

    if (!state.tables.length) {
      showError("未发现可导出的表格。\n常见原因：页面由 canvas 绘制、表格内容尚未加载、或为无语义标注的自绘组件。可尝试滚动/切换页面后重开插件。");
      return;
    }

    el.main.classList.remove("hidden");

    // 表格下拉
    el.select.innerHTML = "";
    state.tables.forEach(function (t) {
      var opt = document.createElement("option");
      opt.value = t.key;
      opt.textContent = t.name + "（" + t.rowCount + " 行 × " + t.columnCount + " 列）";
      el.select.appendChild(opt);
    });
    el.select.onchange = function () { selectTable(el.select.value); };
    selectTable(state.tables[0].key);
  }

  function currentTable() {
    for (var i = 0; i < state.tables.length; i++) {
      if (state.tables[i].key === state.currentKey) return state.tables[i];
    }
    return null;
  }

  function addBadge(text, warn) {
    var b = document.createElement("span");
    b.className = "badge" + (warn ? " warn" : "");
    b.textContent = text;
    el.meta.appendChild(b);
  }

  function selectTable(key) {
    state.currentKey = key;
    var t = currentTable();
    if (!t) return;

    // 摘要徽标
    el.meta.innerHTML = "";
    addBadge(t.rowCount + " 行已渲染");
    addBadge(t.columnCount + " 列", t.columnCount > 60);
    if (t.hiddenColumns.length) addBadge(t.hiddenColumns.length + " 个隐藏列", true);
    if (t.truncation) {
      var label = t.truncation.kind === "pagination"
        ? "分页表格，当前页 " + t.truncation.renderedRows + " 行"
        : "已渲染 " + t.truncation.renderedRows + " 行 / 共 " + t.truncation.totalRows + " 行";
      addBadge(label, true);
    }
    if (!t.hasHeader) addBadge("未识别到表头", true);

    // 列清单（隐藏列置灰默认不选）
    state.selectedCols = new Set();
    el.cols.innerHTML = "";
    t.headers.forEach(function (name, idx) {
      var hidden = t.hiddenColumns.indexOf(idx) !== -1;
      var item = document.createElement("label");
      item.className = "col-item" + (hidden ? " disabled" : "");

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = String(idx);
      cb.disabled = hidden;
      if (!hidden) { cb.checked = true; state.selectedCols.add(idx); }
      cb.addEventListener("change", function () {
        if (cb.checked) state.selectedCols.add(idx);
        else state.selectedCols.delete(idx);
      });

      var idxSpan = document.createElement("span");
      idxSpan.className = "col-idx";
      idxSpan.textContent = String(idx + 1);
      var nameSpan = document.createElement("span");
      nameSpan.className = "col-name";
      nameSpan.textContent = hidden ? name + "（隐藏列）" : name;
      nameSpan.title = name;

      item.appendChild(cb);
      item.appendChild(idxSpan);
      item.appendChild(nameSpan);
      el.cols.appendChild(item);
    });

    el.previewBox.classList.add("hidden");
    el.previewBody.innerHTML = "";
    setStatus("");
    showWarnings([]);
  }

  function selectedColumnList() {
    return Array.from(state.selectedCols).sort(function (a, b) { return a - b; });
  }

  /* ---------- 预览 ---------- */

    el.btnPreview.addEventListener("click", function () {
      var t = currentTable();
      if (!t) return;
      var cols = selectedColumnList();
      if (!cols.length) { setStatus("请至少选择一列。", "err"); return; }
      el.btnPreview.disabled = true;
      setStatus("正在提取预览…");
      callExtract(t.frameId, t.tableIndex, cols, 0, PREVIEW_ROWS).then(function (r) {
        el.btnPreview.disabled = false;
        if (!r || r.error) { setStatus(describeFailure(r, "预览提取失败"), "err"); return; }
        renderPreview(r);
        setStatus("预览生成完毕，提取 " + r.rows.length + " 行。");
      }).catch(function (e) {
        el.btnPreview.disabled = false;
        setStatus(describeFailure(null, "预览提取失败", e), "err");
      });
    });

    /** 把各类失败（业务错误对象 / Promise 拒绝）转成可读文本 */
    function describeFailure(r, prefix, err) {
      if (r && r.error) {
        var msg = prefix + "：" + (r.message || r.error);
        if (r.detail) msg += "\n" + r.detail;
        return msg;
      }
      if (err && err.message) return prefix + "：" + err.message;
      return prefix + "，请重试。";
    }

  function renderPreview(result) {
    el.previewBox.classList.remove("hidden");
    el.previewBody.innerHTML = "";
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    result.columns.forEach(function (h) {
      var th = document.createElement("th");
      th.textContent = h;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    result.rows.forEach(function (row) {
      var tr = document.createElement("tr");
      row.forEach(function (v) {
        var td = document.createElement("td");
        td.textContent = v;
        td.title = v;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.previewBody.appendChild(table);
  }

  /* ---------- 导出 ---------- */

  el.btnExport.addEventListener("click", function () {
    if (state.exporting) return;
    var t = currentTable();
    if (!t) return;
    var cols = selectedColumnList();
    if (!cols.length) { setStatus("请至少选择一列。", "err"); return; }
    if (t.rowCount === 0) { setStatus("该表格当前没有可导出的数据行。", "err"); return; }
    if (t.rowCount > MAX_ROWS) {
      setStatus("已渲染行数 " + t.rowCount + " 行，超过单次导出上限 " + MAX_ROWS + " 行。\n建议缩小范围（如翻页后导出）再试。", "err");
      return;
    }

    var doExport = function () { runExport(t, cols); };
    if (t.rowCount > CONFIRM_ROWS) {
      showConfirm(
        "行数较大确认",
        "本次将导出 " + t.rowCount + " 行 × " + cols.length + " 列，预计需要数十秒，期间请保持弹窗开启。是否继续？",
        doExport
      );
    } else {
      doExport();
    }
  });

  function showConfirm(title, text, onOk) {
    var mask = document.createElement("div");
    mask.className = "confirm-mask";
    var box = document.createElement("div");
    box.className = "confirm-box";
    var h = document.createElement("h4"); h.textContent = title;
    var p = document.createElement("p"); p.textContent = text;
    var actions = document.createElement("div"); actions.className = "actions";
    var cancel = document.createElement("button"); cancel.className = "btn ghost"; cancel.textContent = "取消";
    var ok = document.createElement("button"); ok.className = "btn primary"; ok.textContent = "继续导出";
    cancel.onclick = function () { mask.remove(); };
    ok.onclick = function () { mask.remove(); onOk(); };
    actions.appendChild(cancel); actions.appendChild(ok);
    box.appendChild(h); box.appendChild(p); box.appendChild(actions);
    mask.appendChild(box);
    document.body.appendChild(mask);
  }

  function setProgress(done, total, label) {
    el.progress.classList.remove("hidden");
    var pct = total ? Math.round((done / total) * 100) : 0;
    el.fill.style.width = pct + "%";
    el.progressText.textContent = label + " " + pct + "%";
  }

  function runExport(t, cols) {
    state.exporting = true;
    el.btnExport.disabled = true;
    el.btnPreview.disabled = true;
    showWarnings([]);
    setStatus("正在提取已渲染数据…");

    var allRows = [];
    var warnings = [];
    var lastExtract = null;
    var total = t.rowCount;
    var start = 0;

    function resetButtons() {
      state.exporting = false;
      el.btnExport.disabled = false;
      el.btnPreview.disabled = false;
    }

    function fail(msg) {
      resetButtons();
      setStatus(msg, "err");
    }

    function finish() {
      if (!allRows.length) { fail("表格为空（零数据行），已阻止导出。"); return; }
      setProgress(0, 100, "生成");
      setStatus("正在生成 Excel 文件…");
      var headerNames = lastExtract
        ? lastExtract.columns
        : cols.map(function (i) { return t.headers[i] || "第" + (i + 1) + "列"; });
      window.__EXPORTER__.buildWorkbook(headerNames, allRows, t.name)
        .then(function (buffer) {
          var filename = window.__EXPORTER__.makeFilename(state.pageTitle, t.name);
          window.__EXPORTER__.downloadBuffer(buffer, filename);
          setProgress(100, 100, "完成");
          resetButtons();
          setStatus("已导出 " + allRows.length + " 行 × " + cols.length + " 列 → " + filename, "ok");
          showWarnings(warnings);
        })
        .catch(function (e) {
          fail("Excel 生成失败：" + (e && e.message ? e.message : "未知错误") + "\n建议减少行数后重试。");
        });
    }

    function nextChunk() {
      if (start >= total) { finish(); return; }
      var limit = Math.min(CHUNK_ROWS, total - start);
      callExtract(t.frameId, t.tableIndex, cols, start, limit).then(function (r) {
        if (!r || r.error) { fail(describeFailure(r, "提取失败")); return; }
        allRows = allRows.concat(r.rows);
        if (r.warnings && r.warnings.length) warnings = r.warnings; // 每批一致，取最后一次
        lastExtract = r;
        start += limit;
        setProgress(allRows.length, total, "提取");
        nextChunk();
      }).catch(function (e) { fail(describeFailure(null, "提取中断", e)); });
    }

    nextChunk();
  }

  /* ---------- 全选 / 清空 ---------- */
  el.opAll.addEventListener("click", function (e) {
    e.preventDefault();
    var boxes = el.cols.querySelectorAll("input[type=checkbox]:not(:disabled)");
    Array.prototype.forEach.call(boxes, function (cb) {
      cb.checked = true;
      state.selectedCols.add(Number(cb.value));
    });
  });
  el.opNone.addEventListener("click", function (e) {
    e.preventDefault();
    var boxes = el.cols.querySelectorAll("input[type=checkbox]");
    Array.prototype.forEach.call(boxes, function (cb) { cb.checked = false; });
    state.selectedCols.clear();
  });

  document.addEventListener("DOMContentLoaded", init);
})();

// @ts-nocheck —— 選框規則原樣搬過來，型別之後逐步補
'use strict';

/**
 * 配圖判定的規則本體：這一段旁白該配哪張圖（scoreImage）、圖上要框哪裡（findCell）。
 * 規則吃的全域知識（規則庫、股名表、記憶庫）由 createMatcher 的參數傳入，
 * 所以 auto-shot 的三種模式與測試共用同一份實作，不會長出第二套（2026-08-26 的顧慮）。
 *
 * 選框優先順序（findCell）：
 *   ⓪ 漲跌幅 → ① 數字 → ② 頁面重點區域（規則庫 regions）→ ②a 旁白點名的那一列
 *   → ②b 記憶庫（你標過的同型頁面）→ ③ 頁面標題 → ④ 該頁的第一個區域
 */

/**
 * @param {{
 *   regions: Record<string, any[]>, pageKeywords: Record<string, string[]>, stockNameList: string[],
 *   memory: { pages: Record<string, any>, pagesMulti: Record<string, any> }, memoryMode?: string,
 *   shotMemory: { mergeRuns: Function, memKeyOf: Function, pickForPhrase: Function },
 * }} ctx
 */
function createMatcher({ regions, pageKeywords, stockNameList, memory, memoryMode = 'single', shotMemory }) {
  const REGIONS = regions || {};
  const PAGE_KEYWORDS = pageKeywords || {};
  const STOCK_NAME_LIST = stockNameList || [];
  const MEMORY = memory;
  const SHOT_MEMORY_MODE = memoryMode;
  const SHOT_MEMORY = shotMemory;

  // OCR 相鄰字框合併成「詞」。實作在 video/pipeline/shot-memory.js —— 前台學東西的時候
  // 要用同一套合併結果去驗證學到的股名，兩邊各寫一份遲早會漂走。
  const RUNS = new WeakMap();
  function runsOf(img) {
    if (!RUNS.has(img)) RUNS.set(img, SHOT_MEMORY.mergeRuns(img.words));
    return RUNS.get(img);
  }

  /** 旁白這一段點名了哪些個股（照官方簡稱表比對，長的優先） */
  function stocksInText(text) {
    const out = [];
    for (const nm of STOCK_NAME_LIST) {
      if (!text.includes(nm)) continue;
      if (out.some((p) => p.includes(nm))) continue;   // 已被更長的名字涵蓋（台達電 vs 台達）
      out.push(nm);
    }
    return out;
  }

  /**
   * 旁白點名的個股，出現在這張圖的哪一列。
   * 排行榜／清單頁靠這個分辨「這一句在講表格裡的哪一行」——
   * 也是「同一種頁面兩張圖」（shot3 台積電 vs shot4 聯發科）唯一分得開的訊號。
   */
  function findNamedRow(text, img) {
    if (!STOCK_NAME_LIST.length) return null;
    const own = new Set(img.stockName ? namesOf(img) : []);
    for (const nm of stocksInText(text)) {
      if (own.has(nm)) continue;               // 本頁主角另有股名加分，不重複計
      for (const r of runsOf(img)) {
        const at = r.t.indexOf(nm);
        if (at < 0) continue;
        // 不看整條 run 的信心 —— 合併時只要黏到一個爛字（實測「人台積電」被拉到 39），
        // 整條就會被濾掉。比對的是官方簡稱，OCR 剛好拼出一個正確股名的機率極低，
        // 這份表本身就是防呆，所以只擋掉幾乎全錯的（<25）。
        const sub = subBox(r, at, nm.length);
        if (!sub || sub.c < 25) continue;
        return { name: nm, box: sub, line: r };
      }
    }
    return null;
  }

  /** 從合併後的 run 取出「第 at 個字起、共 len 個字」那幾個原始字框的外框 */
  function subBox(run, at, len) {
    let pos = 0; const hit = [];
    for (const p of run.parts || []) {
      const n = String(p.t).length;
      if (pos < at + len && pos + n > at) hit.push(p);
      pos += n;
    }
    if (!hit.length) return null;
    const x = Math.min(...hit.map((h) => h.x)), y = Math.min(...hit.map((h) => h.y));
    return {
      x, y,
      w: Math.max(...hit.map((h) => h.x + h.w)) - x,
      h: Math.max(...hit.map((h) => h.y + h.h)) - y,
      c: Math.max(...hit.map((h) => h.c)),
    };
  }

  /**
   * 旁白的百分比 → 圖上對應的那個百分比字框。
   * 為什麼要獨立一條：旁白講的是概數（「跌近4%」「上漲約1%」「漲逾7%」），圖上是
   * -3.77%、1.06%、7.35%，差距 5% 以上，findCell ① 的 1.5% 容差一定對不上。
   * 2026-08-21 使用者手工標的 8 個框，每一個都框在漲跌幅上，有 5 個卡在這裡。
   * 收斂條件：①同號（漲配漲、跌配跌）②差距在 1 個百分點或 25% 以內 ③取最接近的。
   * 有 row（旁白點名的那一列）時只在同一列找 —— 排行榜整頁都是百分比，不限列會亂框。
   */
  function findPercentCell(text, img, row) {
    const m = text.match(/(-?\d+(?:\.\d+)?)\s*[%％]/);
    if (!m) return null;
    let want = parseFloat(m[1]);
    if (!isFinite(want) || want === 0) return null;
    if (/跌|降|收黑|回檔|修正|走弱/.test(text) && want > 0) want = -want;
    // % 的字框常被 OCR 讀成「(5.06?%)」這種夾雜雜訊的樣子、信心也低，門檻放寬到 25
    let cand = (img.words || []).filter((w) => w.c >= 25 && /[%％]/.test(String(w.t)));
    if (row) {
      const cy = row.box.y + row.box.h / 2;
      cand = cand.filter((w) => Math.abs(w.y + w.h / 2 - cy) < Math.max(row.box.h, w.h) * 2.2);
    }
    const scored = cand.map((w) => {
      const s = String(w.t);
      const num = s.replace(/[^0-9.]/g, '');
      const v = parseFloat(num) * (/-|－/.test(s) ? -1 : 1);
      return { w, v };
    }).filter((o) => !isNaN(o.v) && o.v !== 0 && (o.v > 0) === (want > 0))
      .map((o) => ({ ...o, d: Math.abs(o.v - want) }))
      .filter((o) => o.d <= Math.max(1, Math.abs(want) * 0.25))
      .sort((a, b) => a.d - b.d);
    if (!scored.length) return null;
    const w = scored[0].w;
    return {
      cell: { x: w.x, y: w.y, w: w.w, h: w.h },
      cellText: (row ? row.name + '　' : '') + String(w.t).replace(/[()（）]/g, ''),
    };
  }

  /**
   * 你教過的「這一種頁面要框哪裡」。存的是**比例座標**，換機型／換解析度一樣對得上。
   * 只在前面所有規則都沒命中時才用 —— 它是「上次你怎麼框」的複製，不是這一句的證據。
   */
  function memoryCell(img, text) {
    const key = SHOT_MEMORY.memKeyOf(img);
    const IW = img.width || 1206, H = img.height || 2622;
    const R = (b) => ({
      x: Math.round(b.x * IW), y: Math.round(b.y * H),
      w: Math.round(b.w * IW), h: Math.round(b.h * H),
    });
    // SHOT_MEMORY=multi（.env 開關，預設 single = 原本行為）：
    // 同一種頁面你標過很多次，挑「這一句旁白」最像的那個框，而不是永遠給最後一次的。
    // 挑不到夠像的（分數 < 2）就退回下面原本的單筆行為，所以不會比現在差。
    if (SHOT_MEMORY_MODE === 'multi' && key) {
      const pick = SHOT_MEMORY.pickForPhrase(MEMORY.pagesMulti, key, text);
      if (pick && pick.cell) {
        return {
          cell: R(pick.cell),
          ...(pick.region ? { region: R(pick.region) } : {}),
          cellText: `你標過的位置（同型頁面已標 ${pick.total || pick.hits} 次，最像「${String(pick.phrase).slice(0, 8)}」）`,
          _fromMemory: true,
        };
      }
    }
    const m = key && MEMORY.pages[key];
    if (!m || !m.cell) return null;
    return {
      cell: R(m.cell),
      ...(m.region ? { region: R(m.region) } : {}),
      // 標籤不要用「上次那一段旁白」—— 這次講的是別檔股票，印出來會很錯亂
      //（實測跑出「南亞科那一段」被標成「華邦電漲逾5%」）。
      cellText: `你標過的位置（同型頁面已標 ${m.n || 1} 次）`,
      _fromMemory: true,
    };
  }

  /**
   * 找出「這段旁白講到、而且圖上真的有」的目標，回傳它在圖上的框。
   * 優先順序：① 數字（98.22 / 22.7）② 關鍵詞（融資、融券…找表頭）
   * 數字取最長的那個，避免框到不相干的小數字。
   */
  /** 從旁白讀「連N日／連三個月」的 N。阿拉伯數字與中文數字都認，上限 12 列避免框過大。 */
  function countFromText(text) {
    const CN = { 一: 1, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const unit = '(?:日|天|個月|月|週|周|季)';
    let m = text.match(new RegExp('連(?:續)?\\s*(\\d+)\\s*' + unit));
    if (m) return Math.min(parseInt(m[1], 10), 12);
    m = text.match(new RegExp('連(?:續)?\\s*([一二兩三四五六七八九十]+)\\s*' + unit));
    if (m) {
      const t = m[1];
      let n;
      if (t === '十') n = 10;
      else if (t.length === 2 && t[0] === '十') n = 10 + (CN[t[1]] || 0);
      else if (t.length === 2 && t[1] === '十') n = (CN[t[0]] || 0) * 10;
      else n = CN[t] || 0;
      if (n > 0) return Math.min(n, 12);
    }
    return 0;
  }

  function findCell(text, img, row) {
    const words = (img.words || []).filter((w) => w.c >= 40);
    // ⓪ 漲跌幅優先（2026-08-21 新增）。使用者手工標的框 8 個有 8 個框在漲跌幅上，
    //    而旁白講的是概數，下面 ① 的 1.5% 容差抓不到 —— 所以這條要排在數字比對之前。
    //    有 row 就只在那一列找，排行榜才不會框到別檔股票的漲跌幅。
    const pct = findPercentCell(text, img, row);
    if (pct) return pct;
    // ① 數字：用「數值」比對而不是字串，因為 App 常把 22.74% 顯示成 22.7、56.55 顯示成 56.5。
    //    容差 1.5%（等同四捨五入到小數第一位的誤差範圍）。
    const wordVals = words
      .map((w) => ({ w, v: parseFloat(String(w.t).replace(/,/g, '').replace(/[^0-9.]/g, '')) }))
      .filter((o) => !isNaN(o.v) && o.v > 0);
    // 千分位逗號要一起吃進來，否則「45,518」會被拆成 45 和 518（2026-08-12 實際踩到）。
    // 小數也要放行：漲幅 0.88% 這種小於 10 的數字同樣是重點。
    const nums = [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)]
      .map((m) => parseFloat(m[0].replace(/,/g, '')))
      .filter((v) => v > 0 && (v >= 10 || String(v).includes('.')))
      .sort((a, b) => b - a);
    for (const n of nums) {
      const hits = wordVals
        .map((o) => ({ ...o, d: Math.abs(o.v - n) / Math.max(o.v, n) }))
        .filter((o) => o.d <= 0.015)
        .sort((a, b) => a.d - b.d || b.w.c - a.w.c);
      if (hits.length) {
        const w = hits[0].w;
        return { cell: { x: w.x, y: w.y, w: w.w, h: w.h }, cellText: w.t };
      }
    }
    // ② 頁面重點區域：講到「融資」這種沒有明確數字的說法時，把該頁面對應的欄位捲上來。
    //    區域定義在 video/pipeline/app-locators.json 的 regions，用 OCR 找得到的欄位標題當錨點
    //    （不寫死座標）。這是讓「未來不用再客製」的關鍵：領域知識寫在規則庫裡一次就好。
    const H = img.height || 2622;
    const IW = img.width || 1206;
    for (const rg of REGIONS[img.page] || []) {
      if (!rg.keywords.some((k) => text.includes(k))) continue;
      // box 型別：OCR 讀不出欄位標題時改用相對比例（0~1）框住區域。
      // 例：大盤頁三個指數磚，OCR 只認得出「指數」兩字、分不出加權/櫃買/台指。
      if (rg.box) {
        const [x0, y0, x1, y1] = rg.box;
        return {
          cell: {
            x: Math.round(x0 * IW),
            y: Math.round(y0 * H),
            w: Math.round((x1 - x0) * IW),
            h: Math.round((y1 - y0) * H),
          },
          cellText: rg.name,
          region: rg.name,
          isColumn: false,
        };
      }
      // OCR 常把「融資餘額」拆成「融資」「餘額」兩框，所以錨點也接受前兩個字。
      // 先找圖片下半部（走勢圖底下的資料表），找不到再放寬到整張。
      const short = rg.anchor.slice(0, 2);
      let hits = words.filter((w) => w.t.includes(rg.anchor) && w.y > H * 0.35);
      if (!hits.length) hits = words.filter((w) => w.t.includes(short) && w.y > H * 0.35);
      if (!hits.length) hits = words.filter((w) => w.t.includes(rg.anchor));
      if (!hits.length) hits = words.filter((w) => w.t.includes(short));
      if (!hits.length) continue;
      // near：同一列右側附近要出現的字，用來分辨同名欄位
      //（OCR 把「融資餘額」「融資增減」都只認出「融資」，靠右邊的「餘」/「增」才分得開）
      if (rg.near) {
        const withNear = hits.filter((h) =>
          words.some(
            (w) =>
              w.t.includes(rg.near) &&
              Math.abs(w.y - h.y) < h.h * 1.2 &&
              w.x > h.x &&
              w.x - h.x < IW * 0.18
          )
        );
        if (withNear.length) hits = withNear;
        else continue; // 這個頁面沒有這一欄，換下一條規則
      }
      const a = hits.sort((a2, b2) => a2.y - b2.y)[0];

      // ── 混合模式（2026-08-12 使用者定案）──
      // 沒有明確數字時，框的不是「欄位標題那幾個字」（沒意義），而是「整欄」：
      // 從標題往下抓同一 x 範圍內的前幾列資料，用它們的外框當高亮區。
      // 列高由資料本身決定，所以不同頁面／不同機型都適用，不必寫死。
      // 列數：優先用旁白講的數量（「連9日增加」「連三個月成長」→ 框 9 列 / 3 列），
      // 沒講就用規則預設。這樣「連續九日都是紅的」才會整片被框起來（2026-08-12 使用者回報）。
      // 阿拉伯數字與中文數字都認（腳本常寫「連兩日」「連三個月」）。
      const rows = countFromText(text) || rg.rows || 3;
      const cx = a.x + a.w / 2;
      const halfW = Math.max(a.w / 2 + IW * 0.02, IW * 0.085);
      const below = words
        .filter((w) => w.y > a.y + a.h * 0.5 && Math.abs(w.x + w.w / 2 - cx) < halfW)
        .sort((p1, p2) => p1.y - p2.y);
      // 依 y 分列，取前 rows 列
      const picked = [];
      let lastY = -1;
      for (const w of below) {
        if (lastY < 0 || w.y - lastY > a.h * 0.6) {
          picked.push(w);
          lastY = w.y;
          if (picked.length >= rows) break;
        }
      }
      const all = [a, ...picked];
      const x0 = Math.min(...all.map((w) => w.x));
      const x1 = Math.max(...all.map((w) => w.x + w.w));
      const y0 = a.y;
      const y1 = Math.max(...all.map((w) => w.y + w.h));
      return {
        cell: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
        cellText: rg.name,
        region: rg.name,
        isColumn: true,
        wholePage: !!rg.wholePage,
      };
    }

    // ②a 旁白點名的那一列（排行榜／清單頁）。這一句沒講百分比時，框「整列」不是只框名字 ——
    //     使用者手動標的時候框的是那一列的漲跌幅，框整列才涵蓋得到。
    //     容差 1.6 個字高：實測排行榜同一列的股名 y538、漲跌幅 y588（視覺同列、OCR 差一截），
    //     而上下兩列相距 118px，1.6×49≈78 夾在中間，不會吃到隔壁列。
    if (row && row.box) {
      const cy = row.box.y + row.box.h / 2;
      const same = (img.words || []).filter((w) =>
        w.c >= 30
        && Math.abs(w.y + w.h / 2 - cy) < row.box.h * 1.6
        && w.x + w.w > row.box.x - IW * 0.03);
      const parts = same.length ? same : [row.box];
      const x0 = Math.min(...parts.map((w) => w.x)), y0 = Math.min(...parts.map((w) => w.y));
      const padX = Math.round(IW * 0.012), padY = Math.round(row.box.h * 0.3);
      return {
        cell: {
          x: x0 - padX, y: y0 - padY,
          w: Math.max(...parts.map((w) => w.x + w.w)) - x0 + padX * 2,
          h: Math.max(...parts.map((w) => w.y + w.h)) - y0 + padY * 2,
        },
        cellText: row.name + '（整列）',
        isColumn: false,
      };
    }

    // ②b 你教過的位置（data/shot-memory.json）。排在標題 fallback 之前 ——
    //     「你上次框哪裡」比「框個標題交差」精準得多。同型頁面用比例座標沿用。
    const mem = memoryCell(img, text);
    if (mem) return mem;

    // ③ 找不到更具體的目標 → 框「頁面標題」（族群名／股名），讓觀眾至少知道在看什麼。
    //    使用者定案：「找不到更具體的目標就顯示標題吧，像是 PCB族群頁 / 材料族群頁」。
    if (img.topicBox) {
      const b = img.topicBox;
      const padX = Math.round(IW * 0.03);
      const padY = Math.round(b.h * 0.35);
      return {
        cell: { x: b.x - padX, y: b.y - padY, w: b.w + padX * 2, h: b.h + padY * 2 },
        cellText: (img.topic || '標題') + (img.isStockPage ? '（框股名）' : '（頁面標題）'),
        region: 'title',
        isColumn: false,
      };
    }

    // ④ 再退一步：該頁面的第一個區域。
    //    否則會變成整張顯示 —— 橫式尤其不能這樣（使用者：「橫式怎麼還是會出現整張圖」）。
    //    有 wholePage 的頁面（清單頁 CTA）例外，那本來就該整張看。
    const primary = (REGIONS[img.page] || [])[0];
    if (primary && !primary.wholePage && primary.box) {
      const [x0, y0, x1, y1] = primary.box;
      return {
        cell: {
          x: Math.round(x0 * IW), y: Math.round(y0 * H),
          w: Math.round((x1 - x0) * IW), h: Math.round((y1 - y0) * H),
        },
        cellText: primary.name, region: primary.name, isColumn: false,
      };
    }
    if (primary && !primary.wholePage && primary.anchor) {
      const short = primary.anchor.slice(0, 2);
      let hits = words.filter((w) => w.t.includes(primary.anchor));
      if (!hits.length) hits = words.filter((w) => w.t.includes(short));
      if (hits.length) {
        const a = hits.sort((x, y) => x.y - y.y)[0];
        const rows = primary.rows || 3;
        const cx = a.x + a.w / 2;
        const halfW = Math.max(a.w / 2 + IW * 0.02, IW * 0.085);
        const below = words
          .filter((w) => w.y > a.y + a.h * 0.5 && Math.abs(w.x + w.w / 2 - cx) < halfW)
          .sort((p1, p2) => p1.y - p2.y);
        const picked = [];
        let lastY = -1;
        for (const w of below) {
          if (lastY < 0 || w.y - lastY > a.h * 0.6) {
            picked.push(w);
            lastY = w.y;
            if (picked.length >= rows) break;
          }
        }
        const all = [a, ...picked];
        return {
          cell: {
            x: Math.min(...all.map((w) => w.x)),
            y: a.y,
            w: Math.max(...all.map((w) => w.x + w.w)) - Math.min(...all.map((w) => w.x)),
            h: Math.max(...all.map((w) => w.y + w.h)) - a.y,
          },
          cellText: primary.name,
          region: primary.name,
          isColumn: true,
        };
      }
    }
    return null;
  }

  /**
   * 一張圖所有可能的股名寫法：主要股名 ＋ analyze 給的候選（含去掉左邊雜字的版本）。
   * 長的排前面 —— 「南亞科」比「亞科」精確，先試長的。
   */
  function namesOf(img) {
    const list = [img.stockName, ...(img.stockNameAlts || [])].filter(Boolean);
    return [...new Set(list)].sort((a, b) => b.length - a.length);
  }

  /**
   * 股名比對，回傳實際命中的那個寫法（沒中回 null）。
   *
   * 兩種 OCR 錯誤要分開處理：
   *  ① 左邊多吃一個字（友達 → 性友達）：analyze 已經把「去掉左邊 N 字」的版本一起存進
   *     stockNameAlts，這裡逐一比對 —— 腳本裡出現哪個，哪個就是真的。
   *     不在 analyze 階段猜，是因為「南亞科 → 亞科」砍了會更錯，只有腳本分得出來。
   *  ② 中間讀錯一個字（華邦電 → 華邦埋／華邦雷）：候選裡沒有正確寫法，只能模糊比對。
   *     3 個字以上才容許差 1 字；2 個字不放寬（群創/群益、台光/台泥 只差一字，會配到別檔）。
   * （2026-08-13 華邦電、2026-08-17 友達，各踩過一次，兩次都是整張圖沒被用到）
   */
  function nameMatch(text, img) {
    const names = typeof img === 'string' ? [img] : namesOf(img);
    for (const n of names) if (text.includes(n)) return n;      // ① 精確（含去雜字版本）
    const main = names.find((n) => n.length >= 3);              // ② 模糊，只對最長的那個
    if (!main) return null;
    for (let i = 0; i + main.length <= text.length; i++) {
      const seg = text.slice(i, i + main.length);
      if (!/^[一-鿿]+$/.test(seg)) continue;
      let diff = 0;
      for (let k = 0; k < main.length; k++) if (seg[k] !== main[k]) diff++;
      if (diff === 1) return seg;
    }
    return null;
  }

  function scoreImage(text, img) {
    let sc = 0; const why = [];
    const nameHit = img.stockName ? nameMatch(text, img) : null;
    if (nameHit) {
      sc += 10;
      why.push('股名' + nameHit + (img._nameFromCode ? `（代號${img.stockCode}查到的）` : ''));
    }
    // 旁白點名的個股就在這張圖的某一列（排行榜／清單頁）。權重比照股名 ——
    // 這是「兩張同型排行頁」唯一分得開的訊號（shot3 有台積電、shot4 有聯發科）。
    // 權重 8 < 股名的 10：同一句同時命中「個股頁的主角」與「排行榜的一列」時，
    // 要選個股頁（使用者實際就是這樣標的）。8 分也還是遠高於清單頁門檻 3。
    const row = findNamedRow(text, img);
    if (row) { sc += 8; why.push('圖上有' + row.name); }
    // 族群頁靠「主題」分辨（材料／散熱／PCB…），權重比照股名，
    // 否則三張長得一樣的族群頁會全部配到同一張。
    // 排行頁的主題是 OCR 讀左側反白格得來的，可能夾雜雜字（「噴發向上」→「噴發還向上」），
    // 所以整串比對之外，也接受 topicTerms 裡任一個詞命中。
    const topicHit =
      (img.topic && text.includes(img.topic)) ||
      (img.topicTerms || []).find((t) => text.includes(t));
    if (topicHit) { sc += 10; why.push('主題' + (typeof topicHit === 'string' ? topicHit : img.topic)); }
    if (img.stockCode && text.includes(img.stockCode)) { sc += 6; why.push('代號' + img.stockCode); }
    const kws = PAGE_KEYWORDS[img.page] || [];
    const hitKw = kws.filter((k) => text.includes(k));
    if (hitKw.length) { sc += 3 * hitKw.length; why.push('關鍵字' + hitKw.join('/')); }
    // 同樣支援千分位；比對時兩邊都去掉逗號，圖上可能寫 45518.07、旁白寫 45,518
    const nums = [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)]
      .map((m) => m[0].replace(/,/g, ''))
      .filter((n) => n.replace('.', '').length >= 3);
    const numHit = nums.filter((n) =>
      (img.words || []).some((w) => w.t.replace(/,/g, '').includes(n))
    );
    if (numHit.length) { sc += 2 * numHit.length; why.push('數字' + numHit.join('/')); }
    return { sc, why, row };
  }

  return { findCell, findNamedRow, findPercentCell, memoryCell, scoreImage, nameMatch, namesOf, stocksInText, countFromText, subBox, runsOf };
}

module.exports = { createMatcher };

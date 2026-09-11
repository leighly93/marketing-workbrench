import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';

/**
 * 截圖聚焦：所有版型共用的一套視覺語言。
 *
 * 行為（2026-08-12 使用者逐項定案）：
 *   - 連續使用同一張圖的片段合併成一個 run → **圖片全程不下畫面，只有黃框平滑移動**
 *   - 有明確數字 → 框那個數字；只有欄位概念 → 框整欄（列數可由旁白的「連N日」決定）
 *   - 圖片沒蓋到的地方壓深灰黑，不露出講者
 *   - wholePage（例：清單頁的 CTA）→ 整張顯示、不框不壓暗
 *
 * ⚠️ 2026-09-11 使用者定案改寫了**顯示區域（region）**的語意：
 *   「我拉出的顯示區域，就是要出現在畫面的顯示範圍內（上方 BAR 下方），
 *     所以拿到的圖不論直式橫式，都會依照我圈選的範圍出現在顯示範圍內。」
 *   → region 從「亮帶」變成**裁切框**：等比縮放後置中放進安全框（safeTop~safeBottom
 *     ×扣掉 margin 的可用寬），圈多大就看到多大，左右也跟著壓暗（以前只壓上下）。
 *   → 圈的範圍比安全框大就**縮小塞進去**（使用者：「我就是在圈選差不多範圍了」），
 *     不再像以前那樣維持原尺寸、任由上下被 BAR 與字幕切掉。
 *   → 縮放因此變成**逐格**的（同一張圖不同段可以圈不同範圍），不再是整個 run 一個常數。
 *   沒有 region、只有黃框的段落**行為完全不變**（維持滿寬 + 上下亮帶）。
 *
 * 座標來源是 OCR（scripts/analyze-app-images.js）＋規則庫（scripts/app-locators.json），
 * 全部相對於圖片本身，不寫死螢幕座標，所以換手機／解析度都適用。
 */

export type ShotBox = { x: number; y: number; w: number; h: number };

export type ShotCellSpec = {
  startSec: number;
  endSec: number;
  /**
   * 黃框：要圈起來強調的地方。有 cell 才會畫黃框、才會壓暗周圍。
   * ⚠️ 2026-08-17 起 cell 與 region 是兩件事（使用者指出來的設計錯誤）：
   *   只有 region → 捲到那個區域，不畫框、不壓暗
   *   只有 cell   → 捲到框的位置並畫框（＝以前的行為）
   *   兩者都有   → 捲到 region，框畫在 cell
   */
  cell?: ShotBox;
  /** 顯示區域：決定圖要捲到哪裡、放大多少。不畫任何框線。 */
  region?: ShotBox;
  cellText?: string;
  /**
   * true = 這個框是**人工拖出來的**。
   * 2026-09-07 起留白不再分人工／自動（見 SHOT_FOCUS.pad），這個欄位渲染端已經不看，
   * 只是計畫檔／timeline 還會帶著，留著不拔以免動到上游。
   */
  cellManual?: boolean;
  isColumn?: boolean;
  wholePage?: boolean;
};

export type ShotRun = {
  src: string;
  startSec: number;
  endSec: number;
  imageWidth?: number | null;
  imageHeight?: number | null;
  cells: ShotCellSpec[];
  /**
   * 由 markRunCuts() 標上（沒標＝undefined＝維持原本的淡入淡出）。
   *   cutIn  = 這個 run 開始的瞬間畫面上剛好有別的圖 → 不淡入，直接切進來
   *   cutOut = 這個 run 結束的瞬間下一張圖立刻接上 → 不淡出，直接讓出去
   * 2026-08-26 使用者：「連續出現圖片，中間圖片就不要做淡入跟淡出了」。
   */
  cutIn?: boolean;
  cutOut?: boolean;
};

export const SHOT_FOCUS = {
  /** 要框的目標落在畫面的這個高度（避開上方 header、下方字幕） */
  focusY: 760,
  /** 壓暗時，黃框上下各留多少亮區 */
  margin: 70,
  /** 帶外壓暗程度 */
  dim: 0.72,
  /** 顯示區域以外壓多黑：0.9＝九成黑（很暗但不是全黑、還隱約看得到圖），
      不做「真的裁切」。2026-08-18 使用者定案。 */
  regionDim: 0.9,
  /** 圖片外露處的底色：純黑，把講者/heygen 完全蓋掉（在圖片底下再墊一層黑）。 */
  backdrop: '#000000',
  /**
   * 黃框相對目標框的外擴（**畫面座標 px**，不乘 sc）—— 人工框、OCR 自動框一律同一個值。
   * 2026-09-07 使用者定案「所有黃框不論人工或 OCR 都用人工框那組」。
   * 在這之前自動框另有一組 26×18 **圖片座標** px（會再乘 sc）：同一個框在 720 寬截圖上
   * 放大 1.5 倍、1206 寬只有 0.9 倍，胖瘦跟截圖解析度綁在一起；而人工框的 `cellManual`
   * 旗標只在「計畫頁確認」那條路有補上、「直接出片」沒有，於是同一個人畫一樣大的框，
   * 成品有時胖有時瘦。收成單一畫面 px 之後這個分岔就不存在了。
   * 10 ≒ 720 寬截圖上的 6.7 圖片 px。三大法人（InstitutionComposition.tsx）同值。
   */
  pad: 10,
  highlight: '#FFE600',
  /** 整欄模式下，欄位頂端離聚焦線的距離 */
  columnTopOffset: 70,
  /** 換格時的移動時間（秒） */
  transitionSec: 0.35,
  /** run 開頭淡入（秒） */
  fadeInSec: 0.3,
  /** run 結尾淡出（秒）。2026-08-21 使用者要求補上 —— 在這之前圖片是硬切消失。
      跟三大法人（Institution/InstitutionComposition.tsx）同值，三條產線調性一致。 */
  fadeOutSec: 0.3,
  /**
   * 兩個 run 的間隔在這個秒數以內就算「連續出現」→ 中間不淡出也不淡入（見 markRunCuts）。
   * 0.4 秒 ≒ 一次淡出＋淡入的時間；比這更長的空檔是真的想讓講者露臉，該淡就淡。
   */
  cutGapSec: 0.4,
};

/** 一個 run＝連續使用同一張圖的整段時間。fps/畫布尺寸由呼叫端傳入，各版型可不同。 */
export const ShotFocusImage: React.FC<{
  run: ShotRun;
  width: number;
  height: number;
  fps: number;
  /** 只在畫面的某個橫向區間內作用（橫式用：左側講者可見區，右側品牌面板不能蓋） */
  region?: { x: number; width: number };
  /** 覆寫聚焦線位置（橫式畫布只有 1080 高，760 會太低） */
  focusY?: number;
  /** 圖片左右留白（橫式使用者定案 20px） */
  margin?: number;
  /** 黃框的安全區（畫面座標）：上避節目 header、下避字幕條。
      兩個都給才會生效 —— 沒給的版型（焦點股／投廣）行為完全不變。
      2026-08-25 使用者定案：「圖片大小要跟原本一樣，只是圖片上移」。 */
  safeTop?: number;
  safeBottom?: number;
}> = ({ run, width, height, fps, region, focusY: focusYProp, margin = 0, safeTop, safeBottom }) => {
  const rx = region ? region.x : 0;
  const rw = region ? region.width : width;
  const imgW = rw - margin * 2;
  const imgX = rx + margin;
  const focusY = focusYProp ?? SHOT_FOCUS.focusY;
  const frame = useCurrentFrame();
  // 淡入淡出。Remotion 不會把外層 Sequence 的長度傳進來，但 run 自己知道自己多長 ——
  // 呼叫端的 durationInFrames 就是拿同一組秒數算的，所以這裡重算不會對不上。
  // ⚠️ 算式要跟 ../timeline.ts frameSpan() 一致：「終點格 − 起點格」，不是 round((end−start)×fps)——
  //    兩種進位可能差 1 格，差了就是最後一格淡不到 0 或多一格全亮（2026-09-07）。
  // 段落很短時兩邊各讓一半，中間至少留一格全亮，不然會「淡入到一半就開始淡出」。
  // ⚠️ 終點是 lastFrame（＝長度 − 1），不是長度本身 —— 用後者的話淡出會在
  //    「畫面上根本不存在的那一格」才到 0，實際最後一格還有 11% 亮度，等於淡到一半被硬切。
  // ⚠️ budget 保證 fi + fo ≤ lastFrame − 1（中間至少一格全亮，關鍵影格也不會重複）。
  const runFrames = Math.max(1, Math.round(run.endSec * fps) - Math.round(run.startSec * fps));
  const lastFrame = Math.max(0, runFrames - 1);
  const budget = Math.max(0, lastFrame - 1);
  // 連續出現的圖之間不淡（2026-08-26）：前一張還蓋在畫面上／後一張立刻接上時，
  // 淡入淡出只會讓兩張同時半透明、講者從縫裡透出來 —— 直接硬切反而看得清楚。
  // ⚠️ 旗標是 markRunCuts() 標的，沒接那支的產線拿到 undefined＝行為完全不變。
  const wantFi = run.cutIn ? 0 : SHOT_FOCUS.fadeInSec;
  const wantFo = run.cutOut ? 0 : SHOT_FOCUS.fadeOutSec;
  const fi = Math.min(Math.round(wantFi * fps), Math.floor(budget / 2));
  const fo = Math.min(Math.round(wantFo * fps), budget - fi);
  const fadeStops: number[] = [];
  const fadeVals: number[] = [];
  if (fi > 0) { fadeStops.push(0, fi); fadeVals.push(0, 1); }
  else { fadeStops.push(0); fadeVals.push(1); }
  if (fo > 0) { fadeStops.push(lastFrame - fo, lastFrame); fadeVals.push(1, 0); }
  const appear = fadeStops.length > 1
    ? interpolate(frame, fadeStops, fadeVals, {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;

  // 有 cell（要畫黃框）或有 region（只是要捲到某處）都算有目標
  const withCell = run.cells.filter((c) => (c.cell || c.region) && !c.wholePage);

  // 沒有要框的東西，或只是「看一下 App」→ 整張顯示
  if (!run.imageWidth || !run.imageHeight || withCell.length === 0) {
    return (
      <AbsoluteFill style={{ opacity: appear }}>
        <div
          style={{
            position: 'absolute', left: rx, top: 0, width: rw, height,
            backgroundColor: SHOT_FOCUS.backdrop,
          }}
        />
        {/* ⚠️ 圖片一定要包在 AbsoluteFill 裡：CSS 繪製順序上，絕對定位的元素會蓋在
            靜態元素之上（與 DOM 順序無關）。直接放 <Img> 會被上面那層黑底蓋成全黑。 */}
        {/* 沒有要框的目標時的顯示方式：
              直式（margin=0、整個畫布）→ cover 滿版，使用者定案「圖片就讓它滿版放」
              橫式（有 margin/region）→ contain，完整放進左側可見區、不裁切 */}
        <div
          style={{
            position: 'absolute',
            left: imgX,
            top: margin,
            width: imgW,
            height: height - margin * 2,
          }}
        >
          <Img
            src={staticFile(run.src)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: margin > 0 ? 'contain' : 'cover',
            }}
          />
        </div>
      </AbsoluteFill>
    );
  }

  // 滿寬縮放：沒有 region 的段落沿用這個（＝改寫前的行為）。
  const sc = imgW / run.imageWidth;
  const T = SHOT_FOCUS.transitionSec;

  // 安全框：region 要被塞進這一塊。水平用已經扣過 margin 的可用寬，
  // 垂直用呼叫端給的 safeTop~safeBottom（沒給的版型＝整個畫布高，行為等同以前）。
  const boxX = imgX;
  const boxW = imgW;
  const boxY = safeTop != null && safeBottom != null && safeBottom > safeTop ? safeTop : 0;
  const boxH = safeTop != null && safeBottom != null && safeBottom > safeTop ? safeBottom - safeTop : height;

  // 定位以 region 為準（沒指定 region 才用黃框的位置 —— 也就是以前的行為）。
  // 黃框的幾何只在「這一格有 cell」時才有意義；沒有 cell 的格子 hasBox=false，
  // 框與壓暗都會淡出，但為了讓插值序列連續，幾何值沿用上一格。
  // 兩種「目標」語意分開（2026-08-18 使用者定案）：
  //   cell（黃框）＝強調某個數字：畫黃框、周圍「半透明」壓暗保留脈絡。
  //   region（顯示區域）＝只想看這一塊：不畫框、其餘「壓全黑」＝等於把畫面裁到這塊。
  // 兩者都會把圖捲到 focusY，差別在「畫不畫框」與「壓多黑」。
  let lastGeom: { left: number; top: number; width: number; height: number } | null = null;
  let lastBand: { bandTop: number; bandBot: number; bandLeft: number; bandRight: number } | null = null;
  const targets = withCell.map((c) => {
    // ── 有 region：圈的那塊等比縮放後置中放進安全框（2026-09-11 使用者定案）──
    // 縮放、水平位移、亮區四個邊全部由 region 決定，不走下面那套 focusY／夾取邏輯 ——
    // 位置是「算出來剛好在框裡」，不是「先擺再修」，所以那些夾取在這條路上是多餘的。
    if (c.region) {
      const s2 = Math.min(boxW / c.region.w, boxH / c.region.h);
      const rw2 = c.region.w * s2;
      const rh2 = c.region.h * s2;
      const bandLeft = boxX + (boxW - rw2) / 2;
      const bandTop = boxY + (boxH - rh2) / 2;
      const imgLeft = bandLeft - c.region.x * s2;
      const imgTop = bandTop - c.region.y * s2;
      const pad = SHOT_FOCUS.pad;
      const geomR = c.cell
        ? {
            left: imgLeft + c.cell.x * s2 - pad,
            top: imgTop + c.cell.y * s2 - pad,
            width: c.cell.w * s2 + pad * 2,
            height: c.cell.h * s2 + pad * 2,
          }
        : lastGeom || { left: imgLeft, top: bandTop, width: 0, height: 0 };
      if (c.cell) lastGeom = geomR;
      const bandR = { bandTop, bandBot: bandTop + rh2, bandLeft, bandRight: bandLeft + rw2 };
      lastBand = bandR;
      return {
        t: c.startSec - run.startSec,
        imgLeft,
        imgTop,
        imgWidth: run.imageWidth! * s2,
        hasBox: c.cell ? 1 : 0,
        dimA: SHOT_FOCUS.regionDim,
        ...geomR,
        ...bandR,
      };
    }
    const anchor = c.cell as ShotBox;
    const anchorY = c.isColumn
      ? anchor.y * sc + SHOT_FOCUS.columnTopOffset
      : (anchor.y + anchor.h / 2) * sc;
    let yoff = focusY - anchorY;
    // 黃框留白：畫面 px，人工／自動同值（2026-09-07 起不再看 cellManual，見 SHOT_FOCUS.pad）。
    const padX = SHOT_FOCUS.pad;
    const padY = SHOT_FOCUS.pad;
    // ── 黃框超出安全區才把圖推進來（2026-08-25 使用者定案）──
    // 只在「真的超出」時動，而且只動最小幅度 —— 沒超出就一格都不動。
    // 所以直式維持原樣（實測 0825 那支九段，直式八段完全不動、一段只被推 12px），
    // 壞掉的是橫式：畫布只有 1080 高，以 region 定位時黃框會被推到 y972~1091，
    // 整個掉出畫面又壓在字幕上（使用者：「橫式九秒的重點沒有出現在畫面中」）。
    // ⚠️ 一定要在算 geom／band 之前夾，三者共用同一個 yoff 才會一起移動。
    // ⚠️ 這裡開始是**沒有 region**的段落（只有黃框）。2026-09-11 之前另外有一段
    //    「顯示區域也要避開上方橫幅 bar」的夾取（0901 盤中焦點、0903 南亞科兩次回報），
    //    現在 region 是直接算進安全框的，那段夾取已經是多餘的二次修正，整段移除。
    if (c.cell && safeTop != null && safeBottom != null && safeBottom > safeTop) {
      const boxH = c.cell.h * sc + padY * 2;
      const boxTop = c.cell.y * sc - padY + yoff;
      let shift = 0;
      if (boxTop + boxH > safeBottom) shift = safeBottom - (boxTop + boxH);  // 太低 → 圖上移
      if (boxTop + shift < safeTop) shift = safeTop - boxTop;  // 太高、或框比安全區還高 → 上緣優先
      // ⚠️ 沒超出（shift === 0）就**一個字都不要動** —— 連下面那個保險也不要跑。
      //    不然本來就好好的段落會被順帶移動，就不是「只在超出時最小介入」了
      //    （實測：直式 shot3 會被保險往下推 444px，但它的黃框本來就在安全區內）。
      if (shift !== 0) {
        yoff += shift;
        // 圖往上推才可能讓下緣離開畫面、露出黑底 —— 只有這個方向要保險。
        // ⚠️ 往下推（shift > 0）時**不要**套這個保險：它只會讓圖片上方露出來，
        //    而那條上方黑帶是本來就存在、使用者定案「直式不用改」的東西；
        //    硬套的話直式 shot2 會被往下多推 463px、黃框反而掉到字幕底下（實測過）。
        if (shift < 0) {
          const imgH = (run.imageHeight || 0) * sc;
          if (imgH > height) yoff = Math.max(yoff, height - imgH);
        }
      }
    }
    // 黃框幾何（只有 cell 才有）
    const geom = c.cell
      ? {
          left: imgX + c.cell.x * sc - padX,
          top: c.cell.y * sc - padY + yoff,
          width: c.cell.w * sc + padX * 2,
          height: c.cell.h * sc + padY * 2,
        }
      : lastGeom || { left: imgX, top: focusY, width: 0, height: 0 };
    if (c.cell) lastGeom = geom;
    // 亮帶＝黃框範圍＋margin，上下壓暗。左右滿寬（bandLeft/bandRight 撐滿可用區）——
    // 這兩個欄位是 2026-09-11 為 region 的四邊裁切加的，在這條路上等於沒作用。
    const M = SHOT_FOCUS.margin;
    const band = c.cell
      ? { bandTop: c.cell.y * sc + yoff - M, bandBot: (c.cell.y + c.cell.h) * sc + yoff + M,
          bandLeft: rx, bandRight: rx + rw }
      : lastBand || { bandTop: 0, bandBot: height, bandLeft: rx, bandRight: rx + rw };
    lastBand = band;
    // 壓多黑：顯示區域壓全黑（裁掉其餘）；只有黃框時壓半透明（保留脈絡）。
    // 同樣 region 優先 —— 使用者圈了顯示區域就是「其餘不要露」。
    const dimA = c.cell ? SHOT_FOCUS.dim : 0;
    return {
      t: c.startSec - run.startSec,
      // 沒有 region 的段落：圖一律滿寬、貼左，只有垂直位移會變（＝改寫前的行為）。
      imgLeft: imgX,
      imgTop: yoff,
      imgWidth: imgW,
      hasBox: c.cell ? 1 : 0,
      dimA,
      ...geom, ...band,
    };
  });

  // 關鍵影格：在每一格停住，換格前 T 秒開始平滑移動過去
  const buildFrames = () => {
    const fr: number[] = [];
    targets.forEach((tg, i) => {
      if (i === 0) fr.push(0);
      else {
        const move = Math.max(fr[fr.length - 1] + 1, Math.round((tg.t - T) * fps));
        fr.push(move);
        fr.push(Math.max(move + 1, Math.round(tg.t * fps)));
      }
    });
    return fr;
  };
  const frames = buildFrames();
  type SeriesKey =
    | 'imgLeft' | 'imgTop' | 'imgWidth'
    | 'left' | 'top' | 'width' | 'height'
    | 'hasBox' | 'dimA'
    | 'bandTop' | 'bandBot' | 'bandLeft' | 'bandRight';
  const seriesOf = (key: SeriesKey) => {
    const vals: number[] = [];
    targets.forEach((tg, i) => {
      if (i === 0) vals.push(tg[key]);
      else {
        vals.push(targets[i - 1][key]);
        vals.push(tg[key]);
      }
    });
    return vals;
  };
  const at = (key: SeriesKey) => {
    const vals = seriesOf(key);
    return frames.length > 1
      ? interpolate(frame, frames, vals, {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : vals[0];
  };

  const img = { left: at('imgLeft'), top: at('imgTop'), width: at('imgWidth') };
  const box = { left: at('left'), top: at('top'), width: at('width'), height: at('height') };
  // 這一格到底有沒有黃框（0~1，換格時會淡入淡出）。
  // 「只指定顯示區域、不畫黃線」就是靠這個 —— 框與壓暗一起關掉
  //（2026-08-17 使用者：框出顯示區域跟拉黃線是兩件事，要分開）。
  const boxOpacity = at('hasBox');
  // 亮區（沒被壓暗的那一塊）：有 region 就是 region 落在畫面上的矩形（四邊都緊貼），
  // 沒有 region 就是黃框範圍＋margin、左右滿寬。壓多黑由 dimA 決定：
  //   顯示區域 0.9（很暗但不是全黑，2026-08-18 使用者定案）；黃框 0.72（保留脈絡）。
  let bandTop = at('bandTop');
  let bandBot = at('bandBot');
  const bandLeft = at('bandLeft');
  const bandRight = at('bandRight');
  const dimA = at('dimA');
  // 滑動出場時黃框那條帶也跟著移。單格 run 才會命中，而且只在「沒有 region」時 ——
  // 有 region 的話這裡會把算好的裁切框重新蓋成黃框範圍（0826 的 shot2 就是這樣被蓋掉的）。
  if (targets.length === 1 && withCell[0] && withCell[0].cell && !withCell[0].region) {
    bandTop = box.top - SHOT_FOCUS.margin;
    bandBot = box.top + box.height + SHOT_FOCUS.margin;
  }
  const dimColor = `rgba(11,13,18,${dimA})`;

  return (
    <AbsoluteFill style={{ opacity: appear }}>
      <div
        style={{
          position: 'absolute', left: rx, top: 0, width: rw, height,
          backgroundColor: SHOT_FOCUS.backdrop,
        }}
      />

      <div style={{ position: 'absolute', left: img.left, top: img.top, width: img.width }}>
        <Img src={staticFile(run.src)} style={{ width: img.width, display: 'block' }} />
      </div>

      {/* 壓暗：亮區以外的四塊。上下兩塊滿寬，左右兩塊只補亮區那一段高度。
          沒有 region 時 bandLeft/bandRight 就是可用區的左右緣 → 左右兩塊寬度 0，
          畫面跟 2026-09-11 改寫前完全一樣。 */}
      <div
        style={{
          position: 'absolute', left: rx, top: 0, width: rw,
          height: Math.max(0, bandTop), backgroundColor: dimColor,
        }}
      />
      <div
        style={{
          position: 'absolute', left: rx, top: bandBot, width: rw,
          height: Math.max(0, height - bandBot), backgroundColor: dimColor,
        }}
      />
      <div
        style={{
          position: 'absolute', left: rx, top: bandTop,
          width: Math.max(0, bandLeft - rx),
          height: Math.max(0, bandBot - bandTop), backgroundColor: dimColor,
        }}
      />
      <div
        style={{
          position: 'absolute', left: bandRight, top: bandTop,
          width: Math.max(0, rx + rw - bandRight),
          height: Math.max(0, bandBot - bandTop), backgroundColor: dimColor,
        }}
      />

      <div
        style={{
          position: 'absolute',
          left: box.left, top: box.top, width: box.width, height: box.height,
          border: `5px solid ${SHOT_FOCUS.highlight}`,
          borderRadius: 12,
          boxShadow: '0 0 16px 3px rgba(255,230,0,0.5)',
          boxSizing: 'border-box',
          opacity: boxOpacity,
        }}
      />
    </AbsoluteFill>
  );
};

/** 把「連續使用同一張圖」的片段合併成 run（間隔小於 gapSec 視為連續）。 */
export function buildShotRuns<
  T extends {
    src: string;
    startSec: number;
    endSec: number;
    cell?: ShotBox;
    region?: ShotBox;
    cellText?: string;
    cellManual?: boolean;
    isColumn?: boolean;
    wholePage?: boolean;
    imageWidth?: number | null;
    imageHeight?: number | null;
  }
>(shots: T[], gapSec = 2.0): ShotRun[] {
  const runs: ShotRun[] = [];
  for (const s of shots) {
    const cell: ShotCellSpec = {
      startSec: s.startSec,
      endSec: s.endSec,
      cell: s.cell,
      region: s.region,
      cellText: s.cellText,
      cellManual: s.cellManual,
      isColumn: s.isColumn,
      wholePage: s.wholePage,
    };
    // ⚠️ 2026-08-25：往回找「最近一個同一張圖的 run」，不是只看陣列裡的上一筆。
    // 為什麼：0825 大盤實測順序是 shot1(7.68~13.10) → shot6(7.68~9.60) → shot1(13.36~14.36)，
    // 中間插了一張別的圖，只比對上一筆就併不起來 → 兩段 shot1 各自淡入淡出，中間 0.26 秒空檔
    // 加上前後各 0.3 秒淡出淡入，畫面整整 0.9 秒露出講者（使用者：「圖片一直消失又出現」）。
    // 併進較早的 run 之後那個 run 會跨過中間那張圖，但陣列順序沒變 —— 後面的 run 畫在上層，
    // 所以中間那張圖照樣蓋著、時間到了才讓出來，底下這張全程不下畫面。
    let target: ShotRun | null = null;
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i].src === s.src) { target = runs[i]; break; }
    }
    if (target && s.startSec - target.endSec <= gapSec) {
      target.endSec = Math.max(target.endSec, s.endSec);
      target.cells.push(cell);
    } else {
      runs.push({
        src: s.src,
        startSec: s.startSec,
        endSec: s.endSec,
        imageWidth: s.imageWidth,
        imageHeight: s.imageHeight,
        cells: [cell],
      });
    }
  }
  return runs;
}

/**
 * 標出「連續出現」的相鄰 run，讓中間不要淡出又淡入（2026-08-26 使用者要求）。
 *
 * 病因：`buildShotRuns()` 只合併**同一張圖**。一句一張、每句都換圖的段落（0826 大盤那支
 * 八段全是不同圖）於是變成八個各自淡入 0.3s／淡出 0.3s 的 run，而段間空檔是 0.00 秒 ——
 * 前一張正在淡出、後一張同時在淡入，兩張都半透明、講者從縫裡透出來。實測「健策」那段
 * 只有 0.42 秒，扣掉 fade 只剩 2 格（0.07 秒）是全亮的，等於整段都看不清楚。
 *
 * 做法：間隔 ≤ gapSec 的兩個 run，前一個不淡出、後一個不淡入（硬切），
 * 一整串下來就是「第一張淡入 → 中間直接換 → 最後一張淡出」。
 * 空檔如果不是剛好 0，順手把前一張的結尾接到後一張的開頭 —— 留著洞的話硬切會讓
 * 講者閃個幾格，比淡入淡出更刺眼；`ShotFocusImage` 的幾何插值是 `extrapolateRight: 'clamp'`，
 * 延長只是讓最後一格的位置多停一下，不會位移。
 *
 * ⚠️ 只有「真的前後相接」才算。**時間重疊的兩個 run 不動**（例如 2026-08-25 批次 A 那種
 * 「同圖 run 跨過中間另一張圖」的疊層寫法）—— 那種情況底下本來就墊著另一張圖，
 * 淡入淡出是兩張圖之間的交叉淡化、不會露出講者，維持原樣。
 *
 * ⚠️ 這支是**選擇性接上**的：沒有經過它的 run 拿到 `cutIn/cutOut === undefined`，
 * 行為與改動前完全相同（投廣模板 `MarketingVideo.tsx`、焦點股都還沒接）。
 */
export function markRunCuts(runs: ShotRun[], gapSec = SHOT_FOCUS.cutGapSec): ShotRun[] {
  const out = runs.map((r) => ({ ...r }));
  /** 容許一點浮點誤差；比這更多的重疊就是真的疊層，不是「相接」。 */
  const EPS = 0.05;
  // 先用「原始秒數」把所有相接的配對找出來，最後才一次套用 ——
  // 邊找邊改 endSec 的話，後面的判斷會拿到已經被延長過的值。
  const pairs: { a: number; b: number; at: number }[] = [];
  out.forEach((a, i) => {
    let best = -1;
    let bestStart = 0;
    out.forEach((b, j) => {
      if (i === j) return;
      const gap = b.startSec - a.endSec;
      if (gap < -EPS || gap > gapSec) return;
      if (best < 0 || b.startSec < bestStart) { best = j; bestStart = b.startSec; }
    });
    if (best >= 0) pairs.push({ a: i, b: best, at: bestStart });
  });
  for (const p of pairs) {
    out[p.a].cutOut = true;
    out[p.b].cutIn = true;
    if (p.at > out[p.a].endSec) out[p.a].endSec = p.at;
  }
  return out;
}

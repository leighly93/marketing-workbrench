import React from 'react';
import { Composition } from 'remotion';
import './fonts'; // side-effect：載入 public/ 內的字體檔
import { MarketingVideo } from './MarketingVideo';
import {
  VIDEO_DURATION_SEC,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  secToFrame,
} from './timeline';
import { DapanComposition } from './DapanXiaobao/DapanComposition';
import { DapanLandscapeComposition } from './DapanXiaobao/DapanLandscapeComposition';
import {
  DAPAN_TOTAL_DURATION_SEC,
  DAPAN_LANDSCAPE_DURATION_SEC,
} from './DapanXiaobao/dapan-timeline';
import { InstitutionComposition } from './Institution/InstitutionComposition';
import { INSTITUTION_TOTAL_DURATION_SEC } from './Institution/institution-timeline';
import { FocusstockComposition } from './Focusstock/FocusstockComposition';
import { FOCUSSTOCK_TOTAL_DURATION_SEC } from './Focusstock/focusstock-timeline';
import { FocusstockAdComposition } from './Focusstock/FocusstockAdComposition';
import { MiddayFocusComposition } from './MiddayFocus/MiddayFocusComposition';
import { MIDDAY_TOTAL_DURATION_SEC } from './MiddayFocus/midday-timeline';
import { UsStockComposition } from './UsStock/UsStockComposition';
import { USSTOCK_TOTAL_DURATION_SEC } from './UsStock/usstock-timeline';
import { MotionClip } from './MotionClip/MotionClipComposition';
import {
  EXAMPLE_CONTRAST,
  EXAMPLE_LIST,
  EXAMPLE_QUOTE,
} from './MotionClip/motion-clip-examples';

/**
 * Remotion Root：在此註冊所有 Composition
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MarketingVideo"
        component={MarketingVideo}
        durationInFrames={secToFrame(VIDEO_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* 大盤小報：獨立 composition，跟 MarketingVideo 互不影響（詳見 99_封存/2026-09-10_第一批整理/舊說明與Agent紀錄/docs/tasks.md 第 3 節） */}
      <Composition
        id="DapanXiaobao"
        component={DapanComposition}
        durationInFrames={secToFrame(DAPAN_TOTAL_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* 大盤小報「橫式版型」：16:9（1920×1080），與直式共用 heygen/字幕/腳本、版面不同
          （無開場卡、講者左移、日期＋標題常駐右側面板）。詳見 99_封存/2026-09-10_第一批整理/舊說明與Agent紀錄/docs/tasks.md 第 3 節。 */}
      <Composition
        id="DapanXiaobaoLandscape"
        component={DapanLandscapeComposition}
        durationInFrames={secToFrame(DAPAN_LANDSCAPE_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={1920}
        height={1080}
      />
      {/* 盤中焦點：獨立直式 composition（2026-08-31 新增，照大盤小報直式複製一份）。
          ⚠️ 只有直式 —— 使用者定案「只出直式」，所以沒有橫式姊妹 composition。 */}
      <Composition
        id="MiddayFocus"
        component={MiddayFocusComposition}
        durationInFrames={secToFrame(MIDDAY_TOTAL_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* 美股焦點：獨立直式 composition（2026-09-15 新增，照盤中焦點複製一份、換自己的素材與座標）。
          ⚠️ 只有直式 —— 跟盤中焦點一樣沒有橫式姊妹 composition。 */}
      <Composition
        id="UsStock"
        component={UsStockComposition}
        durationInFrames={secToFrame(USSTOCK_TOTAL_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* 三大法人：獨立直式 composition（金橘版型、固定主播），跟大盤小報同模子但互不影響。 */}
      <Composition
        id="Institution"
        component={InstitutionComposition}
        durationInFrames={secToFrame(INSTITUTION_TOTAL_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* 焦點股日報：獨立直式 composition（藍色版型、固定主播），同模子互不影響。 */}
      <Composition
        id="Focusstock"
        component={FocusstockComposition}
        durationInFrames={secToFrame(FOCUSSTOCK_TOTAL_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* 焦點股日報「投廣套框版」：與客製版共用同一支 heygen/字幕，改套籌碼K線外框＋接片尾，
          無開頭。時長 = heygen + outro（= VIDEO_DURATION_SEC）。 */}
      <Composition
        id="FocusstockAd"
        component={FocusstockAdComposition}
        durationInFrames={secToFrame(VIDEO_DURATION_SEC)}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      {/* ── 動態小影片（MG）：獨立 render 成 mp4，再由 MotionOverlay 貼回各版型 ──
          三種型別（contrast／list／quote）、深藍＋黃、漲紅跌綠、零圖示素材。
          ⚠️ 尺寸＝**該版型整個可見畫面**，不是只有內容區 —— 背景有漸層與掃光，
             只鋪內容區的話光掃到邊界就斷掉。內容由 safeTop／safeBottom 限制在安全區內。
               直式 1080×1920（內容 y310–1440，避開招牌 bar 與字幕）
               橫式 1178×1080（內容 y0–918，避開右側面板與字幕）
          時長一律由 props.durationSec 決定（＝那段旁白的長度）。
          MotionClipDemo* 是 Studio 裡看長相用的 1080×1080 舊尺寸，不進產線。 */}
      <Composition
        id="MotionClip"
        component={MotionClip as React.FC<Record<string, unknown>>}
        durationInFrames={240}
        fps={VIDEO_FPS}
        width={1080}
        height={1080}
        defaultProps={{ spec: EXAMPLE_LIST, durationSec: 8 }}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(
            30,
            Math.round(((props as { durationSec?: number }).durationSec ?? 8) * VIDEO_FPS)
          ),
        })}
      />
      <Composition
        id="MotionClipDemoContrast"
        component={MotionClip as React.FC<Record<string, unknown>>}
        durationInFrames={VIDEO_FPS * 8}
        fps={VIDEO_FPS}
        width={1080}
        height={1080}
        defaultProps={{ spec: EXAMPLE_CONTRAST }}
      />
      <Composition
        id="MotionClipDemoList"
        component={MotionClip as React.FC<Record<string, unknown>>}
        durationInFrames={VIDEO_FPS * 12}
        fps={VIDEO_FPS}
        width={1080}
        height={1080}
        defaultProps={{ spec: EXAMPLE_LIST }}
      />
      {/* 2026-09-17：直式／橫式各一支，共用同一套佈局、各自填滿可用區 */}
      <Composition
        id="MotionClipListPortrait"
        component={MotionClip as React.FC<Record<string, unknown>>}
        durationInFrames={VIDEO_FPS * 12}
        fps={VIDEO_FPS}
        width={1080}
        height={1920}
        defaultProps={{ spec: EXAMPLE_LIST, safeTop: 310, safeBottom: 1440 }}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(
            30,
            Math.round(((props as { durationSec?: number }).durationSec ?? 12) * VIDEO_FPS)
          ),
        })}
      />
      <Composition
        id="MotionClipListLandscape"
        component={MotionClip as React.FC<Record<string, unknown>>}
        durationInFrames={VIDEO_FPS * 12}
        fps={VIDEO_FPS}
        width={1178}
        height={1080}
        defaultProps={{ spec: EXAMPLE_LIST, safeTop: 0, safeBottom: 918 }}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(
            30,
            Math.round(((props as { durationSec?: number }).durationSec ?? 12) * VIDEO_FPS)
          ),
        })}
      />
      <Composition
        id="MotionClipDemoQuote"
        component={MotionClip as React.FC<Record<string, unknown>>}
        durationInFrames={VIDEO_FPS * 6}
        fps={VIDEO_FPS}
        width={1080}
        height={1080}
        defaultProps={{ spec: EXAMPLE_QUOTE }}
      />
    </>
  );
};

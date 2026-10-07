// @ts-check
'use strict';

/**
 * 出片步驟記錄（_meta/steps.json）：產線 run.js 與工作台各自把「哪一步、何時、結果」寫進同一個檔，
 * 前台才畫得出進度條與「卡在哪一步」。
 *
 * 設計原則：
 *   - **只是記帳，絕不能讓產線死掉**：所有方法同步、永不丟出，fs 出錯一律吞掉。
 *   - 每次操作都「讀檔 → 改 → 整檔重寫」：run.js（子程序）與伺服器會交錯寫同一個檔，
 *     記憶體裡留一份的話後寫的會把先寫的整段蓋掉。
 *   - 原子寫入（先寫 .tmp 再 rename）：前台輪詢讀到一半的檔不會解析失敗。
 *   - 沒給檔名（手動在終端機跑 run.js）→ 空作業寫入器，呼叫端不用判斷。
 *
 * 檔案格式：{ version: 1, updatedAt, steps: [ { id, label, status, startedAt, endedAt, ms, attempt, error, note } ] }
 *   status：running → ok／warning／failed；另有 skipped（沒做）與 cancelled（人工取消）。
 *   同一個 id 可以出現多次（重試、退回確認再確認），attempt 從 1 起算。
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * @typedef {'running' | 'ok' | 'warning' | 'failed' | 'skipped' | 'cancelled'} StepStatus
 * @typedef {{ id: string, label?: string, status: StepStatus, startedAt: string, endedAt?: string, ms?: number,
 *   attempt: number, error?: string, note?: string }} StepEntry
 * @typedef {{ version: 1, updatedAt?: string, steps: StepEntry[] }} StepsFile
 * @typedef {{
 *   start: (id: string, options?: { label?: string, note?: string }) => void,
 *   end: (id: string, options: { ok: boolean, error?: string, note?: string }) => void,
 *   skip: (id: string, options?: { label?: string, note?: string }) => void,
 *   cancelRunning: (note?: string) => void,
 *   failRunning: (error?: string) => void,
 *   read: () => StepsFile,
 *   file: string | null,
 * }} StepsWriter
 */

/** 警告的約定：成功但備註以 ⚠️ 開頭 ＝ 非致命問題（例如自動配圖失敗但照樣出片）。 @param {string} [note] */
function isWarning(note) {
  return /^\s*⚠️/.test(String(note || ''));
}

/** @returns {StepsFile} */
function empty() {
  return { version: 1, steps: [] };
}

/**
 * @param {string | undefined | null} file steps.json 的完整路徑；空值 → 空作業
 * @param {Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync'>} [io]
 * @returns {StepsWriter}
 */
function createStepsWriter(file, io = fs) {
  if (!file) {
    const noop = () => {};
    return { start: noop, end: noop, skip: noop, cancelRunning: noop, failRunning: noop, read: empty, file: null };
  }
  const target = String(file);

  /** @returns {StepsFile} */
  function read() {
    try {
      if (!io.existsSync(target)) return empty();
      const parsed = JSON.parse(String(io.readFileSync(target, 'utf8')));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) return empty();
      return { version: 1, updatedAt: parsed.updatedAt, steps: parsed.steps.filter((/** @type {any} */ s) => s && typeof s.id === 'string') };
    } catch (_) {
      return empty();
    }
  }

  /** @param {StepsFile} data */
  function write(data) {
    try {
      io.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      io.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), steps: data.steps }, null, 2) + '\n');
      io.renameSync(tmp, target);
    } catch (_) { /* 記帳失敗不能影響出片 */ }
  }

  /** 讀 → 改 → 寫，整段包起來：任何一步出錯都不往外丟。 @param {(data: StepsFile) => void} mutate */
  function update(mutate) {
    try {
      const data = read();
      mutate(data);
      write(data);
    } catch (_) { /* 同上 */ }
  }

  /** @param {StepEntry[]} steps @param {string} id */
  const attemptOf = (steps, id) => 1 + steps.filter((s) => s.id === id).length;
  /** 最新一筆還在跑的同名步驟（從尾端找）。 @param {StepEntry[]} steps @param {string} id */
  const latestRunning = (steps, id) => [...steps].reverse().find((s) => s.id === id && s.status === 'running');
  /** @param {StepEntry[]} steps @param {string} id */
  const latestOf = (steps, id) => [...steps].reverse().find((s) => s.id === id);
  /** @param {StepEntry} entry @param {string} endedAt */
  function close(entry, endedAt) {
    entry.endedAt = endedAt;
    entry.ms = Math.max(0, Date.parse(endedAt) - Date.parse(entry.startedAt)) || 0;
  }

  return {
    file: target,
    read,
    start(id, { label, note } = {}) {
      update((data) => {
        /** @type {StepEntry} */
        const entry = { id, status: 'running', startedAt: new Date().toISOString(), attempt: attemptOf(data.steps, id) };
        if (label) entry.label = label;
        if (note) entry.note = note;
        data.steps.push(entry);
      });
    },
    end(id, { ok, error, note }) {
      update((data) => {
        const now = new Date().toISOString();
        const status = ok ? (isWarning(note) ? 'warning' : 'ok') : 'failed';
        let entry = latestRunning(data.steps, id);
        if (!entry) {
          // 人工取消是最後定論：伺服器已經把這步標成 cancelled，run.js 隨後被 SIGTERM 砍掉
          // 時回報的「失敗」不該再多記一筆（取消鍵按下去卻看到紅色的失敗）。
          const last = latestOf(data.steps, id);
          if (last && last.status === 'cancelled') return;
          entry = { id, status, startedAt: now, attempt: attemptOf(data.steps, id) };
          data.steps.push(entry);
        }
        entry.status = status;
        close(entry, now);
        if (error) entry.error = String(error);
        if (note) entry.note = String(note);
      });
    },
    skip(id, { label, note } = {}) {
      update((data) => {
        const now = new Date().toISOString();
        /** @type {StepEntry} */
        const entry = { id, status: 'skipped', startedAt: now, endedAt: now, ms: 0, attempt: attemptOf(data.steps, id) };
        if (label) entry.label = label;
        if (note) entry.note = note;
        data.steps.push(entry);
      });
    },
    cancelRunning(note) {
      update((data) => {
        const now = new Date().toISOString();
        for (const entry of data.steps) {
          if (entry.status !== 'running') continue;
          entry.status = 'cancelled';
          close(entry, now);
          if (note) entry.note = String(note);
        }
      });
    },
    failRunning(error) {
      update((data) => {
        const now = new Date().toISOString();
        for (const entry of data.steps) {
          if (entry.status !== 'running') continue;
          entry.status = 'failed';
          close(entry, now);
          if (error) entry.error = String(error);
        }
      });
    },
  };
}

module.exports = { createStepsWriter, isWarning };

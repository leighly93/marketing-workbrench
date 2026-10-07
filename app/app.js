// 工作台前台入口（<script type="module">）。功能都在 js/ 底下的模組裡；
// 這裡依原本的順序把它們載入（各模組在載入時掛上自己的按鈕事件），然後啟動。
import './js/dom.js';
import './js/arrows.js';
import './js/status.js';
import './js/form.js';
import './js/shell.js';
import './js/jobs-list.js';
import './js/job-detail.js';
import './js/annotations.js';
import './js/plan.js';
import './js/editor.js';
import './js/emphasis.js';
import './js/motion.js';
import './js/range.js';
import './js/say.js';
import './js/fix.js';
import { boot } from './js/shell.js';

// 版本標記：F12 開 Console 看到這行，就代表瀏覽器抓到的是最新版
console.log('%c大眾短影音出片工具 build 2026-08-21b（配圖記憶庫＋代號股名表＋漲跌幅比對＋舊分頁提示）', 'color:#1f6feb;font-weight:bold');
boot();

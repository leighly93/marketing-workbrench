import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// 測試放在程式旁邊（foo.js ↔ foo.test.js）；各區 tests/ 只留跨模組的整合測試。
// 前台的測試在檔案開頭加 `// @vitest-environment jsdom`，其餘預設 node。
// 前台是 Vue 單檔元件，所以這裡掛 @vitejs/plugin-vue（只有 app/ 的測試會 import .vue）。
export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'node',
    include: ['{app,server,video,shared,tools}/**/*.test.js'],
    exclude: ['**/node_modules/**', 'storage/**', 'tools/experiments/**', 'app/dist/**'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['app/src/**/*.{js,vue}', 'server/**/*.js', 'video/**/*.js', 'shared/**/*.js', 'tools/*.js'],
      exclude: ['**/*.test.js', '**/tests/**', 'video/remotion/**', 'server/deploy/**', 'tools/experiments/**', 'app/dist/**'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'storage/tmp/coverage',
    },
  },
});

import { defineConfig } from 'vitest/config';

// 測試放在程式旁邊（foo.js ↔ foo.test.js）；各區 tests/ 只留跨模組的整合測試。
// 前台的測試在檔案開頭加 `// @vitest-environment jsdom`，其餘預設 node。
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['{app,server,video,shared,tools}/**/*.test.js'],
    exclude: ['**/node_modules/**', 'storage/**', 'tools/experiments/**'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['app/**/*.js', 'server/**/*.js', 'video/**/*.js', 'shared/**/*.js', 'tools/*.js'],
      exclude: ['**/*.test.js', '**/tests/**', 'video/remotion/**', 'server/deploy/**', 'tools/experiments/**'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'storage/tmp/coverage',
    },
  },
});

# 批注回归测试

先执行 `npm ci` 和 `npm run build`。测试默认打开 `dist/index.html`，不使用外部旧版 HTML。

测试需要 Playwright 和 Chromium。可在本机安装 `playwright`，或通过 `PLAYWRIGHT_MODULE` 指向已有模块。
`CHROMIUM_PATH` 指向本机浏览器可执行文件。

PowerShell 示例：

```powershell
$env:PLAYWRIGHT_MODULE = 'C:/tools/node_modules/playwright'
$env:CHROMIUM_PATH = 'C:/tools/chrome/chrome.exe'
$env:ANNOTATION_SAMPLES = 'C:/test-projects'
npm run test:annotations
```

`ANNOTATION_SAMPLES` 目录需包含 `PCB布局布线测试` 和 `[五等分的花嫁]AI8051U彩色开发板` 两个工程目录。
未设置时使用项目的上级目录。工程数据不复制到仓库。
可以用 `ANNOTATION_HTML` 指定其他构建产物。
截图写入被 Git 忽略的 `qa/shots/annotations`。

- `smoke-test.cjs`：两个工程的加载与批注基本操作。
- `adversarial-test.cjs`：三个窗口尺寸、面板切换、编辑拖动、锁定与撤销。
- `dm-api-test.cjs`：同源 iframe、数据覆盖导入、变更通知与输入校验。
- `edge-cases-test.cjs`：草稿保护、回调重入与同路径工程重载。
- `wheel-test.cjs`：原理图和 PCB 的缩放对齐、文字背景比例和坐标不变性。
- `embed-test.cjs`：源码嵌入、API 调用和销毁清理。测试会启动临时 Vite 服务，并在结束后关闭。

测试会修改页面内的批注，不会修改输入工程文件。

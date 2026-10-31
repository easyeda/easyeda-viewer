# 开发指南(Development)

> easyeda-viewer 的开发、构建与测试说明。面向贡献者与二次集成开发者。
>
> 相关文档:[README](../README.md)(面向使用者)、[技术架构](ARCHITECTURE.md)、[PRD](PRD.md)、[集成 API](easyeda-viewer-api.md)、[更新日志](../CHANGELOG.md)。

## 1. 环境要求

- **Node.js** 18+ 与 npm(构建产物为单文件 `dist/index.html`)
- **Go** 1.22+(仅桌面版需要;构建脚本会自动切换到 `go1.20.14` 工具链以保留 Windows 7 支持)
- **Windows** 环境(仅桌面版;需要 `windres` 时可刷新图标与版本资源,缺失则使用仓库内置的 `.syso`)

## 2. 常用命令

```bash
npm install          # 安装依赖

npm run dev          # Vite 开发服务器,浏览器中拖入工程即可实时预览
npm run check        # TypeScript 类型检查(tsc --noEmit)
npm test             # Vitest 单元测试(test/parse.spec.ts)
npm run smoke        # 冒烟测试:headless 渲染全部样例文档
npm run build        # 类型检查 + 构建单文件 dist/index.html
npm run build:only   # 仅构建,不检查类型
```

| 脚本 | 说明 |
| --- | --- |
| `npm run dev` | Vite 开发服务器 |
| `npm run check` | `tsc --noEmit` |
| `npm test` | Vitest 单元测试 |
| `npm run smoke` | `vite-node -c vite.smoke.config.ts scripts/smoke.mjs`,校验全部样例文档可渲染 |
| `npm run build` | `tsc --noEmit && vite build` |
| `npm run build:only` | 只执行 `vite build` |

## 3. 测试与视觉回归

- **单元测试**:`test/parse.spec.ts` 覆盖容器识别、记录解析、工程树与文档打开;样例缺失时自动跳过。
- **冒烟测试**:`npm run smoke` 用 headless 浏览器打开每个样例文档,统计图元/图层/未知类型/占位符,任一文档抛错即失败。
- **视觉对照**:

```bash
npx vite-node -c vite.smoke.config.ts scripts/ref-diff.mjs
```

  渲染样例页并与官方客户端导出的 PNG 做像素 diff,输出到 `qa/diff/`(ours / ref / diff 图与 `report.json`)。

- **批注回归**:`npm run test:annotations`。

样例工程放在 `samples/`(本地目录,不入库);临时脚本与调试产物统一放在 `tmp/`(已 gitignore)。

## 4. 项目结构

```
easyeda-viewer/
├── dist/                  # 构建产物(单文件 index.html)
├── docs/                  # PRD、架构、集成 API、开发文档
├── desktop/               # Go + WebView2 桌面版
│   ├── main.go            # 桌面入口(内嵌 dist,本地 HTTP 加载)
│   ├── desktop_windows.go # Win32 窗口、DPI、WebView2 检测
│   ├── files.go           # 文件 / 目录读取桥接
│   ├── dialogs.go         # 原生文件对话框
│   ├── versioninfo.rc     # Windows 版本与图标资源
│   └── build/             # 构建出的 exe
├── qa/                    # 冒烟截图、ref-diff 输出、批注测试
├── samples/               # 本地样例工程(不入库)
├── scripts/               # 构建与测试脚本
│   ├── build-desktop.mjs  # 桌面版构建(标准版 + Win7 版)
│   ├── smoke.mjs          # 冒烟测试
│   ├── ref-diff.mjs       # 视觉对照回归
│   └── gen-icons.mjs      # 图标生成
├── src/
│   ├── main.ts            # 单文件应用入口(URL 参数 + postMessage)
│   ├── embed.ts           # JS 库入口 createViewer
│   ├── core/
│   │   ├── parse/         # 容器探测、行记录解析、Worker
│   │   ├── render/        # LeaferJS 场景渲染(SCH / PCB / PANEL)
│   │   └── ...
│   └── ui/                # 文档树、对象树、属性、图层、工具栏、i18n
├── test/                  # 单元测试
├── package.json
└── vite.config.ts
```

## 5. 桌面版构建

桌面版用 Go + [webview_go](https://github.com/webview/webview_go) 封装同一份 `dist/index.html`,通过本地 HTTP 服务加载,并提供原生文件对话框与拖放打开。

```bash
node scripts/build-desktop.mjs
```

脚本依次执行:vite 构建 → 复制到 `desktop/dist` → `windres` 刷新资源(可选)→ `go build`。产物有两个:

| 产物 | 工具链 | 适用系统 |
| --- | --- | --- |
| `desktop/build/easyeda-viewer_v{version}.exe` | 当前 Go 工具链 | Windows 10 / 11 |
| `desktop/build/easyeda-viewer_win7_v{version}.exe` | `go1.20.14` | Windows 7 SP1 x64 / 10 / 11 |

**Windows 7 说明**

- Go 1.21 起不再支持 Win7,因此 Win7 版固定使用 `go1.20.14` 构建(`GOTOOLCHAIN` 环境变量)。
- Win7 目标机需要 Windows 7 SP1 x64、通用 C 运行时(KB2999226)与 **WebView2 109**(最后一个支持 Win7 的运行时;更新的 Evergreen 运行时在 Win7 上不可用)。
- `SetThreadDpiAwarenessContext` / `GetDpiForWindow` 等 Win10 专属 API 在代码中做了运行时探测,缺失时回退 `GetDeviceCaps(LOGPIXELSX)`。
- 版本号变动时同步 `desktop/versioninfo.rc`(FileVersion / ProductVersion / OriginalFilename)。

## 6. 嵌入与集成

查看器提供两种嵌入方式,完整说明(加载、选中、批注、事件、语言主题、错误处理与安全注意事项)见 [集成 API](easyeda-viewer-api.md):

- **JS API**:`createViewer(host, options)` → `loadFiles` / `loadMap` / `open` / `fit` / `setTheme` / `setLang` / `setChrome` / `selectByDesignators` / `clearSelection` / `getModel` / `destroy`。
- **iframe + postMessage**:`load` | `open` | `fit` | `select` | `theme` | `chrome` | `lang`,查看器回发 `ready` / `load-ok` / `open-result` / `select-result` / `error`。
- **URL 参数**:`?theme=` `?lang=` `?file=` `?annotations=0` `?chrome=canvas` 等,详见集成文档 6.3 节。

```ts
import { createViewer } from './src/embed';

const viewer = createViewer(document.getElementById('host')!, {
  theme: 'light',
  lang: 'zh',
  chrome: { left: true, right: true, toolbar: true, status: true, annotations: true },
});

await viewer.loadFiles(Array.from(input.files));
await viewer.selectByDesignators(['R12', 'C3']);
```

## 7. 提交约定

- 提交信息用中文,一次提交聚焦一件事。
- 不提交 `samples/` 下的本地样例、`tmp/` 下的临时脚本与调试产物。
- 功能或行为变化同步更新 `CHANGELOG.md`,需求级说明登记到 `docs/PRD.md`。

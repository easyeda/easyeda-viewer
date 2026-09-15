# easyeda-viewer


一个轻量、离线、可嵌入的 **嘉立创EDA专业版 / EasyEDA Pro** 工程查看器。纯本地解析与渲染，文件无需上传，无需安装服务端，单个 HTML 文件双击即可使用。


---

## 核心特性

- **纯本地解析**：基于 `fflate` 与自定义行记录解码器，解析与渲染全程在浏览器内存完成，不联网、不上传。
- **单文件产物**：`npm run build` 生成 `dist/index.html`（约 334 kB，全部 JS/CSS 内联），双击打开或 iframe 嵌入均可。
- **多格式支持**：
  - `.eprj3` 文件夹工程（也接受打包成 `.zip` 的工程目录）
  - `.epro2` 单文件工程（标准 ZIP 容器）
  - 单个文档：`.esch2`、`.epcb2`、`.epan2`、`.esym2`、`.epru`
- **完整预览**：工程文档树、对象树、属性面板、LeaferJS 画布渲染（原理图 / PCB / 面板）。
- **双向定位**：点击对象树节点定位到画布，点击画布图元同步高亮对象树。
- **现代 UI**：深色 / 浅色双主题、中 / 英双语界面、可拖拽调整 / 隐藏各面板。
- **可嵌入 API**：`createViewer` JS API + `postMessage` 协议，方便集成到第三方页面。
- **可选桌面版**：Windows 免安装可执行文件（Go + WebView2，约 7 MB），支持原生对话框与拖放打开。

> 注意：v0.2 为**只读查看器**，不支持编辑、保存、DRC/ERC、BOM、3D 视图、Gerber 导出，也不支持 `.efp2` 文件。

---

## 支持格式

| 格式 | 说明 |
| --- | --- |
| `.eprj3`（文件夹） | 嘉立创EDA专业版文件夹化工程：`*.eprj3` 索引 JSON + `sch/`、`pcb/`、`panel/` 子目录 |
| `.zip`（工程包） | 将 `.eprj3` 文件夹整体打包后的 ZIP，查看器会自动解压并识别 |
| `.epro2` | 专业版传统单文件工程，内部为标准 ZIP，含 `project2.json`、`.epru` 记录流与 `IMAGE/*.webp` |
| `.esch2` | 单张原理图页（含仿真页） |
| `.epcb2` | 单个 PCB 文档 |
| `.epan2` | 单个面板文档 |
| `.esym2` | 单个符号文档 |
| `.epru` | 工程记录流（常见于 `.epro2` 解包后） |

---

## 快速开始

### 1. 直接使用单文件产物

```bash
npm install
npm run build
```

打开 `dist/index.html`：

- **双击打开**：将 `.eprj3` 文件夹、`.epro2`、`.zip` 或单个文档拖入画布即可查看。
- **HTTP 访问**：通过 `?file=<url>` 参数加载同源或 CORS 允许的文件（仅 http(s) 环境有效）。

### 2. 开发服务器

```bash
npm install
npm run dev
```

Vite 开发服务器启动后，在浏览器中拖入工程文件即可实时预览。

---

## 界面与交互

- **文档树**：左侧上层，展示工程 → Board → 原理图（含多页图页）/ PCB / 面板 / 仿真，节点可搜索过滤。
- **对象树**：左侧下层，按图元类型分组（元件、焊盘、走线、文本等），支持显隐开关与搜索。
- **属性面板**：右侧，点击画布图元后展开，展示关键属性（类型、位号、值、网络、图层、坐标等），属性名带中英翻译。
- **图层面板**：PCB / 面板文档的属性面板底部，列出文件内实际有图元的图层，带眼睛开关与图元计数。
- **画布**：
  - 滚轮缩放（以鼠标指针为中心）
  - 右键 / 中键 / 空格+左键拖拽平移
  - 左键点选图元，命中容差随缩放自适应
  - 工具栏：适应窗口、1:1、放大/缩小、可编辑缩放百分比
- **主题与语言**：工具栏可切换深色/浅色主题与中/英文界面；画布图元颜色始终遵循源文件原始配色。

---

## 嵌入使用

### JS API

```ts
import { createViewer } from './src/embed'; // 构建后也可从产物引入

const viewer = createViewer(document.getElementById('host'), {
  theme: 'light',          // 'light' | 'dark'
  lang: 'zh',              // 'zh' | 'en'
  chrome: { left: true, right: true, toolbar: true, status: true },
  onLoaded(model) { console.log('project loaded', model); },
  onSelect(obj) { console.log('selected', obj); },
  onError(err) { console.error(err); },
});

// 加载用户选择的文件
const input = document.getElementById('file');
input.addEventListener('change', () => {
  viewer.loadFiles(Array.from(input.files));
});

// 或通过路径→字节 map 加载（iframe / 服务端场景）
viewer.loadMap(new Map([['PCB1.epcb2', uint8Array]]));

// 按树节点 id 打开文档
viewer.open('node-id');

// 视图操作
viewer.fit();
viewer.setTheme('dark');
viewer.setLang('en');
viewer.setChrome({ right: false });

// 获取当前工程模型
const model = viewer.getModel();

// 销毁
viewer.destroy();
```

### iframe + postMessage

```html
<iframe id="viewer" src="dist/index.html?theme=light&lang=zh" width="100%" height="600"></iframe>
<script>
  const iframe = document.getElementById('viewer');

  // 加载文件（base64 编码，避免跨域 File 传递问题）
  function loadFile(name, base64) {
    iframe.contentWindow.postMessage({
      source: 'easyeda-viewer',
      cmd: 'load',
      files: [{ name, dataBase64: base64 }],
    }, '*');
  }

  // 监听查看器事件
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.source !== 'easyeda-viewer') return;
    if (msg.event === 'ready') console.log('viewer ready', msg.version);
    if (msg.event === 'load-ok') console.log('loaded files:', msg.count);
    if (msg.event === 'error') console.error(msg.message);
  });
</script>
```

支持的 `cmd`：`load` | `open` | `fit` | `theme` | `chrome` | `lang`。 viewer 会回发 `ready` / `load-ok` / `open-result` / `error` 事件。

### URL 参数

在 `dist/index.html` 或 iframe `src` 后追加：

| 参数 | 说明 |
| --- | --- |
| `?theme=light\|dark` | 界面主题，默认 `light` |
| `?lang=zh\|en` | 界面语言，默认 `zh` |
| `?toolbar=0&left=0&right=0&status=0` | 单独隐藏工具栏 / 左侧面板 / 右侧面板 / 状态栏 |
| `?chrome=canvas` | 隐藏所有面板，仅保留画布 |
| `?file=<url>` | http(s) 环境下加载远程文件 |

---

## Windows 桌面版

`desktop/` 目录下是一个基于 Go + [webview_go](https://github.com/webview/webview_go) 的免安装 Windows 可执行文件，内嵌 `dist/index.html`，通过本地 HTTP 服务加载。

构建产物：`desktop/build/easyeda-viewer.exe`（约 4 MB，依赖本机 WebView2 运行时）。

### 构建桌面版

前置要求：

- [Go](https://go.dev/) 1.22+
- Windows 环境
- 可选：`windres`（MinGW 资源编译器，用于更新图标与版本信息；无则使用仓库内置的 `rsrc_windows_amd64.syso` 兜底）

```bash
npm run build              # 先构建单文件 viewer
node scripts/build-desktop.mjs
```

构建完成后打开 `desktop/build/easyeda-viewer.exe`，即可通过原生对话框或拖放打开工程。

---

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 类型检查
npm run check

# 运行单元测试
npm test

# 运行冒烟测试（headless 截图对比）
npm run smoke

# 构建产物（dist/index.html）
npm run build

# 仅构建不检查类型
npm run build:only
```

### 常用脚本说明

| 脚本 | 说明 |
| --- | --- |
| `npm run dev` | Vite 开发服务器 |
| `npm run build` | `tsc --noEmit && vite build`，生成 `dist/index.html` |
| `npm test` | Vitest 单元测试 |
| `npm run smoke` | `vite-node -c vite.smoke.config.ts scripts/smoke.mjs` |
| `npm run check` | TypeScript 类型检查 |

---

## 项目结构

```
easyeda-viewer/
├── dist/                  # 构建产物（单文件 dist/index.html）
├── docs/                  # PRD 与格式文档
│   └── PRD.md             # v0.2 产品需求文档（功能权威说明）
├── desktop/               # Go + WebView2 桌面版源码
│   ├── main.go            # 桌面入口
│   ├── files.go           # 文件/目录读取桥接
│   ├── dialogs.go         # 原生文件对话框
│   ├── versioninfo.rc     # Windows 版本与图标资源
│   └── build/             # 构建出的 .exe
├── samples/               # 本地测试工程（不入库发布）
│   ├── RA6E2-eprj3/       # 文件夹工程样例
│   ├── RA6E2-epro2/       # 单文件工程样例
│   ├── png/               # 参考渲染截图
│   └── ...
├── qa/                    # 冒烟测试与截图
│   ├── shots/             # 界面截图
│   └── viewer.html        # QA 测试页
├── scripts/               # 构建与测试脚本
│   ├── build-desktop.mjs  # 桌面版构建
│   ├── smoke.mjs          # 冒烟测试
│   └── gen-icons.mjs      # 图标生成
├── src/
│   ├── main.ts            # 单文件应用入口（含 postMessage 桥接）
│   ├── embed.ts           # JS 库入口（createViewer）
│   ├── core/
│   │   ├── parse/         # 工程容器探测、行记录解析、Worker
│   │   ├── render/        # LeaferJS 场景渲染（SCH/PCB/PANEL）
│   │   └── ...
│   └── ui/                # 文档树、对象树、属性面板、工具栏、i18n
├── package.json
├── vite.config.ts
└── LICENSE
```

---

## 截图

参考渲染截图位于 `samples/png/` 与 `qa/shots/`：

- `samples/png/PCB_PCB1_2026-09-14.png` — PCB 渲染
- `samples/png/Panel1_2026-09-14.png` — 面板渲染
- `samples/png/Schematic1/SCH_Schematic1_1-P1_2026-09-14.png` — 原理图渲染
- `qa/shots/welcome-light.png` — 起始页（浅色）
- `qa/shots/pcb.png` / `qa/shots/pcb-dark.png` — PCB 预览
- `qa/shots/canvas-only.png` — 纯画布模式

---

## 免责声明与商标

- 本项目仅用于本地预览已导出的工程文件，不会修改或回写任何源文件。

---

## 许可证

[Apache License 2.0](LICENSE)

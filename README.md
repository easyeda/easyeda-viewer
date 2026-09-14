# easyeda-pro-viewer

嘉立创EDA专业版 `.epro2` / `.eprj3` 格式查看器。可内嵌在网页中、浏览器直接打开,或用免安装桌面 exe 本地运行。
A lightweight viewer for EasyEDA Pro (LCSC) `.epro2` / `.eprj3` projects — embeddable, single-HTML, and an install-free desktop exe.

**解析与渲染 100% 在本地完成,文件不会离开你的设备。**

## 形态

| 产物 | 说明 |
| --- | --- |
| `dist/index.html` | 单文件查看器(约 290 kB,gzip 96 kB),双击即用,可 iframe 嵌入,可被宿主页面 postMessage 控制 |
| `desktop/build/easyeda-viewer.exe` | Go + webview 免安装桌面版:内嵌上面的单文件页面,提供原生文件/文件夹对话框与本地读取 |
| JS 库 `embed` 入口 | `createViewer(host, opts)` 编程式嵌入,类型齐全 |

## 构建

```bash
npm install
npm run build          # → dist/index.html(单文件)
npm run smoke          # 渲染冒烟测试(68 样本)
node scripts/qa-screens.mjs   # headless Chrome 视觉 QA → qa/shots/

node scripts/build-desktop.mjs  # 桌面 exe(需 Go 1.22+ 与 MinGW gcc,Windows)
```

## URL 参数(单文件 / iframe / 桌面版通用)

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `theme` | `light`(默认)`/ dark` | 界面主题。**画布与图元始终使用源文件原始颜色**(SCH/PANEL 白底、PCB 深色),不随主题变化 |
| `toolbar` | `0` / `1` | 顶部工具栏显隐 |
| `left` | `0` / `1` | 左侧文档/对象/图层面板显隐 |
| `right` | `0` / `1` | 右侧属性面板显隐 |
| `status` | `0` / `1` | 底部状态栏显隐 |
| `chrome` | `canvas` | 一键纯画布(以上全 0) |

示例:`index.html?theme=dark&chrome=canvas`

工具栏也提供 🌙/️ 主题切换与左右面板开关按钮;postMessage 支持 `theme` / `chrome` 命令,JS API 提供 `setTheme()` / `setChrome()`。

## JS 嵌入

```ts
import { createViewer } from 'easyeda-viewer';

const viewer = createViewer(document.getElementById('host'), {
  theme: 'light',
  chrome: { toolbar: true, left: true, right: true, status: true },
  onLoaded: (model) => {},
  onSelect: (obj) => {},
});

await viewer.loadFiles(files);                 // File[]
viewer.loadMap(new Map([['a.esch2', bytes]])); // 或直接给 路径→字节
viewer.open(nodeId);
viewer.fit();
viewer.setTheme('dark');
viewer.setChrome({ left: false, right: false });
viewer.destroy();
```

## 桌面版(easyEDA Viewer.exe)

- 双击即用,无需安装、无需网络;页面由本机 `127.0.0.1` 随机端口提供。
- 「打开文件」弹原生对话框选 `.epro2/.esch2/...`;「打开文件夹」选择 `.eprj3` 工程目录,整目录批量读入。
- 也可以直接把工程文件/文件夹拖进窗口。
- 实现参考 [freerouting-desktop](https://github.com/freerouting/freerouting-desktop) 的 embed+webview+Bind 模式,源码在 `desktop/`。

## 支持格式

`.eprj3` 工程目录(或其 zip)、`.epro2` 单文件工程、单个 `.esch2` 原理图 / `.epcb2` PCB / `.epan2` 面板 / `.esym2` 符号 / `.efp2` 封装 / `.epru`。

## 图标与许可

- 代码与文档:Apache-2.0。
- 图标基于 [Lucide](https://lucide.dev)(ISC 许可,免费可商用),构建期内联,署名保留于 `src/ui/icons.ts`。

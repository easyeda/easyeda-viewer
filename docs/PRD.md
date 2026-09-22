# EasyEDA Pro Viewer 产品需求文档(PRD)

| 项目 | 内容 |
| --- | --- |
| 产品名称 | easyeda-viewer(嘉立创EDA专业版工程轻量查看器) |
| 文档版本 | v0.2.5(与代码同步) |
| 日期 | 2026-09-20 |
| 状态 | 核心 P0 已实现,渲染保真持续打磨 |
| 格式参考 | [easyeda/easyeda-eprj3-skill](https://github.com/easyeda/easyeda-eprj3-skill)(本地 `easyeda-pro-eprj3-format/`)、[easyeda/easyeda-pro-format-skill](https://github.com/easyeda/easyeda-pro-format-skill)(本地 `easyeda-pro-format-skill/`) |

## Abstract (for English readers)

A lightweight, **single-HTML-file** viewer for EasyEDA Pro project formats (`.epro2` and folder-based `.eprj3`). Written in TypeScript, rendered with LeaferJS. Parse and render are 100% local — no server, no upload. It can be opened by double-clicking the HTML file, or embedded into any web page via a JS API / postMessage interface. Features: document tree + object tree (left, resizable split, both searchable), properties panel (right, click-to-reveal, translated key attributes only, with a file-named layer list for PCB/panel), canvas pan/zoom (wheel zoom, right-button or middle-button pan), click-to-locate between tree and canvas, bilingual UI (zh/en) with dark/light themes, resizable/hideable panels, icon-only toolbar with an editable zoom percentage, a busy overlay (spinner + stage text) shown while projects load and documents render, multi-page schematics, PCB preview and panel preview. An optional install-free **Windows desktop exe** (Go + WebView2, ~7 MB) ships the same single-file viewer with native file dialogs, drag-and-drop, an app icon and proper version metadata; since v0.2.3 the artifact name carries the version (`easyeda-viewer_v{version}.exe`), the window title reads `EasyEDA 查看器 - v{version}`, a missing WebView2 runtime triggers a native download prompt for Microsoft's official installer, and the HTML favicon inlines the exe's own `.ico`; since v0.2.4 the host window shows immediately (DPI-sized, shell-colored) while WebView2 spins up, with the WebView2 profile pinned to `%LOCALAPPDATA%` for warm restarts. Rendering fidelity is tracked against official client PNG exports with an automated pixel-diff suite (`scripts/ref-diff.mjs`, 10 sample pages); CBB **reuse-block** `.epro2` projects (repeated-DOCHEAD streams) parse correctly since v0.2.1, and since v0.2.2 the PCB view matches the client's 2D stack (client layer order, active-layer raise with per-face label overlays, pad number + net-name blocks laid out along the pad's long axis, pour fills with bright edge wraps, polygon pads, embedded FONT glyph outlines, bottom-side mirror semantics).

---

## 1. 背景与目标

### 1.1 背景

嘉立创EDA专业版(EasyEDA Pro)的工程数据有两种本地形态:

- **`.eprj3` 文件夹化工程**:由 JSON 工程索引 + 纯文本图元记录文件(`.esch2`/`.epcb2`/`.epan2` 等)组成的目录,对 Git 与第三方工具友好,有公开的格式文档。
- **`.epro2` 单文件工程**:专业版的传统本地工程文件(内部结构未公开,需样本实测确认,见 §13 开放问题)。

目前缺少一个**免安装、离线、可嵌入**的工程预览工具:用户导出工程后,往往需要打开专业版客户端或登录云端才能查看。本项目提供一个单 HTML 文件,双击即用,也可以被第三方网站(如论坛发帖附件预览、元件商城、内部 PLM/OA 页面)以 iframe 或 JS API 方式嵌入。

### 1.2 产品目标

1. 任意用户拿到 **一个 HTML 文件** 即可在本地浏览器中完整预览 `.eprj3` / `.epro2` 工程的原理图、PCB、面板,全程不联网、不上传。
2. 为开发者提供**可嵌入的查看器组件**:对外接口可传入文件(File/Blob/URL/postMessage)。
3. 交互体验接近 EDA 客户端的"看图"部分:文档树 + 对象树、画布缩放平移、点选查属性、树↔画布双向定位、多页切换。
4. **轻量高性能**:常规工程(单页数千图元)秒开,缩放平移保持流畅。

### 1.3 非目标(明确不做)

- ❌ 编辑能力:不修改、不保存回 `.eprj3`/`.epro2`,不写任何文件到工程目录。
- ❌ 电气功能:不做 ERC/DRC、网络表导出、仿真(仅把仿真图作为普通原理图文档渲染)。
- ❌ 库管理、BOM、3D 视图、Gerber 导出。
- ❌ 旧版 `eprj`/`.eprj2`(SQLite 单文件)查看 —— 列为 P2 可选扩展,不在 v1 验收范围。
- ❌ 移动原生应用;桌面形态提供**免安装单 exe**(Go + WebView2 壳,内嵌同一单文件查看器,见 FR-9),非重客户端。

### 1.4 目标用户与场景

| 角色 | 场景 |
| --- | --- |
| EDA 用户 | 导出工程发给同事/贴在论坛,对方无需装客户端即可查看 |
| 集成开发者 | 在自己网页中 iframe 嵌入查看器,把用户工程文件通过接口传进来预览 |
| 评审者/教师 | 快速翻阅多页原理图、检查 PCB 布局走线、查看面板拼板 |
| AI/工具链 | 单文件无依赖,便于自动化截图、CI 里做回归预览 |

---

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| eprj3 工程 | 文件夹化工程目录:`X.eprj3`(索引 JSON)+ `sch/`、`pcb/`、`panel/` 子目录 |
| 文档(Doc) | 一个可独立渲染的图页文件:`.esch2`(原理图页/仿真页)、`.epcb2`(PCB)、`.epan2`(面板) |
| 行记录(Record) | 文档文件中的基本数据单元:`{type,id,ticket}||{属性对象}`,每行一条 |
| 图元(Primitive) | 一行记录对应的可渲染对象(LINE/PAD/VIA/COMPONENT/ATTR…) |
| 文档树 | 左侧上层树:工程 → Board → 原理图(含图页)/ PCB / 面板 / 仿真 / Library;带搜索过滤 |
| 对象树 | 左侧下层树:当前文档图元**按类型分组**(元件列位号、其余列 id);带搜索过滤与眼睛开关 |
| 属性面板 | 右侧面板(点选图元后展开):展示该图元**完整属性**(X/Y 坐标 → 关键属性 → 其余内置翻译属性 → 自定义属性置尾;库级默认属性回退),名称中英翻译;PCB/PANEL 文档底部带图层列表(#props-full) |
| 中间模型(DocModel) | 解析器输出的与格式无关的统一文档模型,渲染层只消费它 |

---

## 3. 输入格式要求(解析范围)

### 3.1 `.eprj3` 文件夹结构(P0,必须有)

```
MyProject/
├── MyProject.eprj3          # 工程索引与元数据(JSON):profile.boards/schematics/sheets/pcbs/panels/simulations
├── sch/<原理图名>/
│   ├── <图页标题>.esch2      # 原理图图页(每个图页一个文件,支持多页)
│   ├── <原理图名>.ecfg       # 设计规则与配置(仅属性面板展示,不渲染)
│   └── <原理图名>.evar       # 装配变量(仅展示,不渲染)
├── pcb/<PCB名>.epcb2         # PCB 文档
└── panel/<面板名>.epan2      # 面板文档
```

- 文档树结构来源:`.eprj3` 索引 JSON 的 `profile`(boards/schematics/sheets/pcbs/panels/simSchematics/simulations)+ 磁盘目录名兜底(名称以文件名为准)。
- 文件缺失/索引与实际不一致时:按实际磁盘文件渲染,树中给予"缺失/游离"标记。

### 3.2 行记录格式(P0)

- 每行:`{"type":"<TYPE>","ticket":<n>,"id":"<16位id>"}||{<属性对象>}`,行间以 `|` 分隔(末行无),首行 `DOCHEAD`(`docType`)、次行 `CANVAS`(原点、单位、栅格)。
- 必须解析的文档域(docType):`SCH_PAGE`、`PCB`、`PANEL`,兼容加载 `SYMBOL`、`FOOTPRINT`、`PANEL_LIB`、`SIMULATION` 单文档文件。
- 原理图图元(首批):COMPONENT、ATTR、WIRE/LINE、NETLABEL、PORT、BUS、TEXT、PIN、OBJ、SHEET(图页入口)等;PCB/面板图元(首批):COMPONENT、PAD、VIA、LINE、ARC、POURED/POUR、REGION、FILL、POLY、STRING/TEXT、IMAGE、BOARD 轮廓、Dimension、Panelize 等。
- 图元字段定义、JSON Schema、关联关系以 `easyeda-pro-format-skill/primitives/<域>/*.md` 与 `schemas/` 为准;新增图元类型按记录级"解码器注册表"扩展,未知 type 忽略并计入诊断报告(不报错中断)。
- **元件与分组语义**(RA6E2 样本实测):`COMPONENT` 记录是轻量的(位置/旋转/`partId`/`attrs`),符号几何以展开形式存放于页内 —— 多条 `PIN/LINE/POLY/FILL/ARC/TEXT` 等图元共享同一 `partId`(符号部件标识,如 `0402CG120J500NT.1`)与 `groupId`(总线/分组);对象树必须按 `partId`/`groupId` 聚合出元件节点(见 FR-2.2)。
- **`ELE_PLACEHOLDER` 占位记录**:形如 `{"dataType":"POLY","max":2}`,表示部分几何被简化占位(样本单页出现 573 条)。查看器按占位外框降级渲染并计入诊断,不视为数据损坏。
- **图层依据文档内记录**:PCB/原理图文件头部含 `LAYER` 记录(如 `id:"[\"LAYER\",1]"`,含 `layerType/layerName/use/visible` 等)与 `PRIMITIVE` 默认绘图属性记录;图层面板与颜色映射以文档内 `LAYER` 记录为准,内置表仅作配色兜底。

### 3.3 `.epro2` 单文件工程(P0)

> ✅ 已按样本 `samples/RA6E2-epro2/RA6E2.epro2` 实测确认(2026-09-14)。

- 用户直接拖入/选择一个 `.epro2` 文件即可完成查看。
- **容器:标准 ZIP**(文件头 `PK\x03\x04`),非 SQLite、无需 wasm。内部构成:

| 条目 | 说明 |
| --- | --- |
| `project2.json` | 工程元数据:`title`、`editorVersion`、`cbb_project`、`introduction`、`description`(HTML)、`custom_tags`。**不含工程文档树结构** |
| `<工程名>.epru` | **全工程所有文档的拼接记录流**:每文档依次为 `DOCHEAD → CANVAS → META → 图元…`,行/分隔规则与 eprj3 完全一致。RA6E2 样本含 99 个文档:SCH_PAGE×2、SCH×2、PCB×4、PANEL×1、SIMULATION×2、SIMULATION_SCH×2、SYMBOL×29、FOOTPRINT×21、DEVICE×29、BOARD×2、BLOB×1、FONT×1、CONFIG×1 |
| `IMAGE/<id>.webp` | 真彩图资源(BLOB 文档引用),独立条目存放 |

- **文档树重建**:因 `project2.json` 无 profile,文档树(Board→原理图→图页/PCB/面板)须从 `.epru` 内各文档的 `META` 记录(`title`、`docType`、`source` 引用)**重建** —— epro2 adapter 需要 SCAN 快路径:先只解 DOCHEAD/META/PRIMITIVE 关键行建树,几何行延后按文档打开时再解析。
- **文件名编码陷阱**:`.epru` 的 ZIP 条目名可能为 GBK/CP437 编码(中文工程名场景,实测 `unzip` 显示乱码)。解包层必须:UTF-8 flag 检测 → GBK 解码兜底;条目名仅用于展示,不作为逻辑键。
- 记录体系与 eprj3 完全同源(epru 内 `LAYER` 记录含 `id:"[\"LAYER\",1]"` 等复合 id,与 esch2 一致),因此 epro2 支持 = **ZIP 解包 + epru 文档切分 + META 建树** 一个 adapter,记录解析器/渲染层完全复用。
- **复用块 / CBB 工程**(`cbb_project: true`,v0.2.1 起支持,样本 `samples/ReuseBlock_A3967-epro2/`):此类 `.epru` 流中每个文档的 `DOCHEAD` 重复出现 2~3 次 —— 工程级注册条目 → `DOCHEAD+META`(title/board 关联)→ 无 ticket 的 `DOCHEAD` + 真正文档体(CANVAS + 图元)。文档切分必须把同 uuid 且尚无正文记录的连续 DOCHEAD 前缀**合并为一个 segment**,否则 `openDoc` 命中空的头部 segment、所有页面渲染成空白。复用块内的 PCB 文档只有占位 META(PCB 内容在块被放入正式工程时才生成),属数据本身如此;原理图页内容完整可渲染。

### 3.4 输入通道(全部 P0,除非注明)

1. **拖放**:拖文件进画布;拖**文件夹**(eprj3 目录,经 `webkitGetAsEntry` 递归读取)——`file://` 双击打开场景的核心通道。
2. **文件选择器**:按钮/点击空画布,`<input type=file>`(过滤器只列受支持后缀:`.eprj3/.epro2/.esch2/.epcb2/.epan2/.elib2/.epru/.esym2/.zip`,不含 `.efp2`);支持选择整个文件夹(`<input webkitdirectory>`)。
3. **ZIP 工程包**:拖入打包成 zip 的工程目录(fflate 解压,`file://` 可用)。
4. **嵌入 API**:宿主页面通过 JS API 传 `File`/`Blob`/`ArrayBuffer`/文件名(iframe 场域用 postMessage 传 `Blob` 副本或分块 ArrayBuffer)。
5. URL 参数 `?file=<url>` 拉取同源/CORS 允许的文档(**已实现**,仅 http(s) 环境;桌面壳与 QA 均使用)。

> 安全与隐私承诺:任何通道读到的数据只在当前页面内存中处理,永不发起网络请求(演示样例外,默认关闭)。

### 3.5 回归样本清单(`samples/`,仅本地,不入库发布物)

| 样本 | 内容 | 用途 |
| --- | --- | --- |
| `RA6E2-eprj3/` | 文件夹工程:2 原理图(各含 P1)+ 4 PCB(含多板/PCB 变体)+ 1 面板 + 2 仿真;单原理图页 1.18 MB / 72 元件 / ~3600 图元记录 | eprj3 全管线、性能基准(NFR-2/3) |
| `RA6E2-epro2/RA6E2.epro2` | 同一工程的单文件形态:1.25 MB ZIP / 4.2 MB `.epru` / 7 个 webp 真彩图;`.epru` 条目名 GBK 编码 | epro2 容器、META 树重建、非 UTF-8 条目名 |
| `viewer_fulltest-epro2/` | 专项混合样本:全类型图元、占位记录、多形态封装 | 记录覆盖面冒烟 |
| `ESP32S31-epro2/`、`H610-eprj3/`、`H610-epro2/` | 中大型真实工程(10 页原理图 + PCB,含铺铜/拼板) | 视觉保真回归(ref-diff 主样本) |
| `ReuseBlock_A3967-epro2/` | 复用块 / CBB 工程(`cbb_project`):重复 DOCHEAD 流、PCB 仅占位 | epro2 复用块切分(#cbb-epro2) |
| `full-objects-epro2/` | 全对象类型样本 | 长尾图元冒烟 |
| 官方示例 `easyeda-pro-eprj3-format/example/`、skill `examples/` 层 | 最小/专项记录样本 | 解析器单测 fixture |

---

## 4. 功能需求

优先级:P0 = v1 必须;P1 = v1 尽力(可降级);P2 = 后续版本。

### 4.1 FR-1 工程加载与文档树

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-1.1 | 打开 epro2/eprj3 后,左侧显示文档树:工程 → 各 Board → 原理图(含全部图页,**按工程存储的图页顺序**排序:eprj3 取索引 profile 的条目顺序,epro2 按 `SCH_PAGE META.zIndex`(1..N)——`.epru` 记录流顺序与图页顺序不一致,x86-pc 样本实测 zIndex=1..38 乱序存储)/ PCB / 面板 / 仿真 | P0 |
| FR-1.2 | 树节点显示图标(区分 SCH/PCB/PANEL/SIM)、名称;工程级显示名称、图页/文档计数 | P0 |
| FR-1.3 | 单击树中文档节点 → 主画布切换到该文档并渲染;当前文档节点高亮 | P0 |
| FR-1.4 | 多页原理图:图页作为原理图节点的子项在文档树中展开切换;**画布顶部图页 Tab 条为 P1 计划**(RA6E2 样本每原理图仅 1 页,暂以树切换覆盖) | P0(树)/P1(Tab) |
| FR-1.5 | 文档树与对象树均带搜索过滤框(按名称/id 即时过滤) | P0 |
| FR-1.6 | 加载失败给出明确诊断面板:文件类型判定结果、缺失文件、损坏行号 | P0 |

### 4.2 FR-2 对象树与定位联动

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-2.1 | 左侧面板上下分栏:上=文档树,下=当前文档对象树;分隔线可拖拽调整两区高度占比 | P0 |
| FR-2.2 | 对象树按图元层级组织:分组/容器 → 成员(依据 `parentId`、`lineGroup`、组引用等关联字段);未知归属图元平铺在"其他"下 | P0 |
| FR-2.3 | 对象树**按图元类型分组**(元件/文本/焊盘/走线…),组头显示类型中文名与计数;元件组内只列位号(可重复位号各自独立),其余类型列图元 id;**元件树只列真元件**(v0.3.1 #component-tree:按所引用 SYMBOL 文档 META.docType 过滤——2=元件/17=复合块符号算元件,18 电源标志/19 网络端口/20 图框/22 短接/31 差分对不算;库引用解析不出时如实列出;Designator 为空的元件如实列出,不以位号有无为判据),按位号自然排序;多页原理图的元件列表跨整张原理图合并,兄弟页只做属性扫描不建渲染场景(#page-switch-jank),切页时行集不变则跳过 DOM 重建 | P0 |
| FR-2.4 | 点击对象树节点 → 画布**定位**:视口居中该图元并缩放至合适级别,播放高亮闪烁动画,同步选中(属性面板更新) | P0 |
| FR-2.5 | 点击画布图元 → 对象树滚动并高亮对应节点,两侧选中状态始终一致 | P0 |
| FR-2.6 | 对象树节点可见性开关(眼睛图标):隐藏/显示单节点及其子树,用于复杂 PCB 分层审查 | P1 |

### 4.3 FR-3 画布渲染(LeaferJS)

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-3.1 | 原理图渲染:导线/总线/元件符号(引用符号图形数据)/引脚/网络标签/端口/文本/图框与网格背景;属性文本(位号、值)**严格按实例 `valueVisible` 显示**(v0.3.1 #attr-visibility:实例属性仅 `valueVisible === true` 才绘制,false=取消勾选与 null=未勾选均不画,全样本验证所有被绘制的属性都带显式标志;无坐标的实例属性是库元数据一律不画;实例值为空的属性不做库值/META 回退绘制);豁免:电源标志(docType 18)与网络端口(docType 19)符号的 `Name`/`Global Net Name` 有实例值时结构性显示——旧存档 GNN 全部 vv=null(327/71 页)而官方渲染有标签,新存档迁移为 Name vv=true;非连接标识按引脚实时端点绘制,parentId ���链(迁移遗留)不绘制(与客户端一致);**标题栏���统属性**(v0.3.1 #titleblock-sysattrs:标题栏 `={@Key}` 引用与旧式图框值槽动态取值——图框 symbol 有两种形态:新版 Drawing-Symbol_* 内嵌 TABLE 记录,单元格值 `={@Schematic Name}` 等按合并属性表解析;旧版 Sheet-Symbol_*(epro2 常见)无 TABLE,用 TEXT 艺术字画标签+带坐标的 ATTR 槽位画值(lib 槽位值恒空,实际值在 border 元件实例 ATTR,全部无坐标/无 vv 标志),此时按槽位 key 从 pageAttrs(页面缓存 @ 属性+动态合成)取值绘制在槽位坐标,有 TABLE 的新式图框不画槽位避免重复;`@Page Name/No/Count、@Schematic/Project/Board Name` 按打开文档动态合成(页名取标题、页号/页数取全树显示顺序、原理图/工程/板名取祖先链),`@Create/Update Date/Time` 优先用文件缓存值、缺失时以 DOCHEAD updateTime(格式内唯一时间戳,查看器本地时区)兜底);**图框尺寸实例覆盖**(v0.3.2 #border-size-override:页面尺寸以图框元件实例的 `Page Size`/`Width`/`Height` 属性为准,不信 CANVAS 声明——eprj3/esch2 工程的 CANVAS 常写默认 A4 而图框实例标 A3,CPU_PWR - +VCCCORE_3/3、5V_DUAL 等 5 页官方即 A3;标准 Sheet-Symbol_* 按 PAGE_SIZES 解析,实例 W/H 与所引图框 art 不符时以实例为准,art 缺失时按实例尺寸画标准边框+标题栏,对象树 bbox(borderPageBBox)同规则);**文本锚点**(v0.4.0 #sch-text-anchor:TEXT/STRING 缺省 align 按 EasyEDA canvas em 盒语义 = LEFT_BOTTOM 锚定 —— x=字形左缘、y=含下降部的盒底(基线 ≈ y−0.2em),不再回退 middle 使偏移随 fontSize 线性放大;行高取 1em(参考导出多行实测 ≈0.97em),注意 leafer 数值 lineHeight 是绝对单位而非 em 倍数,须传 fontSize;leafer 基线模型((L+0.7)/2·fs)与 canvas em 盒统一差 0.05em,沿文本自身上轴抬回(旋转安全);geom.textFramePoly 缺省对齐同步改 BOTTOM 与渲染同源;官方导出 PNG 像素实测 7 处基线偏差 ≤0.7 文档单位,盒子不再触发 __lineHeight<fontSize 的 fs/2 扩散) | P0 |
| FR-3.2 | PCB 渲染:按图层(layer)分组着色绘制 —— 板框、覆铜(poured)、走线、圆弧、过孔、焊盘(含形状/图层正反面)、丝印文本、元件、禁布区(region)、尺寸标注、图像 | P0 |
| FR-3.3 | 面板渲染:面板内 PCB 实例摆位、面板图文元素、拼板(panelize)外框 | P0 |
| FR-3.4 | 图层颜色/可见性沿用专业版视觉习惯(内置映射表,支持用户配置覆盖);提供"图层面板"快速开关 | P0 |
| FR-3.5 | 坐标换算:文档原点(CANVAS originX/Y)+ 单位换算(sch 为 mil 体系、pcb 为 mm 体系,按记录字段/文档类型处理),Y 轴方向与 EDA 视图一致;**原理图双 Y 轴约定兼容**(v0.3.1 #x86-esch2-flip:epro2 等旧导出为 Y-down,≥3.2.91 客户端迁移后的工程把每条记录 y 与 originY 取反并在 CANVAS 标记 `yAxisDirection:"up"` —— 检测到标记时套 Y-flip 变换,旋转角手性随翻转取原始角,align 锚定两种约定一致按屏幕语义不变;未标记文档与 PCB 渲染路径不变) | P0 |
| FR-3.6 | 元件符号渲染:元件记录内联/内嵌的符号绘制数据(`OBJ`/path 等)完整绘制;若为外部引用导致缺数据,降级绘制位号占位框并提示;**镜像×旋转复合顺序**(v0.3.2 #mirror-rot-order:doc 空间恒为"先绕元件自身竖轴镜像、后旋转"(R·M),但屏幕实现随页面 Y 约定共轭——Y-down 页(epro2)旋转角取负使镜像必须包在旋转组之外(leafer `T·M·R`,镜像组套旋转组),Y-up 页(eprj3)保留原始角、单组 `rotation+scaleX` 即可(`T·R·M`);0°/180° 两种序等价不受影响;全工程 737 个镜像引脚对导线端点核验 735 命中(旧序 623),C225/C246/ATXPWR2 偏移即源于此;worldBBox 与非连接引脚锚点同规则) | P1 |
| FR-3.7 | 字体:文本类图元使用 canvas 字体渲染,支持旋转/镜像/字号;BLOB 真彩图与自定义字体(TMFont)P2 | P1 |
| FR-3.8 | 深色/浅色两种画布主题,默认跟随 EDA 习惯(原理图浅灰底、PCB 深底) | P1 |
| FR-3.9 | PCB 描边原语(走线/圆弧/多段线/矩形)**圆头圆角**(strokeCap=round、strokeJoin=round,与客户端一致);长圆形焊盘的槽型孔按圆角矩形绘制(非尖角椭圆);钻孔/槽孔渲染在最顶层(穿孔穿透焊盘);铺铜/填充**暗化填充 + 全亮包边**描线(对齐官方 2D 视觉,不再全亮平涂);钻孔填充比画布背景略浅(挖槽在铜面上可辨) | P0 |
| FR-3.10 | PCB 文本(丝印等)按数据中的**路径/锚点/角度**还原渲染,与官方视觉一致;底面丝印的镜像重复副本(自动生成的 twins)跳过,只渲染独立文字 | P0 |
| FR-3.11 | 焊盘编号/网络名等网络标注按**文档比例**绘制(随焊盘尺寸与缩放同步缩放,非屏幕恒定像素):网络名按可用宽度 fit 字号、放不下自动隐藏;焊盘编号+网络名沿焊盘长轴双行居中(见 FR-3.15);元件内 STRING 文本按文档比例 | P0 |
| FR-3.12 | 图层面板取文档内 `LAYER` 记录的**图层名称**展示,且只列出当前文档实际有图元的图层,带图元计数;支持图层重置(恢复文件内可见性);POLYGON 形状的焊盘归类到焊盘图层 | P0 |
| FR-3.13 | PCB **图层栈序**(pcbStackKey,对齐客户端 2D 视觉,自底向上):标注层(机械/文档/自定义/pin/3D)< 底面(装配→助焊→阻焊→铜→网络名→编号→丝印)< 内层(inner32…inner1)< 顶面(同底面序)< 通孔铜(MULTI)< 板框< 原点轴/飞线< 钻孔(置顶,穿孔穿透焊盘);同 key 保持创建顺序 | P0 |
| FR-3.14 | **图层激活**:点击图层面板行将活跃层组提至栈顶(置顶显示,内层/对面铜可见);常驻工具层(multi/板框/轴/飞线/钻孔)压回原序;对面标注浮层沉回不遮活跃层;每面独立的网络名(nn)/编号(pn)/铺铜(pour)合成子层组随活跃面整体提层,活跃层切换高亮;激活层同时是画布点选的**唯一拾取层**(设激活层时点击只命中激活层图元、激活层无命中不选中也不穿透回退,#pick-active-layer,行为细则见 FR-4.3),重置图层/切换文档时拾取限定一并清除;通孔类对象(过孔/通孔焊盘)按铜层集合放行激活层过滤(#via-pick-any-layer,细则见 FR-4.3) | P0 |
| FR-3.15 | **焊盘标签布局**:编号+网络名沿焊盘长轴双行居中(块整体居中,行距 GAP=1);无网络时编号居中单行;竖焊盘(h>w)编号随焊盘方向旋转读向(不强制直立);网络名按长边 90%×0.8 收缩宽度与短边剩余高度 fit(字号 5 上下限,v0.2.3 由 6 降档),放不下隐藏不保底;文档坐标系内按焊盘角度做行偏移(docDelta) | P0 |
| FR-3.16 | **网络名与网络专色**:顶/底/内层走线均绘制网络名(内层的挂在走线所在层组,随该层激活显示);按线长 fit 字号、沿线段角度旋转(±90° 内翻转保证可读);全部网络标注(编号/焊盘网络名/走线网络名)统一墨色 #f2f4f7(contrastInk 已废除);NET 记录携带的**网络专色**(#net-colors)覆盖走线/焊盘铜色 | P0 |
| FR-3.17 | **铺铜保真**:fineness 决定填充质量;孤儿 POURED 缓存(无对应 POUR 记录)只画包边描线(避免错误黑块填充);nonzero 填充规则使铺铜间隙/孔洞自然穿透;POUR_FILL_DIM=0.7 暗化填充与全亮包边配合(v0.2.4 按官方导出图实测由 0.6 校正:#B20000 填充对 #FF0000 走线,见 FR-3.9) | P0 |
| FR-3.18 | **焊盘保真**:POLYGON 轮廓焊盘按**封装坐标原样**绘制(v0.3.2 #pad-polygon-ring:轮廓 path 预置位/预旋转烤死在封装坐标系,直接 as-is 绘制、不重定心到 centerX/centerY、也不吃 padAngle 旋转——安装环类封装 SMD_BD5.6-D3.6/SMD-1_BD4.4-D2.8 的四个环形扇区 path 围绕封装原点、与形状 bbox 中心偏差 ~8.3/6.6 文档单位,按声明中心重定心会把每个扇区沿切向推移 ≈4.8°(r 的 8.35%),视觉即"整体多转了几度";PRPAK5X6 七个库副本 pad-5 path 逐字节相同而 padAngle=0/90/180/270,证明 padAngle 对 POLYGON 铜皮只是钻孔/编号元数据;centerX/centerY 仍锚定钻孔(含 padOffset)与编号/网络名标签;阻焊/助焊窗同步按原样轮廓生成;off=0 的普通多边形焊盘(USPQ-4B04、ssc338q 等)as-is 与重定心等价)并同步生成阻焊/助焊窗;ELLIPSE 圆头焊盘;槽孔按 relativeAngle 随焊盘旋转;padOffset 仅偏移钻孔不偏移铜皮;通孔焊盘挂 MULTI 层组(顶/底层之上);封装内 Multi-Layer 填充形状解析为挖槽到孔层 | P0 |
| FR-3.19 | **阻焊/助焊窗**:按 SOLDER_MASK/PASTE 规则对焊盘/过孔开窗,扩展量按规则记录分面(顶/底)取值;规则记录(`ruleContext`)数值为 **mil 文档单位**——其 `unit:"mm"` 字段是客户端 UI 显示偏好而非存储单位,默认规则 padTopExpan:2 即 0.05mm,不得按 mm 换算(v0.2.3 修复,曾致外扩 ~40 倍);−1000 哨兵=不开窗(过孔默认盖油 tented,记录可逐面覆盖;焊盘同 ≤−1000 哨兵约定) | P0 |
| FR-3.20 | **底面透视**:底层铜/丝印以 BOTTOM_ALPHA 半透明透板显示,元件/焊盘按 M_y·R(θ) 镜像矩阵变换(与客户端一致);透板镜像文本/图片自动生成 twins,与 FR-3.10 去重规则一致 | P0 |
| FR-3.21 | **文本保真**:内嵌 FONT 文档的 glyph 走**预矢量化轮廓**渲染(轮廓 path,不再回退 canvas 字体);STRING 支持 CARC(圆弧文本路径)token | P0 |

### 4.4 FR-4 画布交互

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-4.1 | **滚轮缩放**:以鼠标位置为中心;触控板双指缩放/平移原生支持 | P0 |
| FR-4.2 | **平移**:右键拖拽(不弹浏览器/自绘右键菜单)、中键拖拽、空格+左键拖拽、单指拖拽(触屏);边界不限(内容范围外可继续平移) | P0 |
| FR-4.3 | 左键点选图元 → 选中(描边+控制框),命中容差随缩放级别自适应;空白处点击取消选择;**激活层唯一拾取**(#pick-active-layer,v0.3.5 收紧):PCB 族文档(PCB/面板/封装)设了激活层时,画布点击**只命中激活层上的图元**,激活层无命中即不选中任何东西(等同空白点击、取消当前选中),**绝不回退穿透到其他层**;**通孔类对象跨铜层命中**(#via-pick-any-layer,v0.4.0 用户反馈):过孔与通孔焊盘(页级与封装内)物理上贯穿全部铜层、渲染归多层组(MULTI),激活层过滤对这类对象从"层组 key 相等"放宽为"激活层 ∈ 对象拾取层集合"(RenderObject.pickLayers = 其贯穿的铜层全集 TOP/BOTTOM/SIGNAL/PLANE/INNER*)——激活任一铜层都能点中,不再被激活层独占过滤永久排除;隐藏层可见性判定仍按对象层组 key(过孔显示跟随现状,不随单面隐藏),未设激活层行为完全不变;样例暂无盲埋孔、VIA 起止层数据未解析,缺省视为全铜层(边界);未设激活层时保持整体"bbox 最小面积"命中规则(否则无激活层便无可点选),隐藏层过滤保持;命中与隐藏层判定以渲染时落定的层组 key(RenderObject.layerKey,含 pour:/pn:/nn: 合成组与元件归层)为准;**导线段精确命中**(#pick-precise,v0.3.5):有路径顶点的对象(pathPts ≥ 2:导线/走线/弧/折线,弧已采样为折线)不再用 bbox 包含判定——逐段点到线段距离 ≤ 容差(文档单位,≈6 屏幕px / camera.scale)才算命中,bbox 仅作扩大容差的粗筛预过滤,精确测试不过即淘汰**不回退 bbox**(L 形 bbox 空白区/斜线三角空区不再误选);与激活层规则组合:先过层/隐藏过滤,再在通过者中线类取距离最小者;线类与框类并存时按 bbox 面积定胜负(走线端点落在焊盘/过孔中心时不抢小目标,铺铜大 bbox 空腔不抢走线);**选中高亮贴合路径**(#select-box-path,v0.3.4):线类图元(原理图导线 LINE/折线 POLY、PCB 走线 LINE/圆弧 ARC/折线 POLY)的选中高亮沿**实际绘制路径**描亮(圆弧按 arcPts/arc3Pts 采样为折线,与绘制的 SVG 弧逐点吻合),不再取整体 bbox 最大矩形——斜走线/斜导线不再出现大角度失配的粗斜框,与 EDA 客户端沿线高亮习惯一致;**旋转选框贴合**(#select-box-rot,v0.3.5):旋转非零的框类图元(元件/焊盘/丝印字符串/文本)的选中框按**实际旋转姿态**渲染为贴合图元的闭合四角折线(RenderObject.selPoly,渲染层与拾取层同一套旋转映射:原理图元件 R·M 共轭映射、PCB 封装按组旋转/镜像映射、RECT/圆头焊盘按 padAngle 旋转 w/h 外框、POLYGON 焊盘直接用 path 顶点、文本按旋转角与局部宽高),不再退化为轴对齐最大矩形——45° 元件选框是贴着符号的斜框而非大一圈的正框;0° 图元不标注 selPoly,自然退化回 bbox 框(零回归);高亮线恒定像素虚线(线宽 2px、4 开 3 关,随缩放恒定不变粗,#select-box-path);**默认激活顶层**(#default-top-layer,v0.4.0):打开 PCB 族文档时激活层自动设为顶层铜皮(有实体图元时),图层面板对应行显示激活态——默认激活只落拾取优先层与行高亮,**不触发置顶重排**(不改写渲染器初始层叠外观),用户显式点行才完整置顶;重置按钮/切换文档/DEVICE 清除后再次打开仍恢复默认顶层;无顶层铜皮实体的文档(纯工具层面板)保持未激活;**封装内焊盘可拾取**(#fp-pad-pick,v0.4.0):PCB 文档中元件封装内部的焊盘注册为独立可拾取对象——点击落在焊盘上选中该焊盘(选框用焊盘 bbox/旋转贴合四角,属性面板展示焊盘号/形状/宽高/钻孔/网络),点击封装 bbox 内空白处仍选中整个封装;SMD 焊盘拾取归属元件所在面层,通孔焊盘拾取归多层组 MULTI 并带全铜层拾取集合(#via-pick-any-layer,激活任一铜层可点中;铜皮绘制挂多层组不变),与激活层独占拾取、隐藏层判定及面积定胜负完全一致——走线端点/过孔与焊盘重叠时 bbox 更小的焊盘胜出 | P0 |
| FR-4.4 | 框选(P1 支持多选并在属性面板展示列表)| P1 |
| FR-4.5 | 工具栏:适应窗口(Fit)、1:1、放大/缩小、手型/选择模式切换 | P0 |
| FR-4.6 | 快捷键:`+/-` 缩放、`0` 适应窗口、`Esc` 取消选中、`W`(fit width)等常用子集 | P1 |
| FR-4.7 | 悬停 tooltip:显示图元类型与关键属性(位号/网络/值) | P1 |
| FR-4.8 | 状态栏:缩放比例、光标处文档坐标(含单位,跟随顶栏 mm/mil 切换)、图元/层计数、渲染耗时。顶栏单位切换(#unit-toggle,v0.3.3):工具栏语言按钮左侧 mm/mil 按钮,点击在 mm/mil 间切换并**持久化**(localStorage `ev.unit`,默认 mil),按钮文字显示**当前**单位(与画布显示单位一致;v0.4.0 由"显示目标单位"改为当前单位,用户反馈),淡底描边常亮样式与图标按钮区分、悬停实底;换算只作用于**显示层**(状态栏坐标、属性面板坐标/尺寸/钻孔/线宽、量测读数与刻度步长),文档存储坐标与画布图形一律不动;换算基准按文档族:PCB/封装 1 单位=1mil,原理图/面板 1 单位=0.254mm=10mil(实测互证,修正此前 sch 体系按 mil 标注的 10× 错标);换算集中在 ui/units.ts(mm/mil 状态 + 换算 + 格式化 + onUnitChange 订阅广播) | P0 |
| FR-4.9 | **量测**(v0.3.2 #measure,v0.3.3 #unit-toggle 微调,仅 PCB/封装/面板文档):工具栏缩放比例输入框右侧量测按钮(非 PCB 类文档禁用)进入量测模式 —— 画布出现满屏十字光标线(跟随鼠标、crosshair 光标、按钮 ev-on 高亮、状态栏提示);左键取起点(文档坐标)、移动实时预览、再左键取终点固化一把三角形标尺:斜边=测量线,过起点的水平/垂直直角边带**等间隔刻度**短线(刻度步长取 1/2/5×10ⁿ mm/mil 双档中屏距 ≥10px 的最小档,每 5 格加长;刻度像尺子一样**从直角边线单侧长出**、端点贴线伸向三角形内侧,不再骑线居中),标注 \|ΔX\|/\|ΔY\|/距离(读数与刻度步长**跟随顶栏 mm/mil 显示单位**切换并立即重绘,mm 2-3 位小数、mil 1-2 位);可连续量测多把标尺同时保留;所有线条白色 1px、文字 13px 白色,在独立覆盖层 canvas 上以**屏幕空间**绘制,不随缩放变化;白色主线**双描增强**(1.25px 打底 + 1px 复描)叠在淡化黑晕(alpha 0.35)上,抗锯齿不混出发灰、保持**纯白 1px** 观感(像素级 QA 自证);滚轮缩放/拖拽平移保持可用且标尺随相机重投影重绘,量测中左键不触发图元选中;退出:再次点击工具栏按钮或右键(非拖拽)= **清除全部标尺**并退出模式(v0.4.0 用户反馈:量测多次后直接点测量图标应清空画布标尺),Esc = 退出但**保留标尺**,切换文档 = 退出并清空(标尺归属旧文档) | P0 |

### 4.5 FR-5 属性面板(面向普通用户重新设计)

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-5.1 | **默认不展示**:初始右侧面板收起,点击画布图元(或树上节点)时才展开;未选中时显示引导文案"点击画布中的图元查看属性" | P0 |
| FR-5.2 | 展示所点图元**完整属性**(#props-full),按四段排序:① X/Y 坐标置顶;② 关键属性(位号/名称/值、网络、图层、形状尺寸、钻孔等,按图元类型);③ 其余内置属性(实例 ATTR **全量**列出,不受画布 valueVisible 渲染规则限制;实例空缺由符号/封装库级默认 ATTR、器件 META 回退);④ 自定义属性置尾。仅省略 uuid/parentId 等内部实现字段,无"原始 JSON"页签 | P0 |
| FR-5.3 | 属性名带中英翻译(i18n 联动):内置属性名(Designator=位号、Value=值、'Global Net Name'=全局网络名、'Add into BOM'=加入 BOM 等)全量收录翻译表,未命中的自定义名按原始 key 显示;值做**解码后展示**:复合 id 拆解、颜色带色块、坐标/尺寸/钻孔/线宽按**当前显示单位**(mm/mil,#unit-toggle)换算带单位后缀、布尔显示是/否、枚举显示可读名 | P0 |
| FR-5.4 | 面板底部内嵌**图层列表**(仅 PCB/PANEL 文档):眼睛开关 + 文件内 LAYER 记录的图层名 + 图元计数;属性区与图层区之间有可拖拽分隔线,手动调整占比 | P0 |
| FR-5.5 | 属性面板内点击图元 id/网络名 → 定位到引用处(同网络高亮所有连线) | P2 |

### 4.6 FR-6 对外接口(可嵌入)

构建产物两种形态,同源同 API:

1. **单文件应用** `dist/index.html`(vite-plugin-singlefile 全内联,~334 kB / gzip 110 kB):双击打开即用;同时可被 iframe 嵌入。
2. **嵌入 API** `src/embed.ts`(`createViewer`,配合打包器引用源码;独立 `es/umd + .d.ts` 库产物为 P1 计划):

```ts
import { createViewer } from 'easyeda-viewer/embed'; // 现阶段经打包器引 src/embed.ts

const viewer = createViewer(document.getElementById('host'), {
  theme: 'light',                 // light | dark(画布始终保留文档色)
  lang: 'zh',                     // zh | en
  chrome: { toolbar: true, left: true, right: false, status: true },
  files: [],                      // 可选:创建即加载
  onSelect: (obj) => {},          // 选中图元(null=取消)
  onLoaded: (model) => {},        // 工程加载完成(openables 供枚举文档)
  onError: (err) => {},
});

await viewer.loadFiles(files);            // File[](eprj3 目录内容 / .epro2 / 单文档)
viewer.loadMap(new Map([['a.esch2', bytes]])); // 已读取的 path→bytes
viewer.open(nodeId);                      // 按树节点 id 切换文档
viewer.fit();                             // 适应窗口
viewer.setTheme('dark'); viewer.setLang('en'); viewer.setChrome({ left: false });
viewer.getModel();                        // 当前 ProjectModel
viewer.destroy();
```

iframe/postMessage 协议(`src/main.ts` 内置桥,**已实现**;消息均带 `source:"easyeda-viewer"`):

```jsonc
// 宿主 → viewer(iframe.contentWindow.postMessage)
{ "cmd": "load", "files": [ { "name": "a.eprj3", "dataBase64": "..." }, ... ] } // 目录=多条目
{ "cmd": "open", "nodeId": "..." }   // 切换文档
{ "cmd": "fit" }                     // 适应窗口
{ "cmd": "theme", "theme": "dark" }  { "cmd": "lang", "lang": "en" }
{ "cmd": "chrome", "chrome": { "left": false } }
// viewer → 宿主
{ "event": "ready", "version" } { "event": "load-ok", "count" } { "event": "open-result", "ok" } { "event": "error", "message" }
```

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-6.1 | JS API 如上;**已实现**(回调式 onSelect/onLoaded/onError)。独立库产物 + `.d.ts` 发布 | P0(已)/ 库产物 P1 |
| FR-6.2 | postMessage 协议:load(base64 文件条目)/open/fit/theme/lang/chrome + ready/load-ok/open-result/error 事件 | P0 |
| FR-6.3 | 嵌入配置项(URL query 与 options 双轨):`theme`、`lang`、`toolbar/left/right/status`(或 `chrome=canvas`)、初始文件 `?file=`;**已实现**,水印预留 | P1(水印) |
| FR-6.4 | 对外演示页 `demo/`(iframe 嵌入 + API 两种用法);现阶段以 `qa/viewer.html` 承载演示 | P1 |

### 4.7 FR-7 诊断与空状态

- 未加载工程:画布显示引导页(拖放区 + 支持格式说明 + 样例工程入口)。
- 解析异常不白屏:坏行跳过并在右上角"诊断"徽标计数,点开看明细。
- `file://` 与 `http(s)` 两种宿主环境能力差异(如 FSA API 不可用)在 UI 中自动降级提示。

### 4.8 FR-8 界面现代化、外观与布局控制

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-8.1 | 现代 UI:统一工具栏/面板视觉,明暗双主题令牌化(CSS 变量),圆角、层次阴影、悬停反馈 | P0 |
| FR-8.2 | 起始页为醒目的拖放引导卡片:拖入文件时高亮(dashed→accent),并给出"打开文件/打开文件夹"按钮;文案说明解析渲染 100% 本地 | P0 |
| FR-8.3 | 图标全部使用 Lucide(ISC 许可,免费可商用,构建期内联进单文件产物),语义贴切(文档树/对象/图层/面板开关/缩放/主题) | P0 |
| FR-8.4 | 主题默认亮色;参数 `?theme=light|dark` 与工具栏🌙/️切换按钮均可控制;**画布与图元始终使用源文件原始颜色**(SCH/PANEL 白底、PCB 深色),不随主题变化;文档背景由 Leafer 场景内背景矩形绘制并与内容替换**同任务原子切换**(v0.2.3 #bg-flash——CSS 同步换底色会与 Leafer 晚一帧的重绘混合,产生 SCH→PCB 深色闪现) | P0 |
| FR-8.5 | 布局参数:`?toolbar=0&left=0&right=0&status=0` 或 `?chrome=canvas` 单独隐藏任一面板(纯画布场景);工具栏面板按钮可运行时切换;JS API `setChrome()`/`setTheme()`、postMessage `chrome`/`theme` 命令 | P0 |
| FR-8.6 | **中英双语 UI**:工具栏 🌐 按钮即时切换(全部界面文案/树类型名/属性名经 i18n 表),参数 `?lang=zh|en` 与 API `setLang()` 可设定初始语言 | P0 |
| FR-8.7 | 顶部工具栏**纯图标**无文字(打开文件/打开文件夹为图标按钮);缩放控件为**可点击输入的数字百分比**(直接键入缩放值回车生效)+ 放大/缩小/适应窗口;缩放输入框位于**适应窗口按钮右侧**(v0.2.3 调整),自身**无背景填充**(仅细边框,避免与面板底色打架) | P0 |
| FR-8.8 | 左右面板宽度、文档树/对象树高度、属性区/图层区高度均可**拖拽分隔条调整**;初始界面(未打开文件)只显示工具栏与中央引导卡,左右面板收起 | P0 |
| FR-8.9 | 品牌图标使用嘉立创EDA 官方云朵+电路标志(无字版,单一 path,#5588FF);库分组节点用官方图标包提取的 symbol/footprint/library 等语义图标 | P0 |
| FR-8.10 | HTML 标签页 **favicon 与桌面 exe 同一图标**:构建期由 vite 插件 `appIconFavicon` 将 `desktop/app.ico` 以 base64 data URI 内联进 `index.html`(单文件产物与 dev server 均生效,无额外请求) | P1 |
| FR-8.11 | **加载中过渡效果**(v0.2.5,#loading):解析工程与渲染文档(大 PCB 可达秒级)阻塞主线程,期间显示全 shell 忙碌遮罩(半透明底 + 旋转圆环 + 阶段文案「加载工程中…/渲染文档中…」,中英文随语言);遮罩必须在阻塞工作开始**前**到达屏幕——显示后让渡两个动画帧再启动重活(单帧不够,rAF 回调仍在该帧绘制前执行);覆盖路径:打开文件/拖放/desktop 桥接加载(loadFiles/loadMap)、文档树点击与跨页跳转(openNode)、postMessage 打开(openNodeId);pickObject 跨页定位 await 文档打开完成后再查找对象(异步化后保持查到新文档对象);完成后遮罩隐藏;原理图页打开仅 ~100ms,切页不再走遮罩+双 rAF 让渡,避免纯延迟(#page-switch-jank,v0.3.1) | P0 |

### 4.9 FR-9 免安装桌面版(Go + webview)

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-9.1 | 单个自包含 `.exe`(Windows amd64,约 7 MB):`//go:embed` 内嵌单文件查看器,本机 127.0.0.1 随机端口 HTTP 服务加载,免安装、免联网 | P0 |
| FR-9.2 | 原生能力桥接(webview Bind):`openFileDialog` / `openFolderDialog`(Win32 通用对话框,STA 线程)、`readProjectFiles`(文件/整个 .eprj3 目录 → base64 JSON);无桥接环境自动回退 `<input type=file>` | P0 |
| FR-9.3 | 拖放本地工程文件进窗口可直接打开(WebView2 原生 File 支持) | P0 |
| FR-9.4 | 构建:`node scripts/build-desktop.mjs`(vite 打包 → 复制到 `desktop/dist` → windres 编译资源 → `go build -H windowsgui`),产物 **`desktop/build/easyeda-viewer_v{version}.exe`**(版本号取自 package.json,与 `-ldflags main.version` 同源,v0.2.3 起带版本后缀);`desktop/` 跨平台骨架(Win32 完整,macOS/Linux 用 osascript/zenity 对话框) | P1 |
| FR-9.5 | exe 资源:`versioninfo.rc` 提供文件属性(版本号、作者、版权、中文描述,UTF-8 资源编译;版本号与 package.json 同步)与 EasyEDA 云朵 ICON(256/32px ICO);资源提交 `rsrc_windows_amd64.syso` 兜底(无 windres 环境可直接构建) | P0 |
| FR-9.6 | **窗口标题栏**:`EasyEDA 查看器 - v{version}`(Win32 宿主窗口与 webview SetTitle 双处一致) | P0 |
| FR-9.7 | **WebView2 运行时缺失提示**(v0.2.3):启动时按官方检测方式查 EdgeUpdate\Clients\{F3017226-…} 注册表键(HKLM×2 视图 / HKCU)的 `pv` 值;缺失时弹原生对话框——「确定(下载)」经 ShellExecute 用系统浏览器打开微软官方 Evergreen Bootstrapper 地址(fwlink 2124703),「取消」关闭弹窗;两条路径均退出程序(装好后重跑) | P0 |
| FR-9.8 | **启动提速**(v0.2.4):宿主窗口在 webview.NewWindow(阻塞的 WebView2 环境/控制器创建,冷启动 ~4s)之前即按 DPI 换算的最终尺寸居中显示,背景刷与界面 `--ev-bg` 同色(空窗口可见,渲染就绪后由 webview_widget 覆盖);WebView2 用户数据目录固定到 `%LOCALAPPDATA%\EasyEDAViewer\WebView2`(WEBVIEW2_USER_DATA_FOLDER,避免加载器默认 exe 旁目录被杀软逐次重扫,profile 跨启动复用);注入 `--no-first-run --no-default-browser-check --disable-background-networking`(WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS);NewWindow 关闭 debug(不启用 DevTools);启动链各阶段打 `[t+…]` 计时日志 | P0 |

---

## 5. 非功能需求(NFR)

| ID | 指标 | 目标值 |
| --- | --- | --- |
| NFR-1 | 单文件产物体积 | ≤ 3 MB(gzip 后 ≤ 1.5 MB);不含演示数据 |
| NFR-2 | 打开速度 | 典型样例(3 页原理图 + 1 PCB,<2 万图元)从文件到手可交互 < 1.5 s(本地 SSD、中端 CPU) |
| NFR-3 | 渲染性能 | 单页 5 千图元:首帧 < 400 ms;5 万图元页允许降级(仅可见区绘制)下缩放平移 ≥ 30 fps |
| NFR-4 | 交互延迟 | 点选命中响应 < 50 ms;树定位动画 250 ms 内完成 |
| NFR-5 | 内存 | 解析模型 + 场景对象常驻 < 500 MB(样例工程);切换文档时释放上一页场景对象,模型缓存 LRU |
| NFR-6 | 浏览器兼容 | Chrome/Edge ≥ 110、Firefox ≥ 115、Safari ≥ 16.4;`file://` 双击打开必须全功能(拖文件夹、拖文件) |
| NFR-7 | 离线 | 运行期零网络请求;不引用任何远程 CDN 资源;字体用系统等价字体栈 |
| NFR-8 | 隐私 | 文件数据不出浏览器;文档中明示此承诺 |
| NFR-9 | 健壮性 | 任意畸形输入不导致未捕获异常;Worker 崩溃可恢复并提示重载 |
| NFR-10 | 可维护性 | 解析器单测覆盖每种已支持图元 ≥ 1 条真实记录(从参考仓库 examples 层提取);核心层零 DOM 依赖 |

---

## 6. 技术方案

### 6.1 选型

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 语言 | TypeScript 5.x(strict) | 全仓 TS,UI 与核心均如此 |
| 构建 | Vite 6 + `vite-plugin-singlefile` | 同一份代码输出 `viewer.html`(单文件内联全部 JS/CSS)与 `viewer.es.js`/`umd` + `.d.ts` |
| 渲染 | **LeaferJS**(`leafer` + 需要的 `@leafer-ui` 模块) | 2D 场景图 + 事件命中;按图层/分组建 scene graph,配合视口裁剪与批量更新 |
| UI | 原生 DOM + 轻量自研组件(树、面板、Tab) | 不引入框架:控制单文件体积;若评估后需框架,仅允许预编译无运行时组件方案 |
| 解析 | 主线程行切分 + JSON 解析,文档级**懒解析 + 模型缓存** | RA6E2 全工程打开 <1 s,Worker 化列为量级增长后的 P1 |
| ZIP | fflate(纯 JS,可内联) | `.epro2` 若为 ZIP / 用户打包 zip 的工程目录 |
| 测试 | Vitest(解析单测)+ `vite-node` headless smoke(122 文档全量渲染零异常回归)+ 无头 Chrome 截图矩阵(`scripts/qa-screens.mjs`)+ **视觉对照回归**(`scripts/ref-diff.mjs`:渲染样例页并与官方客户端 PNG 导出做像素 diff,10 页基线追踪) | Playwright e2e(file:// 双击、拖放、API)为 P1 |
| 规范 | ESLint + Prettier;Conventional Commits | — |

### 6.2 分层架构

```
┌─────────────────────────────────────────────┐
│ Shell(UI):布局/工具栏/文档树/对象树/属性面板/状态栏 │
├─────────────────────────────────────────────┤
│ Viewer API(对外):createViewer / postMessage RPC │
├─────────────────┬───────────────────────────┤
│ Interact(交互层) │ Render(Leafer 场景构建器)      │
│ 缩放/平移/命中/选中│ 图层组、LOD、视口裁剪、主题映射   │
├─────────────────┴───────────────────────────┤
│ Core Model(DocModel):项目/文档/图层/图元(格式无关)│
├─────────────────────────────────────────────┤
│ Parse Pipeline(主线程,文档级懒解析)            │
│  container(魔数探测: epro2/zip/folder/plain)  │
│   └ adapters: eprj3-fs | epro2 | zip          │
│  records: DOCHEAD/CANVAS/… → decoder registry │
└─────────────────────────────────────────────┘
```

关键决策:

- **中间模型隔离格式**:解析器输出 `Project → Doc → Layer → Primitive`(已换算统一坐标),渲染/树/属性面板只消费中间模型。新增格式(如旧 `eprj/.eprj2` SQLite 工程)只加 adapter。
- **容器探测优先**:`probe(bytes, files)` → `eprj3-folder | zip(再按 project2.json / *.epru 条目判定为 eprj3 打包或 epro2) | single-doc(单个 .esch2/.epcb2/.epan2 允许直接拖入预览)`,错误导向 UI;ZIP 条目名解码做 UTF-8 flag 检测 + GBK 兜底(实测 epro2 中文工程名场景必须)。
- **记录解码注册表**:`RecordRegistry[type] = { decode, toModel, describe }`,按 primitives/schemas 文档逐类型实现,未注册类型进"未知图元"列表;与 `validate.js`/JSON Schema 对齐做 fixture 测试。
- **按需解析**:打开工程只解析索引(eprj3 的 `.eprj3` JSON / epro2 的 SCAN 关键行);首次切换到某文档时才完整解析该文档(主线程逐行),再次打开走模型缓存。epro2 无结构索引,`.epru` 首开走 SCAN:仅解 DOCHEAD/META/PRIMITIVE 行重建文档树,几何行按文档延后解析。
- **性能三板斧**:视口裁剪(粗 AABB 索引网格)+ 图层分组显隐 + 低缩放级别 LOD(细线合并/文本按屏占比隐藏);Leafer 批量 `add`、关闭中间帧交互期间命中。
- **单文件约束**:所有资源内联(Worker 转 Blob、无 wasm 文件外挂 —— 若 epro2 需要 SQLite wasm,采用内联 base64 启动时还原,并在库版本保持可拆分)。

### 6.3 工程目录结构

```
easyeda-viewer/
├── docs/PRD.md            # 本文档
├── samples/               # 本地测试工程与官方参考截图(不入库)
├── src/
│   ├── main.ts            # 单文件应用入口(URL 参数 + postMessage 桥)
│   ├── embed.ts           # createViewer 嵌入 API
│   ├── styles.css         # 主题令牌(CSS 变量、明暗双主题)
│   ├── core/
│   │   ├── types.ts / model.ts        # 中间模型(Project/Doc/Rec、建树)
│   │   ├── parse/
│   │   │   ├── container.ts  # 魔数探测与 ZIP 展平(epro2/zip/folder/plain)
│   │   │   ├── epro2.ts      # .epru 文档流切分 + META 建树(GBK 条目名兜底)
│   │   │   ├── eprj3.ts      # 文件夹工程索引 + 文档映射
│   │   │   ├── single.ts     # 单文档 .esch2/.epcb2/.epan2/.esym2…
│   │   │   ├── records.ts    # 行记录切分与 type→解码 registry
│   │   │   └── zip.ts        # fflate 解包
│   │   └── render/
│   │       ├── layers.ts     # 图层栈/Z 序/颜色映射/对象收集
│   │       ├── pcb.ts        # PCB/PANEL 绘制器(含符号解析)
│   │       ├── sch.ts        # 原理图绘制器(含 SYMBOL/FOOTPRINT 内联解析)
│   │       └── geom.ts       # 坐标换算/path 工具/弧/焊盘几何
│   └── ui/
│       ├── shell.ts          # 布局、工具栏、缩放/输入、分隔条、状态栏
│       ├── tree.ts           # 文档树 + 分组对象树(搜索、眼睛开关)
│       ├── props.ts          # 属性面板(完整属性四段排序 + 中英翻译 + 图层列表停靠,#props-full)
│       ├── camera.ts         # 滚轮缩放/拖拽平移/定位动画
│       ├── dnd.ts            # 拖放 + 桌面桥打开
│       ├── i18n.ts           # zh/en 文案表与 setLang
│       └── icons.ts          # Lucide + EasyEDA 官方单色图标(构建期内联)
├── test/parse.spec.ts       # Vitest 解析单测
├── scripts/                 # smoke.mjs / ref-diff.mjs(视觉对照) / qa-screens.mjs / gen-icons.mjs / build-desktop.mjs
├── qa/viewer.html           # 无头 Chrome 视觉 QA 宿主(URL 参数驱动)
├── qa/diff/                 # ref-diff 输出(ours/ref/diff PNG + report.json 基线)
├── desktop/                 # Go + WebView2 免安装壳(main.go/dialogs.go/files.go/versioninfo.rc/app.ico)
└── vite.config.ts           # singlefile + 版本注入(→ dist/index.html)
```

### 6.4 构建产物

```
dist/
└── index.html              # ★ 单文件应用(全内联 ~334 kB / gzip 110 kB;双击可用、iframe 可用)

desktop/build/
└── easyeda-viewer.exe      # 免安装桌面版(内嵌同一 index.html,~7 MB)
```

独立 ESM/UMD 库产物 + `.d.ts` 发布为 P1(见 FR-6.1);现阶段嵌入方直接引 `src/embed.ts`。

---

## 7. 关键用户流程

1. **双击直开**:双击 `viewer.html` → 引导页 → 拖入工程文件夹(或 zip / .epro2 / 单文档)→ 解析进度 → 文档树出现,默认打开第一个原理图页 → 滚轮缩放、点选、树上定位。
2. **论坛/商城嵌入**:宿主页面 iframe 指向 `viewer.html` → `iframe.contentWindow.postMessage({cmd:'load'}, [bytes])` → 查看器渲染并 `postMessage({event:'load'})`。
3. **审查 PCB**:树中点 PCB1 → 图层面板关掉禁用的丝印层 → 滚轮缩小看全板、放大看细节 → 点某焊盘 → 属性面板显示图层/形状/网络 → 对象树同步高亮。
4. **多页原理图**:Tab 切换 P1/P2/P3,或用 `viewer.openPage('P2')` / postMessage 调用。

---

## 8. 里程碑

| 阶段 | 交付 | 退出标准 | 状态 |
| --- | --- | --- | --- |
| M0 骨架(1 周) | 仓库脚手架、Vite+singlefile 构建跑通、Leafer 最小画布、拖文件→行记录解析出 DOCHEAD/CANVAS 日志 | `npm run build` 出单文件,双击可开,拖入 `.esch2` 能解析出记录 | ✅ 完成 |
| M1 原理图可看(2 周) | eprj3 目录/zip/单文件加载、文档树、SCH_PAGE 核心图元渲染、缩放平移 | 参考样例工程全部原理图页正确显示;NFR-1/2 初验 | ✅ 完成(smoke 108/108;官方 PNG 对照) |
| M2 交互闭环(2 周) | 对象树(类型分组+搜索)、点选+属性面板、树↔画布双向定位、状态栏、图层眼睛开关 | FR-2/FR-5 全部 P0 通过 | ✅ 完成(e2e 自动化仍为 P1) |
| M3 PCB/面板(2-3 周) | PCB/面板渲染器、图层体系(文件图层名)、覆铜/焊盘/丝印保真(圆头走线、槽孔、固定标签、丝印镜像去重) | 样例 PCB 可浏览可交互,视觉与官方截图一致 | ✅ 完成 |
| M4 epro2 + 嵌入(1.5 周) | epro2 adapter(ZIP 解包 + `.epru` 切分 + META 建树 + GBK 条目名);createViewer API + postMessage 桥 | `RA6E2.epro2` 直开,与 eprj3 渲染一致;两种宿主方式全通 | ✅ 完成(独立库产物 `.d.ts` 为 P1) |
| M5 体验批次 | 中英双语 UI、纯图标工具栏+可输入缩放、面板宽/高拖拽、初始隐藏侧栏、右键平移、EasyEDA 品牌图标、桌面 exe 图标+版本属性 | 33 项反馈全部关闭(见 README/提交记录) | ✅ 完成(v0.2) |
| M5.5 渲染保真批次(v0.2.1) | 以官方 PNG 导出为基准逐页对照修偏:原理图边框/标题栏按文件属性、电源符号方向、顺时针旋转角、网络标签按格式位置+0.4em 抬升、文本拾取 bbox 画布实测、引脚标签对齐、隐藏文档/标题栏、跨页元件树、树方向键导航、三分类库图标、选中框恒定像素虚线、Top Paste 层序+透明度、铺铜全亮、钻孔/槽孔置顶、PCB 描边全圆头、复用块 epro2 支持、ref-diff 视觉回归管线 | 10 页样例 diff 基线建立(原理图页 1.75%~12.73%);smoke 122/122 | ✅ 完成(v0.2.1) |
| M5.6 PCB 渲染保真批次(v0.2.2) | 客户端 2D 层序栈 pcbStackKey + 图层激活置顶/常驻层压回/对面标注沉回、每面 nn/pn/pour 合成子层组;焊盘编号+网络名沿长轴双行居中(编号随焊盘方向、网络名 fit 不足隐藏、统一墨色 #f2f4f7);顶/底/内层走线网络名;网络专色(#net-colors);铺铜暗化填充+全亮包边、fineness 包边宽、孤儿 POURED 只画包边、nonzero 间隙穿透;POLYGON 轮廓焊盘+开窗、ELLIPSE 圆头、槽孔 relativeAngle、padOffset 仅钻孔、通孔挂 MULTI、封装 Multi-Layer 填充=挖槽;阻焊/助焊窗 −1000 盖油哨兵;底面透视 BOTTOM_ALPHA + M_y·R(θ) 镜像+透板 twins;FONT glyph 预矢量化文本+CARC token;图层面板重置+POLYGON 焊盘归类;欢迎卡片、面板拖放(dnd)、桌面壳改进 | ESP32S31 样例截图对照(焊盘双行/内层网络名/铺铜包边逐点核验);npm test 12/12;tsc 无警告;smoke 全绿 | ✅ 完成(v0.2.2) |
| M5.7 桌面交付与细节批次(v0.2.3) | 文档背景场景内原子切换(#bg-flash,消除 SCH↔PCB 深色闪现,像素级验证 SCH 白/PCB 深色无混合帧);网络名字号两连降至 5(mil 文档单位,焊盘/走线全局);阻焊/助焊规则外扩按 mil 直取(修 40 倍外扩,#mask-rule-unit);exe 产物名带版本号 easyeda-viewer_v{version}.exe;窗口标题栏 `EasyEDA 查看器 - v{version}`;WebView2 缺失原生弹窗 + 官方下载地址(FR-9.7);HTML favicon 内联 exe 同款 .ico(FR-8.10);缩放输入框移至适屏按钮右侧并去背景 | build-desktop 产出 v0.3.0.exe;tsc/npm test 12/12;注册表检测路径本机命中验证 | ✅ 完成(v0.2.3) |
| M6 性能与发布(持续) | LOD/裁剪调优、Worker 化评估、Playwright e2e、npm 库产物、LICENSES.txt、演示页 | NFR 全表达标;v1.0 发布 | ⏳ 进行中 |

---

## 9. 验收标准(v1 DoD)

- [x] `dist/index.html` 单文件**双击打开**,拖入 `.eprj3` 文件夹/zip、`.epro2` 样本、单个 `.esch2/.epcb2/.epan2` 均可渲染(Windows Chrome;合成拖放回归 `qa/shots/drop-proj.png`)。
- [x] 文档树/对象树/属性面板/画布交互四件套满足 §4 P0 全部条目(含双向定位、滚轮以指针为中心缩放、右键平移)。
- [x] 无头 smoke:§3.5 样本工程 + 单文档共 **122 个文档全量渲染 0 异常**(含复用块 epro2);Vitest 解析单测 12 项;视觉对照 `samples/png/` 官方截图。
- [x] 视觉保真回归:`scripts/ref-diff.mjs` 对 10 页样例(9 页原理图 + 1 PCB)与官方客户端 PNG 导出像素 diff,基线留档 `qa/diff/report.json`,改动后跑对照防回归。
- [x] PCB 渲染保真批次(v0.2.2):层序/激活置顶、焊盘标签双行布局、网络名墨色统一、铺铜包边、内层网络名等经无头 Chrome 分层截图逐点核验(`?file=` QA 宿主 + 图层面板行点击激活)。
- [ ] iframe postMessage 与 JS API 两条嵌入路径的**自动化 e2e**(Playwright)与协议示例页(P1)。
- [ ] 性能实测数字留档:5 千图元页 ≥ 30fps(devtools trace)、打开 < 1.5 s、内存曲线(NFR-2/3/5)。
- [ ] 每种已支持记录类型 ≥1 条真实 fixture 单测(现覆盖主要类型,长尾类型进行中);CI 化。
- [x] 运行期 Network 面板零请求(样例加载全程;`?file=` 为宿主显式发起,不算查看器请求)。
- [x] 中英双语 UI + 明暗主题 + chrome 参数裁剪全部可用(截图矩阵 `qa/shots/`)。
- [x] Windows 免安装 exe:图标/文件属性(FileVersion 与 package.json 同步,0.4.1)正确、拖放与原生对话框可用;产物名带版本号、标题栏 `EasyEDA 查看器 - v{version}`、WebView2 缺失弹官方下载提示(FR-9.4/9.6/9.7)。
- [x] v0.2.3 细节批次:文档切换无背景闪现(场景内 bgRect 原子重绘);网络名字号 5;阻焊外扩与官方客户端一致(规则 mil 直取);favicon=exe 同款 ico;缩放输入框位于适屏按钮右侧、无背景填充。
- [x] v0.2.4 启动提速:宿主窗口先行显示(DPI 定尺居中、同色背景刷);WebView2 profile 固定 %LOCALAPPDATA% 并注入免首启参数;计时日志定位瓶颈(可见窗口 ~1s,WebView2 环境冷启 ~4-5s 为运行时固有开销)。
- [x] v0.2.5 加载中过渡:忙碌遮罩覆盖工程加载与文档切换(SCH→PCB),阻塞前双帧让渡保证先渲染;铺铜填充亮度按官方导出实测 0.6→0.7 校正(FR-3.17)。
- [x] v0.3.4 拾取与选中批次(#pick-active-layer #select-box-path):PCB 族文档画布点选激活层优先拾取(激活层无命中回退最小 bbox 规则);导线/走线/弧/折线选中高亮沿实际路径描亮,斜走线不再出现 bbox 大斜框,恒定像素虚线;封装文档点焊盘属性面板直接展示焊盘号/形状/宽高/钻孔。无头 Chrome QA 20/20(重叠区激活层优先/回退、路径端点与角度数值贴合、缩放恒定线宽、中英界面抽查)。
- [x] v0.3.5 选中框贴合与拾取精确批次(#select-box-rot #pick-precise,#pick-active-layer 收紧):旋转非零的元件/焊盘/丝印/文本选中框按实际旋转姿态渲染闭合四角折线(selPoly,与渲染同一套旋转映射,0° 零回归);导线/走线精确命中(逐段点到线段距离 ≤ 容差,bbox 仅粗筛,L 形/斜线空区不再误选,平行导线取更近者,线类与框类按 bbox 面积定胜负保住焊盘/过孔点选);激活层拾取收紧为唯一过滤(设激活层时只命中激活层图元,无命中不选中、不穿透回退,重置/切文档清除)。无头 Chrome QA 62/62(45°/90° 旋转元件/焊盘/丝印四角边向与边长数值、0° 元件与全 0° 页零回归、缩放恒定像素、激活层切换/恢复三连、L 形空白点/线上点/平行两线取近/过孔中心优先、斜走线沿线高亮与空区不误选)。
- [x] v0.4.0 文本锚点批次(#sch-text-anchor):原理图 TEXT/STRING(含符号内文本与 PINLABEL 死分支)缺省 align 由 middle 回退改为 EasyEDA canvas em 盒语义 LEFT_BOTTOM(x=字形左缘、y=含下降部盒底),行高 1em(lineHeight 传 fontSize,leafer 数值 lineHeight 是绝对单位非 em 倍数,误传 1 会触发 fs/2 盒子扩散与基线坠底),0.05em 基线残差沿文本上轴抬回;修复大字号文本(如 ESP32-S31 页 RF-Antenna fs=30)偏移随 fontSize 线性放大的 bug。官方导出 PNG 实测 9/9 断言通过,7 处基线 Δ ≤0.7 文档单位,小字号零回归。
- [x] v0.4.0 拾取批次(#default-top-layer #fp-pad-pick #via-pick-any-layer):PCB 族文档打开默认激活顶层铜皮(只落拾取态与行高亮,不触发置顶重排);封装内焊盘注册为独立可拾取对象(选框/属性面板/面积定胜负齐备);过孔与通孔焊盘(页级与封装内)带全铜层拾取集合 pickLayers,激活任一铜层都能点中,修"顶层激活时过孔无法选中"的用户反馈;隐藏层可见性与未设激活层行为零回归,过孔与走线重叠仍按 bbox 面积定胜负。无头 Chrome QA 14/14(X86 顶层/底层/内层(16)激活点过孔选中、走线穿过过孔中心过孔胜出、重置后无激活层回归、RA6E2 封装内通孔焊盘顶层激活可点选;tsc 0 警告,vitest 12/12,smoke 122/122)。

---

## 10. 风险与对策

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| `.epru` 体量与"无结构索引"(全工程单流,样本 4.2 MB / 99 文档)导致 epro2 首开慢 | 中 | SCAN 只解关键行建树、几何文档懒加载;RA6E2.epro2 列入 NFR-2 验收测量 |
| 部分符号几何以 `ELE_PLACEHOLDER` 占位(样本单页 573 条),真彩图/字体为 BLOB/FONT 文档 | 中 | 占位按外框降级渲染 + 诊断计数;`partId` 聚合保证元件可点选;IMAGE/*.webp 可直接解码显示 |
| 复杂图元(poured 覆铜、shell 壳体、拼板)绘制保真度不足 | 中 | 按"正确率影响面"排序逐图元迭代;以真实样例截图对照为验收手段 |
| LeaferJS 超大量小图元性能不达 NFR | 中 | 视口裁剪 + 同层同色批量路径合并;压测不过则替换渲染层(中间模型不变,风险被隔离) |
| ZIP 条目名非 UTF-8(GBK/CP437,epro2 中文工程名实测乱码) | 低 | 自写条目名解码:UTF-8 flag 检测 → GBK 兜底;逻辑键一律用文档 uuid 而非条目名 |
| `file://` 下安全策略差异(Worker、FSA、ESM) | 高 | 全链路产物内联 + 传统 script 内联;CI e2e 直接在 `file://` 下跑 |
| 格式文档与真实客户端导出存在出入 | 中 | 以 examples/ 真实导出件为唯一裁判;fixture 回归 |

---

## 11. 度量与遥测

本地工具,**不采集任何用户数据**(NFR-8 一致性要求)。发布渠道(GitHub Release)统计下载数即可;仓库 CI 记录产物体积与性能基准数字(Playwright + performance trace 落盘为构建产物附件)。

## 12. 许可与署名

- **Apache License 2.0**(与本仓库 `LICENSE` 一致)。参考格式仓库(easyeda-eprj3-skill / easyeda-pro-format-skill)为 MIT,与 Apache-2.0 兼容,引用其文档/示例数据时按要求保留其版权声明。
- 依赖声明:LeaferJS、fflate、Lucide 等第三方许可清单随发布物打包(`LICENSES.txt`,**发布前待生成**,见 M6);Lucide(ISC)与 EasyEDA 官方单色图标的署名已内联在 `src/ui/icons.ts` 头注释。若引入 `NOTICE` 文件义务,一并维护。
- "嘉立创EDA / EasyEDA" 为深圳嘉立创科技集团商标,本项目为非官方第三方查看器,文档与 UI 中注明。

## 13. 开放问题(评审前补充)

1. ~~`.epro2` 容器与内部记录结构~~ **已确认**(RA6E2 样本实测):ZIP 容器 = `project2.json` + `<工程名>.epru` 全工程记录流 + `IMAGE/*.webp`,详见 §3.3。~~复用块变体~~ **已确认**(ReuseBlock_A3967 样本实测,v0.2.1 支持):`cbb_project` 工程的 `.epru` 每文档重复 DOCHEAD,见 §3.3。遗留跟进:更多工程名编码变体、`.epru` 是否存在分卷/加密场景。
2. 旧工程 `eprj/.eprj2`(SQLite)是否需要支持?当前列为 P2,请确认用户诉求。
3. ~~首版是否需要英文 UI~~ **已实现**:中英双语 UI(`?lang=zh|en` 参数 + 🌐 工具栏即时切换,FR-8.6)。
4. 对外发布形态:GitHub Pages 在线演示 + Release 下载单文件,是否同步发布 npm 包(`@easyeda/viewer` 名称可用性待查,可先用 `easyeda-viewer`)。

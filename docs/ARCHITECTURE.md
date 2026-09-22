# 技术实现总结(Architecture)

> easyeda-viewer v0.4.1 · 2026-09-22
> 嘉立创EDA专业版(EasyEDA Pro)工程轻量查看器 —— 浏览器/桌面双形态、纯前端渲染、离线可用。
>
> 配套阅读:[PRD.md](PRD.md)(需求与逐条实测依据,`#tag` 可全文检索)、[CHANGELOG.md](../CHANGELOG.md)(版本变更)、[README.md](../README.md)。

## 1. 项目定位

- **做什么**:解析并只读查看 EasyEDA Pro 的工程文件(`.eprj3` 文件夹 / `.epro2` 单文件工程、单文档 `.esch2/.epcb2/.epan2/.esym2`),渲染原理图、PCB、面板、封装与符号,提供文档树 / 对象树 / 属性面板 / 图层面板四件套交互。
- **不做什么**:不做编辑器、不做网络协同;桌面形态是**免安装单 exe**(Go + WebView2 壳内嵌同一份前端产物),不是重客户端。
- **约束**:`dist/index.html` 单文件产物可双击打开、可拖放工程文件夹/zip;全部渲染在浏览器本地完成,无任何网络请求。

## 2. 总体架构

```
┌─ 桌面壳(desktop/,Go)──────────────────────────────┐
│  //go:embed dist/index.html → 127.0.0.1 内环 HTTP   │
│  WebView2 窗口 + JS 绑定(原生文件对话框/读盘)        │
└──────────────────────┬──────────────────────────────┘
                       │ 同一份单文件前端(dist/index.html)
┌──────────────────────▼──────────────────────────────┐
│ 交互层 src/ui/(shell + 相机/拾取/选中/量测/面板)     │
├──────────────────────────────────────────────────────┤
│ 渲染层 src/core/render/(sch.ts / pcb.ts / geom.ts /  │
│          font.ts → LeaferJS Group 树 + RenderObject) │
├──────────────────────────────────────────────────────┤
│ 中间模型 src/core/types.ts + model.ts(格式无关)      │
├──────────────────────────────────────────────────────┤
│ 解析层 src/core/parse/(records 行记录 + 容器适配器)   │
│   container.ts → eprj3 / epro2 / zip / single        │
└──────────────────────────────────────────────────────┘
```

数据流:文件字节 → 容器探测 → 行记录流 → `ProjectModel`(树 + 可打开文档懒加载)→ `openDoc` 得 `OpenedDoc` → `renderDoc` 得 Leafer 根节点 + `RenderObject[]` + `RenderLayer[]` → Shell 挂树、注册拾取/图层面板。

## 3. 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 渲染引擎 | [leafer-ui](https://leaferjs.com) ^1.9 | Canvas 渲染的 Group 树,`type:'draw'` 模式,事件关闭由 `hittable:false` 自管 |
| 语言/构建 | TypeScript 5.6 + Vite 6 + `vite-plugin-singlefile` | 产物内联为单 `index.html`(约 432 kB,gzip 150 kB) |
| zip 解压 | fflate ^0.8 | 纯 JS,用于 `.epro2` 与拖放 zip |
| 单测 | vitest | `test/parse.spec.ts`,12 用例 |
| 视觉回归 | pixelmatch + pngjs + puppeteer-core | `scripts/ref-diff.mjs`,对照官方导出 PNG 逐像素 diff |
| 桌面壳 | Go + WebView2(自封装窗口过程) | `//go:embed`,windres 注入版本资源,产物约 6.9 MB |

版本号注入链:`package.json → vite.config.ts define(VITE_APP_VERSION) → 标题栏`;exe 版本资源在 `desktop/versioninfo.rc`(每次升版需同步,`.syso` 产物已 gitignore,打包时重新生成)。

## 4. 代码结构(v0.4.1,约 1.07 万行)

```
src/
├── core/
│   ├── parse/            解析层(约 750 行)
│   │   ├── records.ts      行记录语法:{outerJson}||{innerJson}|,DOCHEAD 分文档
│   │   ├── container.ts    容器探测:路径→bytes 映射判格式,产出 ProjectModel
│   │   ├── eprj3.ts        文件夹工程适配器(index JSON,UTF-8/GBK 兼容)
│   │   ├── epro2.ts        单文件工程适配器(zip:project2.json + <name>.epru 流 + IMAGE/*.webp)
│   │   ├── zip.ts          fflate 封装;single.ts 单文档直开
│   ├── model.ts          openables 收集 / 懒打开 openDoc / resolveAttrRef({=Key} 公式)
│   ├── types.ts          格式无关中间模型:Rec / DocSegment / OpenedDoc / ProjectModel / ParseReport
│   └── render/
│       ├── layers.ts     渲染编排:RenderApi/RenderObject/RenderLayer 契约 + pcbStackKey 层序
│       ├── geom.ts       几何工具:Y 翻转 xfOf、旋转手性 ang()、路径→SVG、bbox、弧采样、textFramePoly
│       ├── sch.ts        原理图/符号渲染(1304 行)
│       ├── pcb.ts        PCB/面板/封装渲染(1881 行)
│       └── font.ts       FONT 文档预矢量化字形轮廓(#font-glyph)
├── ui/
│   ├── shell.ts          主壳(1239 行):布局/相机/拾取/选中/激活层/文档切换
│   ├── camera.ts         滚轮指针缩放 / 拖拽平移 / fit
│   ├── measure.ts        量测工具(#measure,屏幕空间 canvas 覆盖层)
│   ├── props.ts          属性面板:全量解码属性检查器(#props-full)
│   ├── tree.ts           文档树 / 对象列表 / 图层列表
│   ├── units.ts          mm/mil 显示单位状态机(#unit-toggle)
│   ├── i18n.ts           中英双语;icons.ts/lucide 图标;dnd.ts 拖放与文件选择
│   └── embed.ts          嵌入式 API createViewer(loadFiles/loadMap/open/destroy)
└── main.ts               standalone 入口(读 URL 参数 + Shell 装配)

desktop/                 Go 桌面壳(main.go/desktop_windows.go/files.go/dialogs.go/versioninfo.rc)
scripts/                 build-desktop.mjs / smoke.mjs / ref-diff.mjs / qa-screens.mjs / gen-icons.mjs
test/parse.spec.ts       解析层单测
```

## 5. 解析层

### 5.1 行记录语法(records.ts)

EasyEDA Pro 文档是**按行分隔的记录流**,每行 `{outerJson}||{innerJson}|`(末行无尾 `|`),BOM 兼容:

- `outer`:轻量头(id、type、父引用等);`inner`(`data`):几何与属性正文。
- 一个物理文件可含**多个文档**,每段以 `DOCHEAD` 行开始;`META` 行携带 docType/uuid/title,是重建文档树的依据(`.epru` 流没有结构索引,树完全靠扫描 DOCHEAD+META 重建)。
- 未知记录类型不丢弃:记入 `report.unknownTypes`,状态栏与属性面板如实呈现。

### 5.2 容器探测与适配器(container.ts)

输入统一为「路径 → bytes」扁平映射(拖放展开/文件选择/zip 解压同源),按特征判格式:

| 格式 | 结构 | 适配器要点 |
| --- | --- | --- |
| `.eprj3` | 文件夹工程:`<name>.eprj3` 索引 JSON + `sch/**.esch2` + `pcb/*.epcb2` | 索引可能按 GBK 保存(中文 Windows),双编码探测 |
| `.epro2` | zip:`project2.json` + `<name>.epru` 整工程记录流 + `IMAGE/<id>.webp` BLOB | epru 无索引,扫 DOCHEAD+META 重建树;webp 注册进 `blobs` 表 |
| 单文档 | `.esch2/.epcb2/.epan2/.esym2` | single.ts 直开,`libs` 取内嵌段 |
| 拖放 zip | 任意 | 解压后走同一路径 |

### 5.3 中间模型(types.ts / model.ts)

- `Rec { id, type, data, lineNo }`;同文档记录聚成 `DocSegment`(含 `canvas`、`meta`、`recs`);工程级 `ProjectModel { tree, openables, libs… }`。
- **懒打开**:树构建只扫 DOCHEAD/META,点开文档才解析正文(大工程秒级解析不阻塞首屏)。
- `resolveAttrRef` 解析属性值里的 `={Key}` 引用(实例 → 库默认 → 设备 META 三级合并),`{Device}` 指设备标题而非 uuid。

## 6. 渲染层

### 6.1 编排契约(layers.ts)

`renderDoc(opened, bgColor)` 按 `docType` 分派 `renderSch` / `renderPcb`,产出:

- `root: Group` —— 场景树(PCB 族按 `pcbStackKey` 升序重排层组,leafer 后加者在上);
- `objects: RenderObject[]` —— **拾取/树/属性面板共用的扁平对象表**,关键字段:

| 字段 | 用途 |
| --- | --- |
| `bbox` | 世界坐标包围盒(粗拾取 + 对象树定位 + 相机 fit) |
| `hit(wx,wy,tol)` | 描边类精确命中回调(空心矩形内部点击不选中,#23) |
| `layerKey` | 实际落定的层组 key(含 `pour:/pn:/nn:` 合成组)——隐藏判定与激活层过滤的依据 |
| `pathPts` | 线类图元绘制路径顶点 —— 选中高亮沿路径贴合(#select-box-path)、逐段精确拾取(#pick-precise) |
| `selPoly` | 旋转非零框类图元的四角外框 —— 选中框贴合旋转姿态(#select-box-rot) |
| `pickLayers` | 通孔类对象贯穿的铜层集合 —— 激活任一铜层可点中(#via-pick-any-layer) |

- `layers: RenderLayer[]` —— 图层面板数据(`id/name/color/show/type/count/group`);
- `nodeIndex` —— leafer 节点 → 对象 反查表;`constantTexts/constantStrokes` —— 恒定像素标注注册表(相机回调里按 `1/scale` 回写字号/线宽)。

### 6.2 PCB 层序栈(pcbStackKey)

与客户端 2D 视图一致的**从底到顶**画序:标注层(机械/文档/引脚/3D)< 底面(装配→助焊→阻焊→铜皮→网络名→焊盘号→丝印)< 内层(inner32…inner1)< 顶面(同底面序)< 多层组 MULTI(通孔铜永远盖两面)< 板框 < 原点轴/飞线 < 钻孔(最顶,铜皮不盖孔)。有文件 `LAYER` 记录时按 `layerType` 判定,缺失时按数字层号表 `NUM_STACK` 兜底。合成组:`pour:{face}`(铺铜,沉在阻焊之下)、`pn:{face}/nn:{face}`(焊盘号/网络名标注层)。

### 6.3 坐标系与变换约定(geom.ts)

- **双 Y 约定**:PCB 族记录 Y-up(渲染镜像到屏幕),原理图族 Y-down;`xfOf(canvas, up)` 统一产出翻转器,`X()/Y()/P()` 为唯一入口。
- **旋转手性**:EasyEDA 角度是顺时针而三角函数是逆时针,`ang()` 在 Y-down 页取负、Y-up 页保留原角;镜像×旋转复合遵循 **R·M(Y-up)/ M·R(Y-down) 共轭**(#mirror-rot-order,用导线端点 735/737 命中实测校准)。
- **迁移页兼容**(≥3.2.91 客户端):整页 Y 取反 + `CANVAS.yAxisDirection:"up"`(#x86-esch2-flip),对齐字符串始终屏幕锚定。
- 弧支持三点式(referX/referY 在弧上)与角度式两套,采样为折线顶点供拾取复用;`textFramePoly` 与渲染端同一锚点语义(文本缺省 LEFT_BOTTOM em 盒,#sch-text-anchor)。

### 6.4 原理图渲染要点(sch.ts)

- 符号按 `partId` 展开绘制(元件记录只存位置/旋转,几何在页内展开);电源符号方向 180° 矫正;引脚标签 `NAME/NUMBER` 大小写历史键兼容。
- **图框与标题栏**:新式 Drawing-Symbol 内嵌 TABLE(单元格 `={@Key}` 按合并属性表解析);旧式 Sheet-Symbol_* 用艺术字 + ATTR 槽位;迁移页实例 Width/Height 覆盖所引图框尺寸(#border-size-override),art 缺失时按 `TB_*` 常量表合成标准标题栏,#@ 系统属性(页名/页号/日期)动态合成(#titleblock-sysattrs)。
- **属性可见性**:严格按实例 `valueVisible === true` 显示,豁免网络标志/端口的 Name/GNN(#attr-visibility);同网络交叉自动合成连接点;NO_CONNECT 按引脚实时端点定位(位置缓存失效的迁移页不误画)。
- 网络标签缺省锚点 = 导线上方 0.4em 抬升;lineHeight 是 leafer 绝对单位而非 em 倍数(传 fontSize 才是 1em,#net-gap)。

### 6.5 PCB 渲染要点(pcb.ts)

- **层驱动配色**:优先文件 `LAYER` 记录的 `activeColor`,缺失回退标准色板;网络专色、网络名统一墨色。
- **焊盘**:圆/矩形/圆头/椭圆/多边形(POLYGON 按 as-is 顶点),SMD 归面层、通孔挂 MULTI;阻焊/助焊窗按规则外扩(mil 直取,#mask-rule-unit),`-1000` 哨兵 = 盖油;编号+网络名沿长轴双行居中,渲染进 `pn:/nn:` 合成层。
- **铺铜**:POURED 暗化填充 + 全亮包边(fineness 定包边宽,孤儿 POURED 只画包边);走线全圆头;槽孔 relativeAngle;封装 Multi-Layer 填充 = 挖槽。
- **文本**:自绘字体走 FONT 文档预矢量化轮廓路径(#font-glyph),默认字体回退系统字体(README 已知项)。
- **底面透视**:BOTTOM_ALPHA 半透明 + `M_y·R(θ)` 镜像 + 透板 twins。

## 7. 交互层(ui/)

### 7.1 Shell 主壳(shell.ts)

- **布局**:工具栏(纯图标 + 可输入缩放 + 单位/语言/主题按钮)、左列(文档树/对象列表,可拖宽)、右列(属性/图层,选中或存在层时出现)、状态栏(坐标/消息);面板均支持强制显隐与拖拽分栏。
- **文档切换**:忙碌遮罩覆盖大文档解析(#loading,先双帧让渡再阻塞),原理图页切换免遮罩防卡顿(#page-switch-jank);背景矩形在场景内原子重绘防闪色(#bg-flash)。
- **激活层语义**(#pick-active-layer / #default-top-layer / #via-pick-any-layer):点击图层面板行 = 激活层(完整置顶 + 拾取优先);打开 PCB 族默认激活顶层铜皮(只落拾取态与行高亮,**不触发置顶重排**);重置按钮恢复默认栈序并清除激活。激活层过滤为**独占语义** —— 激活层无命中即空白,绝不回退穿透;通孔类对象按 `pickLayers` 铜层全集放行。
- **画布点选**(`onCanvasClick`,核心算法):
  1. 过滤隐藏层(按 `layerKey`)与激活层独占过滤(`layerKey !== act && !pickLayers?.includes(act)` 即淘汰);
  2. 线类(`pathPts ≥ 2`)逐段点到线段距离 ≤ `6/camera.scale` 精确命中(#pick-precise),bbox 只作扩容差粗筛,**不过不回退**;
  3. 线类取距离最小者,非线类取 bbox 面积最小者;两类并存按 bbox 面积定胜负 —— 走线端点落在焊盘/过孔中心不抢小目标,铺铜空腔 bbox 不抢走线。
- **选中高亮**:线类沿 `pathPts` 描亮,旋转图元按 `selPoly` 四角闭合,其余 bbox 矩形;恒定像素虚线(2px,4 开 3 关)随缩放不变。
- **对象列表**:原理图按 symbolType(docType 2/17)判真元件,列表跨本原理图全部图页并支持跨页跳转(#component-tree);位号自然排序(前缀 + 数字);行签名 diff 免重建 DOM。

### 7.2 相机与量测

- `camera.ts`:滚轮指针处缩放、拖拽平移、fit;`onView` 回调驱动缩放输入框、恒定像素标注重算、量测重投影。
- `measure.ts`(#measure):仅 PCB 族;屏幕空间独立 canvas —— 满屏十字光标、三角形标尺(斜边=测量线,直角边 1/2/5×10ⁿ 等间隔刻度从线单侧长出)、|ΔX|/|ΔY|/距离读数;白色 1px 主线双描增强 + 暗晕衬底;退出语义:再点按钮/右键 = 清空标尺退出,Esc = 退出留标尺,切文档 = 清空。

### 7.3 属性 / 单位 / 嵌入

- `props.ts`:全量属性检查器 —— 坐标行、关键属性带、逐字段解码(尺寸按当前单位换算、色值带色块、对象值递归缩进),单位切换即时重建(#unit-toggle)。
- `units.ts`:mm/mil 全局状态 + 订阅广播;换算基准按文档族(PCB/封装 1 单位 = 1mil,原理图/面板 1 单位 = 0.254mm = 10mil),只作用于显示层,存储与画布不动。
- `embed.ts`:`createViewer(host, opts)` → `{ loadFiles, loadMap, open, destroy }`,宿主可用 postMessage 桥接(见 main.ts)。

## 8. 桌面交付(desktop/)

- **模式**:Go `//go:embed dist/index.html` → `127.0.0.1` 内环 HTTP → WebView2 窗口 → JS 绑定(`openFileDialog / openFolderDialog / readProjectFiles`),前端探测到绑定后替代 `<input type=file>`(dnd.ts desktopBridge)。
- **启动体验**:宿主窗口先行按 DPI 定尺显示(WebView2 冷启秒级阻塞期不白屏);WebView2 profile 固定 `%LOCALAPPDATA%\EasyEDAViewer\WebView2` 并裁剪首启工作;COM/对话框固定 STA 单线程。
- **打包链**(`scripts/build-desktop.mjs` 三步):`vite build` → dist 拷贝 + windres 编译 `versioninfo.rc` 生成 `.syso`(版本号/图标,已 gitignore)→ `go build` 产出 `easyeda-viewer_v{version}.exe`;WebView2 缺失时原生弹官方下载页;窗口标题栏带版本。
- `go.mod` 仅 5 行(纯标准库 + webview),无第三方运行时依赖。

## 9. 质量保障

| ��段 | 范围 | 入口 |
| --- | --- | --- |
| 类型检查 | 全量 | `npx tsc --noEmit` |
| 单元测试 | 解析层(records/容器/模型)12 用例 | `npm test` |
| 冒烟渲染 | 全部样例工程逐文档过 renderDoc,122 项断言 | `npm run smoke`(vite-node 无头 DOM shim) |
| 视觉回归 | 官方导出 PNG 为基准,两遍相机对齐 + pixelmatch 逐像素 diff,基线 10 页 | `npx vite-node -c vite.smoke.config.ts scripts/ref-diff.mjs` |
| 交互 QA | puppeteer-core + 本机 Chrome 接 `http://localhost:5177`,经 `window.__ev.shell` 驱动(loadFiles/select/objects)截图与断言 | 临时脚本放项目根 `tmp/`(gitignore) |

验证惯例:任何行为修复都要有像素级或数值级 QA 证据(如文本锚点 9/9 断言、基线 Δ ≤ 0.7 文档单位;过孔拾取 QA 14/14),并回写 PRD 对应 `#tag` 条目与 CHANGELOG。

## 10. 关键设计决策精选

| #tag | 决策 | 依据 |
| --- | --- | --- |
| #pick-active-layer | 激活层独占拾取,无命中即空白不穿透 | 用户明确需求(与 EDA 客户端习惯一致) |
| #via-pick-any-layer | 通孔对象带全铜层 pickLayers 集合,激活任一铜层可点中 | 通孔物理上贯穿全部铜层 |
| #pick-precise | 线类逐段点到线段距离判定,bbox 仅粗筛 | L 形/斜线 bbox 空区误选 |
| #select-box-rot | 旋转图元选中框用世界四角折线 | 与客户端贴合旋转姿态一致 |
| #default-top-layer | 默认顶层激活不触发置顶重排 | 打开即重排会改写每块板的初始外观 |
| #sch-text-anchor | 缺省文本锚点 = canvas em 盒 LEFT_BOTTOM,行高 1em | 官方导出 PNG 实测,偏移随字号线性放大 |
| #mirror-rot-order | 镜像×旋转按 Y 手性取 R·M 或 M·R 共轭 | 导线端点命中 735/737 实测 |
| #border-size-override | 页面尺寸以图框实例属性为准,不信 CANVAS 声明 | 迁移页 CANVAS 常写默认 A4 |
| #mask-rule-unit | 阻焊外扩按 mil 直取 | 修 40 倍外扩 |
| #font-glyph | 自绘字体走 FONT 文档预矢量化轮廓 | 字体路径未存文件,无法运行时排版 |
| #loading | 忙碌遮罩先双帧让渡再阻塞解析 | rAF 回调仍在本帧绘制,单帧遮罩永远上不了屏 |
| #page-switch-jank | 原理图切页免遮罩 + 对象列表行签名 diff | 小页开 ~100ms,遮罩等待全是纯延迟 |

完整决策清单见 [PRD.md](PRD.md) 各 FR 条目(98 处 `#tag` 标注)。

## 11. 已知边界

- **盲埋孔**:样例暂无,VIA 起止层未解析,`pickLayers` 缺省视为全铜层;将来按起止层收敛。
- **默认字体**:EDA 客户端默认字体是自绘路径且未存入文件,查看器回退系统字体,观感有差(README 已知问题)。
- **POLYGON 封装内焊盘**:拾取分支无样例实测。
- **过孔隐藏语义**:过孔归 MULTI 组,单面隐藏时仍可见(跟随现状,未按面过滤)。
- **epro2 内部结构未公开**:以样本实测为准,未知记录类型如实上报不猜测。

## 12. 开发速查

```bash
npm run dev          # vite dev server(:5177,QA 也用它)
npm run check        # tsc --noEmit
npm test             # vitest(12 用例)
npm run smoke        # 全样例冒烟渲染(122 项)
npm run build        # tsc + vite 单文件产物
node scripts/build-desktop.mjs   # exe 交付链(版本号先改 package.json + versioninfo.rc)
```

每次版本号更新:改 `package.json` → 同步 `desktop/versioninfo.rc` → 在 `CHANGELOG.md` 补条目 → PRD §9 交付清单勾选 → `node scripts/build-desktop.mjs` 重打 exe。

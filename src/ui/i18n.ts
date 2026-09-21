/**
 * Tiny i18n layer: zh/en UI strings, record-type and attribute-name labels.
 * `?lang=zh|en` / postMessage cmd {lang} / toolbar globe toggle drive setLang().
 */
export type Lang = 'zh' | 'en';

let current: Lang = 'zh';

export function setLang(lang: Lang): void {
  current = lang === 'en' ? 'en' : 'zh';
}
export function getLang(): Lang {
  return current;
}

const STR: Record<Lang, Record<string, string>> = {
  zh: {
    appTitle: 'EasyEDA 查看器',
    tipFiles: '打开工程文件', tipFolder: '打开工程文件夹',
    tipZoomIn: '放大', tipZoomOut: '缩小', tipFit: '缩放到全部内容',
    tipMeasure: '量测距离(PCB/封装)',
    measureHint: '量测:左键点起点、再点终点,可连续量测多把;再次点击按钮或右键=清空标尺退出,Esc=退出保留标尺',
    measureDist: '距离',
    tipTheme: '切换明暗主题', tipPanelL: '显示/隐藏左侧面板', tipPanelR: '显示/隐藏右侧面板',
    tipLang: 'English', tipUnit: '切换单位 mm/mil',
    zoomPh: '缩放比例',
    welcomeTitle: '拖放 EasyEDA 工程到此处',
    welcomeExt: '.eprj3 / .epro2 工程包,或单个 .esch2 / .epcb2 / .epan2 文档',
    btnOpenFiles: '打开文件…', btnOpenFolder: '打开文件夹…',
    welcomeLocal: '解析与渲染全部在本地完成,文件不会离开这台设备',
    deviceNoGraphics: '器件库无图形,仅包含属性',
    dropHint: '松开以打开',
    statusInit: '拖入 .eprj3 / .epro2 工程或单个文档文件开始',
    statusLoaded: '已加载 {fmt} 工程:{docs} 个可打开文档、{files} 个文件。点击左侧文档树打开。',
    statusOpened: '{title}:{n} 个对象、{m} 个图层',
    statusBadLines: '{n} 行解析失败',
    statusPlaceholders: '{n} 个占位符',
    statusUnknownTypes: '未支持类型: {types}',
    statusFail: '加载失败:',
    statusEmptyDrop: '未读取到拖入的文件(可能被系统或其他程序拦截),请改用「打开文件…」按钮选择',
    loadingProject: '加载工程中…',
    loadingDoc: '渲染文档中…',
    paneTree: '文档树', paneObjects: '元件树', paneLayers: '图层',
    searchPh: '搜索…',
    noObjects: '暂无对象',
    noLayers: '当前文档没有图层',
    layerEmptyDoc: '原理图文档没有图层',
    layerShowAll: '全部显示',
    layerHideAll: '全部隐藏',
    layerReset: '重置图层（恢复默认层叠并全部显示）',
    propsHint: '点击画布中的图元查看属性',
    secIdent: '标识', secGeom: '几何', secLayer: '图层与网络', secStyle: '外观',
    mil: 'mil', deg: '°',
    yes: '是', no: '否',
    pourEdge: '包边',
    grpCount: '{type} · {n}',
    unitTitle: '单位:坐标为 mil(1 mil = 0.0254 mm)',
  },
  en: {
    appTitle: 'EasyEDA Viewer',
    tipFiles: 'Open project file', tipFolder: 'Open project folder',
    tipZoomIn: 'Zoom in', tipZoomOut: 'Zoom out', tipFit: 'Zoom to fit',
    tipMeasure: 'Measure distance (PCB/footprint)',
    measureHint: 'Measure: left-click the start point, then the end point — repeatable; click the button again or right-click to clear all rulers and exit, Esc keeps the rulers',
    measureDist: 'Dist',
    tipTheme: 'Toggle light/dark theme', tipPanelL: 'Show/hide left panel', tipPanelR: 'Show/hide right panel',
    tipLang: '中文', tipUnit: 'Toggle unit mm/mil',
    zoomPh: 'Zoom level',
    welcomeTitle: 'Drop an EasyEDA project here',
    welcomeExt: '.eprj3 / .epro2 project, or a single .esch2 / .epcb2 / .epan2 document',
    btnOpenFiles: 'Open file…', btnOpenFolder: 'Open folder…',
    welcomeLocal: 'Parsing and rendering happen 100% locally — files never leave this device',
    deviceNoGraphics: 'Device library has no graphics — attributes only',
    dropHint: 'Drop to open',
    statusInit: 'Drop an .eprj3 / .epro2 project or a single document to start',
    statusLoaded: 'Loaded {fmt} project: {docs} openable documents, {files} files. Click a document in the tree to open it.',
    statusOpened: '{title}: {n} objects, {m} layers',
    statusBadLines: '{n} lines failed to parse',
    statusPlaceholders: '{n} placeholders',
    statusUnknownTypes: 'Unsupported types: {types}',
    statusFail: 'Load failed: ',
    statusEmptyDrop: 'No readable file in the drop (it may have been intercepted) — use the Open file… button instead',
    loadingProject: 'Loading project…',
    loadingDoc: 'Rendering document…',
    paneTree: 'Documents', paneObjects: 'Component tree', paneLayers: 'Layers',
    searchPh: 'Search…',
    noObjects: 'No objects',
    noLayers: 'This document has no layers',
    layerEmptyDoc: 'Schematic documents have no layers',
    layerShowAll: 'Show all layers',
    layerHideAll: 'Hide all layers',
    layerReset: 'Reset layers (restore default stack, show all)',
    propsHint: 'Click a primitive on the canvas to inspect it',
    secIdent: 'Identity', secGeom: 'Geometry', secLayer: 'Layer & net', secStyle: 'Appearance',
    mil: 'mil', deg: '°',
    pourEdge: 'edge spacing',
    grpCount: '{type} · {n}',
    unitTitle: 'Units: coordinates in mil (1 mil = 0.0254 mm)',
  },
};

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = STR[current][key] ?? STR.zh[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
  return s;
}

/** record / document type → human label (object-tree groups, props header) */
const TYPES: Record<Lang, Record<string, string>> = {
  zh: {
    COMPONENT: '元件', WIRE: '连线', NET: '网络', PAD: '焊盘', LINE: '线段', TRACK: '导线',
    ARC: '圆弧', POLY: '多边形', FILL: '填充', REGION: '区域', POUR: '覆铜', POURED: '覆铜(实心)',
    VIA: '过孔', STRING: '文本', TEXT: '文本', IMAGE: '位图轮廓', RECT: '矩形', CIRCLE: '圆',
    ELLIPSE: '椭圆', DIMENSION: '尺寸标注', HOLE: '独立钻孔', TEARDROP: '泪滴',
    PATTERN: '图案', PANELIZE: '拼板', PRIMITIVE: '图元', ATTR: '属性', LAYER: '图层',
    BOARD: '板子', SHEET: '原理图页', PCB: 'PCB', PANEL: '面板', SYMBOL: '符号', FOOTPRINT: '封装',
    DEVICE: '器件', SIMULATION: '仿真', SIMULATION_SCH: '仿真原理图', SCH_PAGE: '原理图页',
    LIBRARY: '库', PROJECT: '工程', CANVAS: '画布', META: '元数据', PART: '符号部分',
    GROUP: '分组', RULE: '设计规则', RULE_NET: '网络规则', PAD_STACK: '焊盘叠层',
    RULE_TEMPLATE: '规则模板', RULE_DIFF_PAIR: '差分对规则', RULE_EQUAL_LENGTH: '等长规则',
    COMPONENT_GROUP: '元件分组', ELE_PLACEHOLDER: '占位图元', DOCHEAD: '文档头', TABLE: '表格',
    PIN: '引脚', NET_LABEL: '网络标签', NET_FLAG: '网络旗标', SHORT_CIRCUS: '短接点',
    BUS: '总线', PORT: '端口',
  },
  en: {
    COMPONENT: 'Components', WIRE: 'Wires', NET: 'Nets', PAD: 'Pads', LINE: 'Lines', TRACK: 'Tracks',
    ARC: 'Arcs', POLY: 'Polygons', FILL: 'Fills', REGION: 'Regions', POUR: 'Copper pours', POURED: 'Poured copper',
    VIA: 'Vias', STRING: 'Text', TEXT: 'Text', IMAGE: 'Glyph outlines', RECT: 'Rectangles', CIRCLE: 'Circles',
    ELLIPSE: 'Ellipses', DIMENSION: 'Dimensions', HOLE: 'Holes', TEARDROP: 'Teardrops',
    PATTERN: 'Patterns', PANELIZE: 'Panelization', PRIMITIVE: 'Primitives', ATTR: 'Attributes', LAYER: 'Layers',
    BOARD: 'Board', SHEET: 'Sheets', PCB: 'PCB', PANEL: 'Panel', SYMBOL: 'Symbol', FOOTPRINT: 'Footprint',
    DEVICE: 'Device', SIMULATION: 'Simulation', SIMULATION_SCH: 'Sim schematic', SCH_PAGE: 'Sheet',
    LIBRARY: 'Library', PROJECT: 'Project', CANVAS: 'Canvas', META: 'Meta', PART: 'Symbol part',
    GROUP: 'Groups', RULE: 'Design rules', RULE_NET: 'Net rules', PAD_STACK: 'Pad stacks',
    RULE_TEMPLATE: 'Rule templates', RULE_DIFF_PAIR: 'Diff-pair rules', RULE_EQUAL_LENGTH: 'Equal-length rules',
    COMPONENT_GROUP: 'Component groups', ELE_PLACEHOLDER: 'Placeholders', DOCHEAD: 'Doc header', TABLE: 'Table',
    PIN: 'Pins', NET_LABEL: 'Net labels', NET_FLAG: 'Net flags', SHORT_CIRCUS: 'Junctions',
    BUS: 'Bus', PORT: 'Port',
  },
};
export function typeLabel(type: string): string {
  return TYPES[current][type] ?? TYPES.zh[type] ?? type;
}

/**
 * Raw record data key → user-friendly label (properties panel).
 * Two families of keys live here:
 *  - built-in ATTR property names (Designator / Value / 'Global Net Name' …),
 *    i.e. the fixed enum of property names the EDA client itself defines;
 *  - raw record data fields (netName / viaType / plated …) shown decoded.
 * Untranslated keys pass through unchanged (custom attributes keep their raw name).
 */
const ATTRS: Record<Lang, Record<string, string>> = {
  zh: {
    // geometry / drawing fields
    x: 'X', y: 'Y', x1: '起点 X', y1: '起点 Y', x2: '终点 X', y2: '终点 Y',
    centerX: '中心 X', centerY: '中心 Y', startX: '起点 X', startY: '起点 Y',
    endX: '终点 X', endY: '终点 Y', rotation: '旋转', angle: '角度', padAngle: '焊盘角度',
    relativeAngle: '相对角度', layerId: '图层', layer: '图层', net: '网络', netName: '网络',
    text: '文本', value: '值', name: '名称', designator: '位号', num: '引脚号',
    padNumber: '焊盘号', circleRadius: '半径', cornerRadius: '圆角半径',
    fontSize: '字号', fontFamily: '字体', fontWeight: '字重', strokeWidth: '线宽',
    width: '宽', height: '高', radius: '圆角半径', radiusX: '半径 X', radiusY: '半径 Y',
    shape: '形状', padType: '焊盘形状', hole: '钻孔', holeType: '孔型', holeDiameter: '钻孔直径',
    viaDiameter: '过孔直径', viaType: '过孔类型', diameter: '直径', points: '顶点', closed: '闭合',
    color: '颜色', fillColor: '填充色', strokeColor: '线色', specialColor: '特殊颜色',
    bold: '加粗', italic: '斜体', underline: '下划线', strikeout: '删除线',
    align: '对齐', origin: '对齐', reverse: '翻转', mirror: '镜像', isMirror: '镜像',
    lock: '锁定', locked: '锁定', ratelock: '锁定网络', opacity: '不透明度',
    fileName: '文件名', length: '长度', electric: '电气特性', pinShape: '引脚形状',
    ruleName: '适用规则', plated: '金属化孔', padOffsetX: '焊盘偏移 X', padOffsetY: '焊盘偏移 Y',
    topSolderExpansion: '顶层阻焊扩展', bottomSolderExpansion: '底层阻焊扩展',
    topPasteExpansion: '顶层助焊扩展', bottomPasteExpansion: '底层助焊扩展',
    connectMode: '连接方式', spokeSpace: '辐条间距', spokeWidth: '辐条宽度', spokeAngle: '辐条角度',
    unusedInnerLayers: '未使用内层', padLen: '焊盘长度', propagationDelay: '传播延迟',
    specialPad: '特殊焊盘', pourType: '覆铜方式', fineness: '包边间距', keepIsland: '保留孤岛',
    isBridgingCopper: '桥接铜皮', order: '优先级', polyType: '多边形类型', fillStyle: '填充样式',
    strokeStyle: '线条样式', arcType: '圆弧类型', prohibitType: '禁止对象',
    precision: '数字精度', accuracy: '精度', unit: '单位', textFollow: '文本跟随',
    transScope: '处理范围', display: '显示',
    regionType: '区域类型', dimensionType: '标注类型', type: '类型', defaultPad: '默认焊盘',
    displayFill: '填充显示', displayStroke: '描边显示', valueVisible: '值可见', keyVisible: '名可见',
    valid: '有效', visible: '可见', cover: '覆盖', autoClose: '自动闭合',
    gridXSize: '网格宽', gridYSize: '网格高', thickness: '厚度',
    // (mostly internal) record control fields — kept labeled for completeness
    zIndex: '层级', id: 'ID', ticket: '记录号', uuid: 'UUID',
    symbol: '符号', footprint: '封装', device: '器件',
    matrix: '变换矩阵', path: '路径', ploys: '轮廓', coords: '坐标', pourFill: '覆铜填充',
    // built-in ATTR property names (the EDA client's fixed property enum)
    Symbol: '符号', Footprint: '封装', Device: '器件', '3D Model': '3D 模型',
    '3D Model Transform': '3D 模型变换',
    Designator: '位号', Name: '名称', Value: '值',
    'Global Net Name': '全局网络名', 'Add into BOM': '加入 BOM',
    'Pin Name': '引脚名', 'Pin Number': '引脚号', 'Pin Type': '引脚类型',
    'Simulide Pin': '仿真引脚', 'NGspice Pin': 'NGspice 引脚',
    NET: '网络', Relevance: '关联', NAME: '名称', NUMBER: '编号',
    'Reuse Block': '复用块', 'Unique ID': '唯一 ID', 'Group ID': '组 ID', 'Channel ID': '通道 ID',
    'Convert to PCB': '转换为 PCB', Description: '描述', Company: '公司',
    Drawed: '设计', Reviewed: '审核', 'Part Number': '部件编号', Version: '版本',
    'Page Size': '页面大小', Border: '边框', 'Title Block': '标题栏',
    'Title Block Position': '标题栏位置', Size: '尺寸',
    'Region Start': '区域起点', 'X Region Count': 'X 区域数', 'Y Region Count': 'Y 区域数',
    'Blade Width': '切割刀宽', Color: '颜色', NO_CONNECT: '不连接',
    'LCSC Part Name': '立创商城品名', 'Supplier Part': '供应商编号',
    Manufacturer: '制造商', 'Manufacturer Part': '制造商编号', 'Supplier Footprint': '供应商封装',
    'JLCPCB Part Class': '嘉立创器件类别', Datasheet: '数据手册', Supplier: '供应商',
    Testpoint: '测试点', Tolerance: '公差', 'Voltage Rating': '额定电压',
    // @-system attributes (page/board/project info resolved by the title block)
    '@Project Name': '工程名称', '@Page Name': '页面名称', '@Page No': '页码', '@Page Count': '总页数',
    '@Schematic Name': '原理图名称', '@Board Name': '板子名称',
    '@Update Date': '更新日期', '@Update Time': '更新时间',
    '@Create Date': '创建日期', '@Create Time': '创建时间',
  },
  en: {
    x: 'X', y: 'Y', x1: 'From X', y1: 'From Y', x2: 'To X', y2: 'To Y',
    centerX: 'Center X', centerY: 'Center Y', startX: 'Start X', startY: 'Start Y',
    endX: 'End X', endY: 'End Y', rotation: 'Rotation', angle: 'Angle', padAngle: 'Pad angle',
    relativeAngle: 'Relative angle', layerId: 'Layer', layer: 'Layer', net: 'Net', netName: 'Net',
    text: 'Text', value: 'Value', name: 'Name', designator: 'Designator', num: 'Pin',
    padNumber: 'Pad number', circleRadius: 'Radius', cornerRadius: 'Corner radius',
    fontSize: 'Font size', fontFamily: 'Font', fontWeight: 'Font weight', strokeWidth: 'Stroke width',
    width: 'Width', height: 'Height', radius: 'Corner radius', radiusX: 'Radius X', radiusY: 'Radius Y',
    shape: 'Shape', padType: 'Pad shape', hole: 'Drill', holeType: 'Drill type', holeDiameter: 'Drill diameter',
    viaDiameter: 'Via diameter', viaType: 'Via type', diameter: 'Diameter', points: 'Vertices', closed: 'Closed',
    color: 'Color', fillColor: 'Fill', strokeColor: 'Stroke', specialColor: 'Special color',
    bold: 'Bold', italic: 'Italic', underline: 'Underline', strikeout: 'Strikethrough',
    align: 'Align', origin: 'Alignment', reverse: 'Reverse', mirror: 'Mirror', isMirror: 'Mirror',
    lock: 'Locked', locked: 'Locked', ratelock: 'Ratlines locked', opacity: 'Opacity',
    fileName: 'File name', length: 'Length', electric: 'Electrical', pinShape: 'Pin shape',
    ruleName: 'Rule', plated: 'Plated', padOffsetX: 'Pad offset X', padOffsetY: 'Pad offset Y',
    topSolderExpansion: 'Top solder expansion', bottomSolderExpansion: 'Bottom solder expansion',
    topPasteExpansion: 'Top paste expansion', bottomPasteExpansion: 'Bottom paste expansion',
    connectMode: 'Connect mode', spokeSpace: 'Spoke gap', spokeWidth: 'Spoke width', spokeAngle: 'Spoke angle',
    unusedInnerLayers: 'Unused inner layers', padLen: 'Pad length', propagationDelay: 'Propagation delay',
    specialPad: 'Special pad', pourType: 'Pour type', fineness: 'Edge spacing', keepIsland: 'Keep islands',
    isBridgingCopper: 'Bridging copper', order: 'Order', polyType: 'Polygon type', fillStyle: 'Fill style',
    strokeStyle: 'Stroke style', arcType: 'Arc type', prohibitType: 'Prohibited objects',
    precision: 'Precision', accuracy: 'Precision', unit: 'Unit', textFollow: 'Text follow',
    transScope: 'Processing scope', display: 'Display',
    regionType: 'Region type', dimensionType: 'Dimension type', type: 'Type', defaultPad: 'Default pad',
    displayFill: 'Show fill', displayStroke: 'Show stroke', valueVisible: 'Value visible', keyVisible: 'Name visible',
    valid: 'Valid', visible: 'Visible', cover: 'Cover', autoClose: 'Auto close',
    gridXSize: 'Grid width', gridYSize: 'Grid height', thickness: 'Thickness',
    zIndex: 'Stacking', id: 'ID', ticket: 'Record', uuid: 'UUID',
    symbol: 'Symbol', footprint: 'Footprint', device: 'Device',
    matrix: 'Matrix', path: 'Path', ploys: 'Outline', coords: 'Coords', pourFill: 'Pour fill',
    Symbol: 'Symbol', Footprint: 'Footprint', Device: 'Device', '3D Model': '3D model',
    '3D Model Transform': '3D model transform',
    Designator: 'Designator', Name: 'Name', Value: 'Value',
    'Global Net Name': 'Global net name', 'Add into BOM': 'Add into BOM',
    'Pin Name': 'Pin name', 'Pin Number': 'Pin number', 'Pin Type': 'Pin type',
    'Simulide Pin': 'Simulide pin', 'NGspice Pin': 'NGspice pin',
    NET: 'Net', Relevance: 'Relevance', NAME: 'Name', NUMBER: 'Number',
    'Reuse Block': 'Reuse block', 'Unique ID': 'Unique ID', 'Group ID': 'Group ID', 'Channel ID': 'Channel ID',
    'Convert to PCB': 'Convert to PCB', Description: 'Description', Company: 'Company',
    Drawed: 'Drawed', Reviewed: 'Reviewed', 'Part Number': 'Part number', Version: 'Version',
    'Page Size': 'Page size', Border: 'Border', 'Title Block': 'Title block',
    'Title Block Position': 'Title block position', Size: 'Size',
    'Region Start': 'Region start', 'X Region Count': 'X region count', 'Y Region Count': 'Y region count',
    'Blade Width': 'Blade width', Color: 'Color', NO_CONNECT: 'No connect',
    'LCSC Part Name': 'LCSC part name', 'Supplier Part': 'Supplier part',
    Manufacturer: 'Manufacturer', 'Manufacturer Part': 'Manufacturer part', 'Supplier Footprint': 'Supplier footprint',
    'JLCPCB Part Class': 'JLCPCB part class', Datasheet: 'Datasheet', Supplier: 'Supplier',
    Testpoint: 'Testpoint', Tolerance: 'Tolerance', 'Voltage Rating': 'Voltage rating',
    '@Project Name': 'Project name', '@Page Name': 'Page name', '@Page No': 'Page no.', '@Page Count': 'Page count',
    '@Schematic Name': 'Schematic name', '@Board Name': 'Board name',
    '@Update Date': 'Update date', '@Update Time': 'Update time',
    '@Create Date': 'Create date', '@Create Time': 'Create time',
  },
};
export function attrLabel(key: string): string {
  return ATTRS[current][key] ?? ATTRS.zh[key] ?? key;
}

/** standard PCB layer names carried by LAYER records (EasyEDA Pro English
 *  names, matched case-insensitively) → translated labels for the layer panel.
 *  Only recognizable standard names are translated; custom names pass through.
 *  `Inner<n>` / `Dielectric<n>` get a pattern rule in layerLabel(). */
const LAYER_NAMES: Record<string, string> = {
  'top layer': '顶层', 'bottom layer': '底层',
  'top silkscreen layer': '顶层丝印层', 'bottom silkscreen layer': '底层丝印层',
  'top overlay': '顶层丝印层', 'bottom overlay': '底层丝印层',
  'top solder mask layer': '顶层阻焊层', 'bottom solder mask layer': '底层阻焊层',
  'top paste mask layer': '顶层助焊层', 'bottom paste mask layer': '底层助焊层',
  'top assembly layer': '顶层装配层', 'bottom assembly layer': '底层装配层',
  'multi-layer': '多层', 'multi layer': '多层',
  'board outline layer': '板框层', 'keep-out layer': '禁止布线层',
  'document layer': '文档层', 'hole layer': '钻孔层',
  'mechanical layer': '机械层', 'drill drawing layer': '钻孔绘图层',
  'component shape layer': '元件形状层', 'component marking layer': '元件标记层',
  'component model layer': '元件模型层',
  'pin soldering layer': '引脚焊接层', 'pin floating layer': '引脚悬浮层',
  '3d shell outline layer': '3D 外壳轮廓层',
  '3d shell top layer': '3D 外壳顶层', '3d shell bottom layer': '3D 外壳底层',
  'top stiffener layer': '顶层补强层', 'bottom stiffener layer': '底层补强层',
  'ratline layer': '飞线层', ratsnest: '飞线', 'net layer': '网络层',
};

/** translate a standard PCB layer name (zh); unknown / custom names and the
 *  English UI pass through unchanged */
export function layerLabel(name: string): string {
  if (current === 'en') return name;
  const std = LAYER_NAMES[name.trim().toLowerCase()];
  if (std) return std;
  let m = /^Inner(\d+)$/i.exec(name);
  if (m) return `内层${m[1]}`;
  m = /^Dielectric(\d+)$/i.exec(name);
  if (m) return `绝缘层${m[1]}`;
  return name;
}

/** enum-ish values worth translating in props: pad/hole shapes, via types,
 *  pour types, prohibition object kinds, dimension types, alignment … */
const VALUES: Record<Lang, Record<string, string>> = {
  zh: {
    // pad / hole shapes
    ROUND: '圆形', RECT: '矩形', RECTANGLE: '矩形', OVAL: '椭圆', SLOT: '长圆', ELLIPSE: '椭圆',
    CIRCLE: '圆形', SQUARE: '方形', DIAMOND: '菱形', OCTAGON: '八边形', POLYGON: '多边形',
    // via types
    NORMAL: '通孔', THROUGH: '通孔', BLIND: '盲孔', BURIED: '埋孔', TOP: '顶层', BOTTOM: '底层',
    // pour types
    SOLID: '实心', GRID: '网格', HATCHED: '影线', NO: '无填充', CUTOUT: '挖空', PROHIBIT: '禁止区域',
    // connect modes
    FULL: '全连接', RELIEF: '辐条', DIRECT: '直连', ANTI: '反焊盘',
    // prohibition object kinds
    TRACK: '导线', COMPONENT: '元件', PAD: '焊盘', VIA: '过孔', HOLE: '钻孔', POUR: '覆铜',
    SILK: '丝印', TESTPOINT: '测试点', DIMENSION: '尺寸标注', TEXT: '文本', COPPER: '铜皮',
    BOARD_OUTLINE: '板框', PLANE: '平面',
    // dimension types
    LINEAR: '线性', LENGTH: '线性', ANGLE: '角度', RADIUS: '半径', DIAMETER: '直径', LEADER: '引线',
    // alignment / misc
    LEFT_TOP: '左上', LEFT_BOTTOM: '左下', CENTER: '居中', LEFT: '左', RIGHT: '右',
    DASH: '虚线', SHORT_DASH: '短划线', DASH_DOT: '点划线', DASH_DOT_DOT: '点点划线',
    TRUE: '是', FALSE: '否', NONE: '无',
  },
  en: {},
};
export function valueLabel(v: unknown): string {
  if (typeof v === 'string') {
    const m = VALUES[current][v] ?? (current === 'en' ? undefined : VALUES.zh[v]);
    if (m) return m;
  }
  return String(v);
}

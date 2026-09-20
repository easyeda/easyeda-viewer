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
    tipTheme: '切换明暗主题', tipPanelL: '显示/隐藏左侧面板', tipPanelR: '显示/隐藏右侧面板',
    tipLang: 'English',
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
    grpCount: '{type} · {n}',
    unitTitle: '单位:坐标为 mil(1 mil = 0.0254 mm)',
  },
  en: {
    appTitle: 'EasyEDA Viewer',
    tipFiles: 'Open project file', tipFolder: 'Open project folder',
    tipZoomIn: 'Zoom in', tipZoomOut: 'Zoom out', tipFit: 'Zoom to fit',
    tipTheme: 'Toggle light/dark theme', tipPanelL: 'Show/hide left panel', tipPanelR: 'Show/hide right panel',
    tipLang: '中文',
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

/** raw record data key → user-friendly label (properties panel) */
const ATTRS: Record<Lang, Record<string, string>> = {
  zh: {
    x: 'X', y: 'Y', x1: '起点 X', y1: '起点 Y', x2: '终点 X', y2: '终点 Y',
    centerX: '中心 X', centerY: '中心 Y', startX: '起点 X', startY: '起点 Y',
    endX: '终点 X', endY: '终点 Y', rotation: '旋转', angle: '角度', padAngle: '焊盘角度',
    layerId: '图层', layer: '图层', net: '网络', netName: '网络',
    text: '文本', value: '值', name: '名称', designator: '位号', num: '引脚号',
    fontSize: '字号', fontFamily: '字体', strokeWidth: '线宽', width: '宽度', height: '高度',
    radius: '圆角半径', radiusX: '半径 X', radiusY: '半径 Y',
    shape: '形状', padType: '焊盘形状', hole: '钻孔', holeType: '孔型', holeDiameter: '钻孔直径',
    viaDiameter: '过孔直径', diameter: '直径', points: '顶点', closed: '闭合',
    color: '颜色', fillColor: '填充色', strokeColor: '线色', specialColor: '特殊颜色',
    bold: '加粗', origin: '对齐', reverse: '翻转', mirror: '镜像',
    lock: '锁定', ratelock: '锁定网络', zIndex: '层级', id: 'ID', ticket: '记录号',
    symbol: '符号', footprint: '封装', device: '器件',
    Symbol: '符号', Footprint: '封装', Device: '器件', '3D Model': '3D 模型',
    uuid: 'UUID', Designator: '位号', Name: '名称', Value: '值',
    displayFill: '填充显示', displayStroke: '描边显示', pourFill: '覆铜填充',
    regionType: '区域类型', valueVisible: '值可见', defaultPad: '默认焊盘',
    matrix: '变换矩阵', path: '路径', ploys: '轮廓', coords: '坐标',
  },
  en: {
    x: 'X', y: 'Y', x1: 'From X', y1: 'From Y', x2: 'To X', y2: 'To Y',
    centerX: 'Center X', centerY: 'Center Y', startX: 'Start X', startY: 'Start Y',
    endX: 'End X', endY: 'End Y', rotation: 'Rotation', angle: 'Angle', padAngle: 'Pad angle',
    layerId: 'Layer', layer: 'Layer', net: 'Net', netName: 'Net',
    text: 'Text', value: 'Value', name: 'Name', designator: 'Designator', num: 'Pin',
    fontSize: 'Font size', fontFamily: 'Font', strokeWidth: 'Stroke width', width: 'Width', height: 'Height',
    radius: 'Radius', radiusX: 'Radius X', radiusY: 'Radius Y',
    shape: 'Shape', padType: 'Pad shape', hole: 'Drill', holeType: 'Drill type', holeDiameter: 'Drill diameter',
    viaDiameter: 'Via diameter', diameter: 'Diameter', points: 'Vertices', closed: 'Closed',
    color: 'Color', fillColor: 'Fill', strokeColor: 'Stroke', specialColor: 'Special color',
    bold: 'Bold', origin: 'Alignment', reverse: 'Reverse', mirror: 'Mirror',
    lock: 'Locked', ratelock: 'Ratlock', zIndex: 'Stacking', id: 'ID', ticket: 'Record',
    symbol: 'Symbol', footprint: 'Footprint', device: 'Device',
    Symbol: 'Symbol', Footprint: 'Footprint', Device: 'Device', '3D Model': '3D model',
    uuid: 'UUID', Designator: 'Designator', Name: 'Name', Value: 'Value',
    displayFill: 'Show fill', displayStroke: 'Show stroke', pourFill: 'Pour fill',
    regionType: 'Region type', valueVisible: 'Value visible', defaultPad: 'Default pad',
    matrix: 'Matrix', path: 'Path', ploys: 'Outline', coords: 'Coords',
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

/** enum-ish values worth translating in props */
const VALUES: Record<Lang, Record<string, string>> = {
  zh: {
    ROUND: '圆形', RECT: '矩形', RECTANGLE: '矩形', OVAL: '椭圆', SLOT: '长圆', ELLIPSE: '椭圆',
    CIRCLE: '圆形', SQUARE: '方形', DIAMOND: '菱形', OCTAGON: '八边形', NONE: '无',
    LEFT_TOP: '左上', LEFT_BOTTOM: '左下', CENTER: '居中', TRUE: '是', FALSE: '否',
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

import { icon } from './icons';
import { clearSegCache } from '../core/parse/records';
import './annotations.css';

/** Annotation state and UI belong to one viewer instance. */
export function installAnnotations(shell) {
  const lifetime = new AbortController();
  const loadEvents = new EventTarget();
  const camera = shell.camera;
  // SVG overlays must use the view already painted by the canvas renderer.
  let paintedView = { scale: camera.scale, tx: camera.tx, ty: camera.ty };
  const clone = value => JSON.parse(JSON.stringify(value));
  const now = () => new Date().toISOString();
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `ann-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ns = 'http://www.w3.org/2000/svg';
  const state = {
    projectId: '', revision: '', documents: [], annotations: [],
    user: { id: 'local', name: '本地用户' }, group: 'schematic', filter: 'all',
    selected: null, tool: 'select', editor: null, gesture: null, undo: [], redo: [],
    listeners: new Set(), loading: false, sequence: 0, visible: true
  };
  let requestedContext = null;
  let busy = false;
  let opening = false;
  let notifying = false;

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function button(text, action, parent) {
    const el = element('button', 'ev-btn', text);
    el.type = 'button';
    el.addEventListener('click', () => safely(action));
    parent?.append(el);
    return el;
  }
  function safely(fn) {
    try {
      const result = fn();
      if (result?.catch) result.catch(error => feedback(error.message, true));
      return result;
    } catch (error) { feedback(error.message, true); }
  }
  function requireReady() {
    if (notifying) throw new Error('请勿在批注变更回调中再次修改数据');
    if (busy || opening || state.loading || !state.projectId) throw new Error('请等待工程加载完成后操作批注');
  }
  function requireNoDraft() {
    if (state.editor || state.gesture?.mode === 'create' || state.gesture?.mode === 'edit-move') {
      throw new Error('请先保存或取消正在编辑的批注');
    }
  }
  function checkCapacity() {
    if (state.annotations.length > 10000) throw new Error('批注数量超过 10000 条');
    let length = 0;
    for (const item of state.annotations) {
      length += item.text.length;
      for (const reply of item.replies) length += reply.text.length;
    }
    if (length > 10 * 1024 * 1024) throw new Error('批注文字总量超过 10 MB');
  }
  function text(value, label, max = 10000, empty = false) {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
      throw new Error(`${label}无效（最多 ${max} 字符）`);
    }
    return value;
  }
  function author(value) {
    if (!value || typeof value !== 'object') throw new Error('创建者无效');
    return { id: text(value.id, '用户 ID', 200), name: text(value.name, '用户名', 200) };
  }
  function timestamp(value) {
    if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error('时间无效');
    return new Date(value).toISOString();
  }
  function geometry(value, type) {
    if (!value || typeof value !== 'object') throw new Error('批注坐标无效');
    const result = {};
    for (const key of type === 'text' ? ['x', 'y'] : ['x', 'y', 'width', 'height']) {
      if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Math.abs(value[key]) > 1e9) throw new Error('批注坐标无效');
      result[key] = value[key];
    }
    if (type !== 'text' && (result.width <= 0 || result.height <= 0)) throw new Error('框选尺寸必须大于零');
    if (type === 'circle' && Math.abs(result.width - result.height) > 1e-6) throw new Error('圆形的宽高必须相等');
    return result;
  }
  function currentDocument() {
    if (state.loading) return null;
    return state.documents.find(doc => doc.nodeId === shell.curNode?.id) || null;
  }
  function getAnnotation(id) {
    const item = state.annotations.find(a => a.id === id);
    if (!item) throw new Error('批注不存在');
    return item;
  }
  function snapshot() {
    return clone({ schemaVersion: 1, projectId: state.projectId, revision: state.revision,
      documents: state.documents, annotations: state.annotations });
  }
  function notify(reason) {
    const detail = { reason, sequence: ++state.sequence, data: snapshot() };
    notifying = true;
    try {
      window.dispatchEvent(new CustomEvent('easyeda-annotations-change', { detail: clone(detail) }));
      for (const listener of [...state.listeners]) {
        try {
          const result = listener(clone(detail));
          if (result?.catch) result.catch(error => console.error('Annotation change listener failed', error));
        } catch (error) { console.error('Annotation change listener failed', error); }
      }
    } finally { notifying = false; }
  }
  function commit(reason, mutate) {
    requireReady();
    const before = clone(state.annotations);
    const selection = state.selected, group = state.group, filterValue = state.filter;
    try { mutate(); checkCapacity(); }
    catch (error) {
      state.annotations = before;
      state.selected = selection; state.group = group; state.filter = filterValue;
      throw error;
    }
    state.undo.push(before);
    if (state.undo.length > 50) state.undo.shift();
    state.redo = [];
    render();
    notify(reason);
  }
  function history(direction) {
    requireReady();
    const from = state[direction];
    if (!from.length) return false;
    requireNoDraft();
    cancelEditor();
    cancelGesture();
    state[direction === 'undo' ? 'redo' : 'undo'].push(clone(state.annotations));
    state.annotations = from.pop();
    if (!state.annotations.some(a => a.id === state.selected)) state.selected = null;
    render();
    notify(direction);
    return true;
  }
  function createAnnotation(input) {
    requireReady();
    if (!input || !['text', 'rectangle', 'circle'].includes(input.type)) throw new Error('不支持的批注类型');
    const doc = state.documents.find(d => d.id === (input.documentId || currentDocument()?.id));
    if (!doc) throw new Error('请选择原理图或 PCB');
    const time = now();
    const item = { id: uid(), documentId: doc.id, group: doc.group, type: input.type,
      geometry: geometry(input.geometry, input.type), text: text(input.text, '批注内容'),
      creator: clone(state.user), createdAt: time, updatedAt: time, status: 'pending', replies: [] };
    commit('create', () => { state.annotations.push(item); state.selected = item.id; state.group = doc.group; state.filter = 'all'; });
    return clone(item);
  }
  function updateAnnotation(id, patch) {
    requireReady();
    if (state.editor?.mode === 'edit' && state.editor.id === id) requireNoDraft();
    const item = getAnnotation(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('更新数据无效');
    if (Object.keys(patch).some(k => !['text', 'geometry', 'status'].includes(k))) throw new Error('仅支持修改文字和状态');
    const next = {};
    if ('text' in patch) next.text = text(patch.text, '批注内容');
    if ('geometry' in patch) throw new Error('批注创建后坐标不可修改');
    if ('status' in patch) {
      if (!['pending', 'resolved'].includes(patch.status)) throw new Error('状态无效');
      next.status = patch.status;
    }
    commit('update', () => Object.assign(item, next, { updatedAt: now() }));
    return clone(item);
  }
  function deleteAnnotation(id) {
    requireReady();
    if (state.editor?.id === id) requireNoDraft();
    getAnnotation(id);
    if (state.editor?.id === id) cancelEditor();
    cancelGesture();
    commit('delete', () => {
      state.annotations = state.annotations.filter(a => a.id !== id);
      if (state.selected === id) state.selected = null;
    });
  }
  function addReply(id, content) {
    requireReady();
    const item = getAnnotation(id);
    const reply = { id: uid(), text: text(content, '回复内容'), creator: clone(state.user), createdAt: now() };
    if (item.replies.length >= 1000) throw new Error('单条批注最多支持 1000 条回复');
    commit('reply', () => { item.replies.push(reply); item.updatedAt = reply.createdAt; });
    return clone(reply);
  }

  // Validate a complete replacement before touching the live state (including on import failures).
  function validateImport(input) {
    if (typeof input === 'string') {
      if (input.length > 20 * 1024 * 1024) throw new Error('批注数据超过 20 MB');
      input = JSON.parse(input);
    }
    if (!input || input.schemaVersion !== 1) throw new Error('不支持的批注数据版本');
    if (input.projectId !== state.projectId || input.revision !== state.revision) throw new Error('工程 ID 或版本不匹配，未覆盖现有批注');
    if (!Array.isArray(input.annotations) || input.annotations.length > 10000) throw new Error('批注列表无效或超过 10000 条');
    const ids = new Set();
    function uniqueId(value) {
      value = text(value, '记录 ID', 200);
      if (ids.has(value)) throw new Error('批注或回复 ID 重复');
      ids.add(value);
      return value;
    }
    let totalText = 0;
    function content(value) {
      const result = text(value, '内容');
      totalText += result.length;
      if (totalText > 10 * 1024 * 1024) throw new Error('批注文字总量超过 10 MB');
      return result;
    }
    return input.annotations.map(item => {
      if (!item || !['text', 'rectangle', 'circle'].includes(item.type)) throw new Error('批注类型无效');
      const doc = state.documents.find(d => d.id === item.documentId);
      if (!doc || item.group !== doc.group) throw new Error('批注所属图纸不存在或分组不匹配');
      if (!['pending', 'resolved'].includes(item.status)) throw new Error('批注状态无效');
      if (!Array.isArray(item.replies) || item.replies.length > 1000) throw new Error('回复列表无效');
      return { id: uniqueId(item.id), documentId: doc.id, group: doc.group, type: item.type,
        geometry: geometry(item.geometry, item.type), text: content(item.text), creator: author(item.creator),
        createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt), status: item.status,
        replies: item.replies.map(reply => {
          if (!reply) throw new Error('回复无效');
          return { id: uniqueId(reply.id), text: content(reply.text), creator: author(reply.creator), createdAt: timestamp(reply.createdAt) };
        }) };
    });
  }
  function importAnnotations(input) {
    requireReady();
    const items = validateImport(input);
    requireNoDraft();
    cancelEditor();
    cancelGesture();
    setTool('select');
    commit('import', () => { state.annotations = items; state.selected = null; });
    feedback(`已覆盖导入 ${items.length} 条批注`);
    return items.length;
  }

  const toolbar = element('div', 'ann-toolbar');
  shell.toolbarEl.insertBefore(toolbar, shell.titleEl);
  const toolButtons = {};
  const addMenu = element('div', 'ann-add-menu');
  function closeMenu() {
    addPopup.classList.remove('ann-open');
    addButton.classList.remove('ev-on');
    addButton.setAttribute('aria-expanded', 'false');
  }
  const addButton = button('添加批注', () => {
    const open = !addPopup.classList.contains('ann-open');
    addPopup.classList.toggle('ann-open', open);
    addButton.classList.toggle('ev-on', open);
    addButton.setAttribute('aria-expanded', String(open));
  }, addMenu);
  addButton.setAttribute('aria-haspopup', 'menu');
  addButton.setAttribute('aria-expanded', 'false');
  const addPopup = element('div', 'ann-add-menu-popup');
  addPopup.setAttribute('role', 'menu');
  const menuIcons = { text: 'annType', rectangle: 'annRectangle', circle: 'annCircle' };
  for (const [type, label] of [['text', '文字'], ['rectangle', '矩形框'], ['circle', '圆形框']]) {
    toolButtons[type] = button(label, () => { closeMenu(); showPanel(); setTool(type); }, addPopup);
    toolButtons[type].insertAdjacentHTML('afterbegin', icon(menuIcons[type], 16));
    toolButtons[type].querySelector('svg').setAttribute('aria-hidden', 'true');
    toolButtons[type].dataset.annTool = type;
    toolButtons[type].setAttribute('role', 'menuitem');
  }
  addMenu.append(addPopup);
  toolbar.append(addMenu);
  document.addEventListener('pointerdown', event => { if (!addMenu.contains(event.target)) closeMenu(); }, { signal: lifetime.signal });
  addMenu.addEventListener('keydown', event => {
    const buttons = Object.values(toolButtons);
    if (event.key === 'Escape') { closeMenu(); addButton.focus(); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      addPopup.classList.add('ann-open');
      addButton.setAttribute('aria-expanded', 'true');
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1) + buttons.length) % buttons.length].focus();
    }
  });
  const visibilityButton = button('批注显示', () => setAnnotationsVisible(!state.visible), toolbar);
  visibilityButton.className = 'ev-btn ann-visibility ev-on';
  visibilityButton.title = '显示或隐藏全部批注';
  visibilityButton.setAttribute('aria-pressed', 'true');
  const undoButton = button('撤销', () => history('undo'), toolbar);
  const redoButton = button('重做', () => history('redo'), toolbar);
  undoButton.title = '撤销批注操作 Ctrl+Z';
  redoButton.title = '重做批注操作 Ctrl+Shift+Z';

  const tabs = element('div', 'ann-tabs');
  const notesTab = button('批注记录', () => showPanel(), tabs);
  const propsTab = button('属性 / 图层', () => {
    shell.rightEl.classList.remove('ann-open');
    setTool('select');
    notesTab.classList.remove('ev-on');
    propsTab.classList.add('ev-on');
  }, tabs);
  tabs.prepend(propsTab);
  shell.rightEl.prepend(tabs);
  const panel = element('section', 'ann-panel');
  panel.setAttribute('aria-label', '批注及对话记录');
  shell.rightEl.append(panel);
  const head = element('div', 'ann-head');
  const groupTabs = element('div', 'ann-group-tabs');
  head.append(groupTabs);
  const groupButtons = {};
  for (const [group, title] of [['schematic', '原理图'], ['pcb', 'PCB']]) {
    groupButtons[group] = button(title, () => { state.group = group; renderList(); }, groupTabs);
  }
  const contextLabel = element('div', 'ann-meta');
  const filter = element('select');
  filter.setAttribute('aria-label', '筛选批注状态');
  for (const [value, title] of [['all', '全部状态'], ['pending', '待处理'], ['resolved', '已解决']]) {
    const option = element('option', '', title); option.value = value; filter.append(option);
  }
  filter.addEventListener('change', () => { state.filter = filter.value; renderList(); });
  const authorLabel = element('label', 'ann-author', '当前用户');
  const authorInput = element('input');
  authorInput.value = state.user.name;
  authorInput.maxLength = 200;
  authorInput.setAttribute('aria-label', '当前用户');
  authorInput.addEventListener('change', () => {
    safely(() => { state.user = author({ ...state.user, name: authorInput.value }); });
    authorInput.value = state.user.name;
  });
  authorLabel.append(authorInput);
  head.append(contextLabel, filter, authorLabel);
  const list = element('div', 'ann-list');
  const editor = element('form', 'ann-editor');
  editor.hidden = true;
  const editorTitle = element('div', 'ann-editor-title');
  const editorText = element('textarea');
  editorText.maxLength = 10000;
  editorText.placeholder = '输入批注内容…';
  editorText.setAttribute('aria-label', '批注内容');
  const editorActions = element('div', 'ann-actions');
  const saveButton = button('保存', () => saveEditor(), editorActions);
  saveButton.classList.add('ev-btn-primary');
  button('取消', () => { cancelEditor(); draw(); }, editorActions);
  editor.append(editorTitle, editorText, editorActions);
  editor.addEventListener('submit', event => { event.preventDefault(); safely(saveEditor); });
  panel.append(head, list, editor);
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('ann-layer');
  svg.setAttribute('aria-label', '图纸批注层');
  shell.canvasHost.append(svg);

  function feedback(message, error = false) {
    if (error) shell.setStatus(message, true);
  }
  function showPanel() {
    shell.rightEl.classList.add('ann-open');
    notesTab.classList.add('ev-on');
    propsTab.classList.remove('ev-on');
    shell.rightForced = true;
    shell.applyChrome();
  }
  function setTool(type) {
    if (type !== 'select') requireNoDraft();
    if (type !== 'select' && !currentDocument()) throw new Error('请先打开原理图或 PCB');
    if (type !== 'select' && !state.visible) throw new Error('请先显示批注');
    cancelGesture();
    state.tool = type;
    if (type !== 'select' && shell.measure.active) shell.measure.setActive(false);
    svg.classList.toggle('ann-drawing', type !== 'select');
    for (const [key, btn] of Object.entries(toolButtons)) btn.classList.toggle('ev-on', key === type);
    feedback(type === 'select' ? '点击批注查看对话。已保存批注的位置和大小不可修改。' : type === 'text' ? '在图纸上点击放置文字，按 Esc 取消。' : '在图纸上拖动绘制框选，按 Esc 取消。');
  }
  function setAnnotationsVisible(value) {
    if (typeof value !== 'boolean') throw new TypeError('显示状态必须是布尔值');
    if (!value) requireNoDraft();
    state.visible = value;
    visibilityButton.classList.toggle('ev-on', state.visible);
    visibilityButton.classList.toggle('ev-off', !state.visible);
    visibilityButton.textContent = state.visible ? '批注显示' : '批注隐藏';
    visibilityButton.setAttribute('aria-pressed', String(state.visible));
    closeMenu();
    if (!state.visible) { cancelGesture(); cancelEditor(); setTool('select'); }
    render();
    feedback(state.visible ? '批注已显示。' : '批注已隐藏，数据仍保留。');
    return state.visible;
  }
  function beginEditor(value, title, initial = '') {
    requireNoDraft();
    setTool('select');
    if (value.mode === 'edit') {
      value.geometry = clone(getAnnotation(value.id).geometry);
      state.selected = value.id;
    }
    state.editor = value;
    showPanel();
    editorTitle.textContent = title;
    editorText.value = initial;
    editor.hidden = false;
    editorText.focus();
    draw();
  }
  function cancelEditor() {
    cancelGesture();
    state.editor = null;
    editor.hidden = true;
    editorText.value = '';
  }
  function saveEditor() {
    if (!state.editor) return;
    if (state.gesture) throw new Error('请先完成当前拖动');
    const content = text(editorText.value.trim(), '内容');
    const editing = state.editor;
    if (editing.mode === 'create') createAnnotation({ ...editing.draft, text: content });
    else if (editing.mode === 'reply') addReply(editing.id, content);
    else {
      const item = getAnnotation(editing.id);
      const nextGeometry = geometry(editing.geometry, item.type);
      commit('update', () => Object.assign(item, { text: content, geometry: nextGeometry, updatedAt: now() }));
    }
    cancelEditor();
    draw();
    feedback('批注数据已更新，请由 PLM 保存。');
  }
  async function focusAnnotation(id) {
    requireReady();
    requireNoDraft();
    const item = getAnnotation(id);
    const doc = state.documents.find(d => d.id === item.documentId);
    if (shell.curNode?.id !== doc.nodeId) await shell.openNode(shell.model.openables.get(doc.nodeId));
    state.selected = id;
    state.group = doc.group;
    state.filter = 'all';
    showPanel();
    camera.centerOn(item.geometry.x + (item.geometry.width || 0) / 2, item.geometry.y + (item.geometry.height || 0) / 2);
    render();
    const card = Array.from(list.children).find(el => el.dataset.annCard === id);
    if (card) {
      const listRect = list.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      if (cardRect.top < listRect.top) list.scrollTop -= listRect.top - cardRect.top;
      else if (cardRect.bottom > listRect.bottom) list.scrollTop += cardRect.bottom - listRect.bottom;
    }
  }
  function dateLabel(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
  function renderList() {
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    const doc = currentDocument();
    contextLabel.textContent = doc ? `当前图纸：${doc.title}` : '当前没有可批注的图纸';
    filter.value = state.filter;
    for (const [key, btn] of Object.entries(groupButtons)) {
      const count = state.annotations.filter(a => a.group === key).length;
      btn.textContent = `${key === 'pcb' ? 'PCB' : '原理图'} (${count})`;
      btn.classList.toggle('ev-on', state.group === key);
    }
    const items = state.annotations.filter(a => a.group === state.group && (state.filter === 'all' || a.status === state.filter));
    if (!items.length) list.append(element('div', 'ann-empty', '暂无批注记录'));
    for (const item of items) {
      const card = element('article', 'ann-card');
      card.dataset.annCard = item.id;
      card.addEventListener('click', event => {
        if (event.target.closest('button, input, textarea, select, a')) return;
        if (window.getSelection()?.toString()) return;
        safely(() => focusAnnotation(item.id));
      });
      card.classList.toggle('ann-selected', item.id === state.selected);
      card.classList.toggle('ann-resolved', item.status === 'resolved');
      const heading = element('div', 'ann-card-head');
      const docTitle = state.documents.find(d => d.id === item.documentId)?.title || '';
      button({ text: '文字', rectangle: '矩形', circle: '圆形' }[item.type], () => focusAnnotation(item.id), heading);
      heading.append(element('span', 'ann-state', item.status === 'resolved' ? '已解决' : '待处理'));
      card.append(heading, element('div', 'ann-meta', `${docTitle}\n${item.creator.name} · ${dateLabel(item.createdAt)}`), element('div', 'ann-content', item.text));
      if (item.replies.length) {
        const replies = element('div', 'ann-replies');
        for (const reply of item.replies) {
          const row = element('div', 'ann-reply');
          row.append(element('div', 'ann-meta', `${reply.creator.name} · ${dateLabel(reply.createdAt)}`), element('div', 'ann-content', reply.text));
          replies.append(row);
        }
        card.append(replies);
      }
      const actions = element('div', 'ann-actions');
      button(`回复 (${item.replies.length})`, () => beginEditor({ mode: 'reply', id: item.id }, '回复批注'), actions);
      button('编辑', async () => {
        requireNoDraft();
        if (currentDocument()?.id !== item.documentId) await focusAnnotation(item.id);
        beginEditor({ mode: 'edit', id: item.id }, '编辑批注', item.text);
      }, actions);
      button(item.status === 'resolved' ? '重新打开' : '标记已解决', () => updateAnnotation(item.id, { status: item.status === 'resolved' ? 'pending' : 'resolved' }), actions);
      button('删除', () => { if (confirm('删除这条批注及其全部回复？（可撤销）')) deleteAnnotation(item.id); }, actions);
      card.append(actions);
      list.append(card);
    }
    list.scrollTop = scrollTop;
  }
  function render() {
    const available = Boolean(currentDocument()) && !state.loading && state.visible;
    addButton.disabled = !available;
    for (const [key, btn] of Object.entries(toolButtons)) btn.disabled = key !== 'select' && !available;
    undoButton.disabled = !state.undo.length || state.loading;
    redoButton.disabled = !state.redo.length || state.loading;
    renderList();
    draw();
  }

  function svgNode(tag, attrs, parent = svg) {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    parent.append(node);
    return node;
  }
  function draw() {
    svg.replaceChildren();
    if (!state.visible) return;
    const doc = currentDocument();
    if (!doc) return;
    const items = state.annotations.filter(a => a.documentId === doc.id);
    if (state.editor?.mode === 'edit') {
      const index = items.findIndex(item => item.id === state.editor.id);
      if (index >= 0) items.push(...items.splice(index, 1));
    }
    if (state.editor?.mode === 'create') items.push({ ...state.editor.draft, id: '', text: '待保存', status: 'pending' });
    if (state.gesture?.mode === 'create' && state.gesture.draft) items.push({ ...state.gesture.draft, id: '', text: '', status: 'pending' });
    for (const item of items) {
      const editing = state.editor?.mode === 'edit' && state.editor.id === item.id;
      const g = editing ? (state.gesture?.mode === 'edit-move' ? state.gesture.preview : state.editor.geometry) : item.geometry;
      if (!g) continue;
      const x = g.x * paintedView.scale + paintedView.tx, y = g.y * paintedView.scale + paintedView.ty;
      const w = (g.width || 0) * paintedView.scale, h = (g.height || 0) * paintedView.scale;
      const selected = item.id && item.id === state.selected;
      const color = selected ? '#2563eb' : item.status === 'resolved' ? '#16a34a' : '#d97706';
      const group = svgNode('g', item.id ? { 'data-ann-id': item.id } : { 'pointer-events': 'none' });
      if (editing) group.classList.add('ann-editable');
      const title = svgNode('title', {}, group); title.textContent = item.text;
      const stroke = { stroke: color, 'stroke-width': selected ? 3 : 2, fill: color, 'fill-opacity': 0.08 };
      if (item.type === 'rectangle') svgNode('rect', { x, y, width: w, height: h, ...stroke }, group);
      if (item.type === 'circle') svgNode('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, ...stroke }, group);
      const characters = Array.from(item.text.replace(/\s+/g, ' '));
      const label = characters.slice(0, 24).join('') + (characters.length > 24 ? '…' : '') || '批注';
      const labelY = item.type === 'text' ? y : y - 25 * paintedView.scale;
      const labelGroup = svgNode('g', {
        'data-ann-label': 'true',
        transform: `translate(${x} ${labelY}) scale(${paintedView.scale})`
      }, group);
      const labelWidth = Math.min(360, Math.max(64, Array.from(label).reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 13 : 7), 18)));
      const labelBox = svgNode('rect', { x: 0, y: 0, width: labelWidth, height: 24, rx: 4, fill: color, opacity: 0.96 }, labelGroup);
      const labelText = svgNode('text', { x: 7, y: 16, fill: '#ffffff', 'font-size': 12 }, labelGroup);
      labelText.textContent = label;
      // Measure at unit scale so font rounding cannot change the label's document size.
      labelGroup.setAttribute('transform', `translate(${x} ${labelY})`);
      const textWidth = labelText.getComputedTextLength();
      if (textWidth > 0) {
        labelText.setAttribute('textLength', textWidth);
        labelText.setAttribute('lengthAdjust', 'spacingAndGlyphs');
      }
      labelBox.setAttribute('width', Math.max(64, textWidth + 14));
      labelGroup.setAttribute('transform', `translate(${x} ${labelY}) scale(${paintedView.scale})`);
    }
  }
  function point(event) {
    const bounds = shell.canvasHost.getBoundingClientRect();
    return { x: (event.clientX - bounds.left - paintedView.tx) / paintedView.scale,
      y: (event.clientY - bounds.top - paintedView.ty) / paintedView.scale };
  }
  function shape(start, end, type) {
    const dx = end.x - start.x, dy = end.y - start.y;
    const w = type === 'circle' ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.abs(dx);
    const h = type === 'circle' ? w : Math.abs(dy);
    return { x: dx < 0 ? start.x - w : start.x, y: dy < 0 ? start.y - h : start.y, width: w, height: h };
  }
  function cancelGesture() {
    const gesture = state.gesture;
    state.gesture = null;
    if (gesture && svg.hasPointerCapture(gesture.pointerId)) svg.releasePointerCapture(gesture.pointerId);
    draw();
  }
  // Capture before the viewer's pan / object-selection handlers, but leave wheel zoom untouched.
  let blankPress = null;
  shell.canvasHost.addEventListener('pointerdown', event => {
    blankPress = null;
    if (event.button !== 0 || !state.visible || busy || opening || state.loading || shell.measure.active || !currentDocument()) return;
    const target = event.target.closest?.('[data-ann-id]');
    if (state.tool === 'select' && !target) {
      if (!state.editor) blankPress = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    if (state.editor?.mode === 'edit' && target?.getAttribute('data-ann-id') === state.editor.id) {
      state.gesture = { mode: 'edit-move', pointerId: event.pointerId, start: point(event),
        original: clone(state.editor.geometry), preview: clone(state.editor.geometry) };
      svg.setPointerCapture(event.pointerId);
      return;
    }
    if (state.editor) { feedback('请先保存或取消正在编辑的内容。', true); return; }
    const p = point(event);
    if (state.tool !== 'select') {
      state.gesture = { mode: 'create', type: state.tool, pointerId: event.pointerId, start: p, end: p };
    } else {
      const item = getAnnotation(target.getAttribute('data-ann-id'));
      state.selected = item.id;
      state.group = item.group;
      showPanel();
      state.gesture = { mode: 'select', pointerId: event.pointerId };
      renderList();
    }
    svg.setPointerCapture(event.pointerId);
    draw();
  }, true);
  shell.canvasHost.addEventListener('pointermove', event => {
    const gesture = state.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (gesture.mode === 'select') return;
    const p = point(event);
    gesture.end = p;
    if (gesture.mode === 'edit-move') {
      gesture.preview = { ...gesture.original, x: gesture.original.x + p.x - gesture.start.x,
        y: gesture.original.y + p.y - gesture.start.y };
    }
    if (gesture.mode === 'create') {
      gesture.draft = { documentId: currentDocument().id, type: gesture.type,
        geometry: gesture.type === 'text' ? gesture.start : shape(gesture.start, p, gesture.type) };
    }
    draw();
  }, true);
  shell.canvasHost.addEventListener('pointerup', event => {
    const blank = blankPress;
    blankPress = null;
    if (blank && blank.pointerId === event.pointerId && !state.editor && state.tool === 'select' &&
        !camera.didPan && Math.hypot(event.clientX - blank.x, event.clientY - blank.y) <= 3 &&
        !event.target.closest?.('[data-ann-id]')) {
      state.selected = null;
      renderList();
      draw();
    }
    const gesture = state.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    state.gesture = null;
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    safely(() => {
      if (gesture.mode === 'edit-move' && state.editor?.mode === 'edit') {
        state.editor.geometry = gesture.preview;
      }
      if (gesture.mode === 'create') {
        const g = gesture.type === 'text' ? gesture.start : shape(gesture.start, point(event), gesture.type);
        if (gesture.type !== 'text' && (g.width * camera.scale < 6 || g.height * camera.scale < 6)) { draw(); return; }
        setTool('select');
        beginEditor({ mode: 'create', draft: { type: gesture.type, geometry: g, documentId: currentDocument().id } }, '新增批注');
      } else draw();
    });
  }, true);
  shell.canvasHost.addEventListener('pointercancel', () => { blankPress = null; cancelGesture(); }, true);
  svg.addEventListener('lostpointercapture', () => { if (state.gesture) cancelGesture(); });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeMenu(); cancelGesture(); cancelEditor(); setTool('select'); draw(); return; }
    if (event.target.closest?.('input,textarea,select,[contenteditable=true]')) return;
    if (shell.rightEl.classList.contains('ann-open') && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); safely(() => history(event.shiftKey ? 'redo' : 'undo'));
    }
  }, { signal: lifetime.signal });
  shell.measureBtn.addEventListener('click', () => {
    if (shell.measure.active) { cancelEditor(); setTool('select'); }
    svg.classList.toggle('ann-measuring', shell.measure.active);
  });
  const originalMeasureActive = shell.measure.setActive.bind(shell.measure);
  shell.measure.setActive = active => {
    if (active && state.editor) { feedback('请先保存或取消正在编辑的批注', true); return; }
    originalMeasureActive(active);
    svg.classList.toggle('ann-measuring', shell.measure.active);
  };
  const onRender = () => {
    if (paintedView.scale === camera.scale && paintedView.tx === camera.tx && paintedView.ty === camera.ty) return;
    paintedView = { scale: camera.scale, tx: camera.tx, ty: camera.ty };
    draw();
  };
  shell.leafer.on('render.end', onRender);
  const resizeObserver = new ResizeObserver(draw);
  resizeObserver.observe(shell.canvasHost);

  function buildDocuments(model) {
    return Array.from(model.openables.values()).flatMap(node => {
      const group = node.docType === 'PCB' ? 'pcb' : String(node.docType).startsWith('SCH') ? 'schematic' : null;
      return group ? [{ id: `${group}:${node.uuid}`, nodeId: node.id, group, title: node.title || node.uuid }] : [];
    });
  }
  function defaultProjectId(model, docs) {
    // PLM integrations should supply their own projectId + revision; this is the local-file fallback.
    const identity = `${model.name}|${docs.map(d => d.id).sort().join('|')}`;
    let hash = 2166136261;
    for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
    return `local:${(hash >>> 0).toString(16)}`;
  }
  const originalRightVisible = shell.rightVisible.bind(shell);
  shell.rightVisible = () => shell.rightForced === null && currentDocument() ? true : originalRightVisible();
  const originalOpenNode = shell.openNode.bind(shell);
  shell.openNode = async node => {
    if (opening) throw new Error('图纸正在打开，请稍后重试');
    requireNoDraft();
    opening = true;
    cancelGesture(); cancelEditor(); setTool('select');
    state.selected = null;
    try { await originalOpenNode(node); }
    finally { opening = false; }
    const doc = currentDocument();
    if (doc) state.group = doc.group;
    render();
    shell.applyChrome();
  };
  const originalOnTreeNode = shell.onTreeNode.bind(shell);
  shell.onTreeNode = node => {
    if (shell.model?.openables.has(node.id)) return safely(() => shell.openNode(node));
    if (state.editor) { feedback('请先保存或取消正在编辑的批注', true); return; }
    const result = originalOnTreeNode(node);
    if (!shell.model?.openables.has(node.id)) { cancelGesture(); cancelEditor(); setTool('select'); render(); }
    return result;
  };
  const originalSetModel = shell.setModel.bind(shell);
  shell.setModel = async model => {
    requireNoDraft();
    state.loading = true;
    cancelGesture(); cancelEditor(); setTool('select');
    state.annotations = []; state.undo = []; state.redo = []; state.selected = null;
    state.documents = buildDocuments(model);
    state.projectId = requestedContext?.projectId || defaultProjectId(model, state.documents);
    state.revision = requestedContext?.revision || '';
    try { await originalSetModel(model); }
    finally {
      state.loading = false;
      const doc = currentDocument();
      if (doc) state.group = doc.group;
      render(); shell.applyChrome();
    }
    window.dispatchEvent(new CustomEvent('easyeda-annotations-context', { detail: snapshot() }));
  };
  async function loadProject(files, options = {}) {
    if (notifying) throw new Error('请勿在批注变更回调中加载工程');
    if (busy || opening) throw new Error('已有工程或图纸正在加载');
    requireNoDraft();
    const context = {
      projectId: options.projectId === undefined ? '' : text(options.projectId, '工程 ID', 500),
      revision: options.revision === undefined ? '' : text(options.revision, '工程版本', 200, true)
    };
    if (options.user) author(options.user);
    const entries = Array.from(files || []);
    if (!entries.length) throw new Error('请提供工程文件');
    busy = true;
    requestedContext = context;
    const previous = shell.model;
    let loadError = null;
    const onLoadError = event => { loadError = event.detail?.message || '工程加载失败'; };
    loadEvents.addEventListener('error', onLoadError);
    try {
      await shell.loadFiles(entries);
      if (loadError || shell.model === previous) throw new Error(loadError || '工程加载失败，请检查文件格式');
      if (options.user) { state.user = author(options.user); authorInput.value = state.user.name; }
    } finally {
      loadEvents.removeEventListener('error', onLoadError);
      busy = false; requestedContext = null;
    }
    if (options.annotations !== undefined) importAnnotations(options.annotations);
    return snapshot();
  }
  const originalFail = shell.fail.bind(shell);
  shell.fail = error => {
    originalFail(error);
    const detail = { message: error instanceof Error ? error.message : String(error) };
    loadEvents.dispatchEvent(new CustomEvent('error', { detail }));
    window.dispatchEvent(new CustomEvent('easyeda-viewer-load-error', { detail }));
  };
  // The bundled parser caches documents by path, not by file contents.
  for (const method of ['loadFiles', 'loadMap']) {
    const original = shell[method].bind(shell);
    shell[method] = async (...args) => {
      if (opening) { shell.fail(new Error('图纸正在打开，请稍后重试')); return; }
      try { requireNoDraft(); }
      catch (error) { shell.fail(error); return; }
      clearSegCache();
      return original(...args);
    };
  }
  const api = Object.freeze({
    version: '1.1.0', loadProject,
    setAnnotationsVisible,
    getAnnotationsVisible: () => state.visible,
    getContext: () => clone({ projectId: state.projectId, revision: state.revision, documents: state.documents, currentDocument: currentDocument() }),
    setUser: value => { state.user = author(value); authorInput.value = state.user.name; return clone(state.user); },
    exportAnnotations: () => snapshot(), importAnnotations,
    createAnnotation, updateAnnotation, deleteAnnotation, addReply, focusAnnotation,
    undo: () => history('undo'), redo: () => history('redo'),
    onChange: callback => {
      if (typeof callback !== 'function') throw new TypeError('回调必须是函数');
      state.listeners.add(callback);
      return () => state.listeners.delete(callback);
    },
    open: async nodeId => {
      requireReady();
      const node = shell.model.openables.get(nodeId);
      if (!node) throw new Error('图纸不存在');
      await shell.openNode(node);
      return api.getContext();
    },
    fit: () => shell.fitCurrent(),
    setTheme: theme => shell.setTheme(theme),
    setChrome: flags => shell.setChrome(flags)
  });
  shell.rightEl.classList.add('ann-open');
  notesTab.classList.add('ev-on');
  setTool('select');
  render();
  return { api, destroy() {
    lifetime.abort();
    resizeObserver.disconnect();
    shell.leafer.off('render.end', onRender);
    state.listeners.clear();
    toolbar.remove(); tabs.remove(); panel.remove(); svg.remove();
  } };
}

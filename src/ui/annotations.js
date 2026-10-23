import { icon } from './icons';
import { t } from './i18n';
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
    user: { id: 'local', name: t('annLocalUser') }, group: 'schematic', filter: 'all',
    selected: null, tool: 'select', editor: null, gesture: null, undo: [], redo: [],
    listeners: new Set(), loading: false, sequence: 0, visible: true
  };
  const LOCAL_USER_NAMES = new Set(['本地用户', 'Local user']);
  let requestedContext = null;
  let busy = false;
  let opening = false;
  let notifying = false;
  // preview hosts can switch the whole annotation UI off (`chrome.annotations`
  // or `?annotations=0`); the data API keeps working
  let enabled = shell.getChrome().annotations !== false;

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
  // toolbar buttons are icon-only with a tooltip, matching the main toolbar;
  // the accessible name comes from aria-label so role queries stay stable
  function iconButton(name, label, action, parent) {
    const el = element('button', 'ev-btn ev-btn-icon');
    el.type = 'button';
    el.innerHTML = icon(name, 16);
    el.title = label;
    el.setAttribute('aria-label', label);
    el.addEventListener('click', () => safely(action));
    parent?.append(el);
    return el;
  }
  // replace the label while keeping any leading icon (<svg>) in place
  function setButtonText(btn, label) {
    for (const node of [...btn.childNodes]) if (node.nodeType === 3) node.remove();
    btn.append(document.createTextNode(label));
  }
  function safely(fn) {
    try {
      const result = fn();
      if (result?.catch) result.catch(error => feedback(error.message, true));
      return result;
    } catch (error) { feedback(error.message, true); }
  }
  function requireReady() {
    if (notifying) throw new Error(t('annNoMutateInCallback'));
    if (busy || opening || state.loading || !state.projectId) throw new Error(t('annWaitLoading'));
  }
  function requireNoDraft() {
    if (state.editor || state.gesture?.mode === 'create' || state.gesture?.mode === 'edit-move') {
      throw new Error(t('annNoDraft'));
    }
  }
  function checkCapacity() {
    if (state.annotations.length > 10000) throw new Error(t('annTooMany'));
    let length = 0;
    for (const item of state.annotations) {
      length += item.text.length;
      for (const reply of item.replies) length += reply.text.length;
    }
    if (length > 10 * 1024 * 1024) throw new Error(t('annTextTooLong'));
  }
  function text(value, label, max = 10000, empty = false) {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
      throw new Error(t('annInvalidField', { label, max }));
    }
    return value;
  }
  function author(value) {
    if (!value || typeof value !== 'object') throw new Error(t('annInvalidCreator'));
    return { id: text(value.id, t('annFieldUserId'), 200), name: text(value.name, t('annFieldUserName'), 200) };
  }
  function timestamp(value) {
    if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error(t('annInvalidTime'));
    return new Date(value).toISOString();
  }
  function geometry(value, type) {
    if (!value || typeof value !== 'object') throw new Error(t('annInvalidGeometry'));
    const result = {};
    for (const key of type === 'text' ? ['x', 'y'] : ['x', 'y', 'width', 'height']) {
      if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Math.abs(value[key]) > 1e9) throw new Error(t('annInvalidGeometry'));
      result[key] = value[key];
    }
    if (type !== 'text' && (result.width <= 0 || result.height <= 0)) throw new Error(t('annSizePositive'));
    if (type === 'circle' && Math.abs(result.width - result.height) > 1e-6) throw new Error(t('annCircleSquare'));
    return result;
  }
  function currentDocument() {
    if (state.loading) return null;
    return state.documents.find(doc => doc.nodeId === shell.curNode?.id) || null;
  }
  function getAnnotation(id) {
    const item = state.annotations.find(a => a.id === id);
    if (!item) throw new Error(t('annNotFound'));
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
    if (!input || !['text', 'rectangle', 'circle'].includes(input.type)) throw new Error(t('annUnsupportedType'));
    const doc = state.documents.find(d => d.id === (input.documentId || currentDocument()?.id));
    if (!doc) throw new Error(t('annSelectDoc'));
    const time = now();
    const item = { id: uid(), documentId: doc.id, group: doc.group, type: input.type,
      geometry: geometry(input.geometry, input.type), text: text(input.text, t('annFieldContent')),
      creator: clone(state.user), createdAt: time, updatedAt: time, status: 'pending', replies: [] };
    commit('create', () => { state.annotations.push(item); state.selected = item.id; state.group = doc.group; state.filter = 'all'; });
    return clone(item);
  }
  function updateAnnotation(id, patch) {
    requireReady();
    if (state.editor?.mode === 'edit' && state.editor.id === id) requireNoDraft();
    const item = getAnnotation(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(t('annInvalidPatch'));
    if (Object.keys(patch).some(k => !['text', 'geometry', 'status'].includes(k))) throw new Error(t('annOnlyTextStatus'));
    const next = {};
    if ('text' in patch) next.text = text(patch.text, t('annFieldContent'));
    if ('geometry' in patch) throw new Error(t('annNoGeometryEdit'));
    if ('status' in patch) {
      if (!['pending', 'resolved'].includes(patch.status)) throw new Error(t('annInvalidStatus'));
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
    const reply = { id: uid(), text: text(content, t('annFieldReplyContent')), creator: clone(state.user), createdAt: now() };
    if (item.replies.length >= 1000) throw new Error(t('annReplyLimit'));
    commit('reply', () => { item.replies.push(reply); item.updatedAt = reply.createdAt; });
    return clone(reply);
  }

  // Validate a complete replacement before touching the live state (including on import failures).
  function validateImport(input) {
    if (typeof input === 'string') {
      if (input.length > 20 * 1024 * 1024) throw new Error(t('annImportTooBig'));
      input = JSON.parse(input);
    }
    if (!input || input.schemaVersion !== 1) throw new Error(t('annUnsupportedSchema'));
    if (input.projectId !== state.projectId || input.revision !== state.revision) throw new Error(t('annProjectMismatch'));
    if (!Array.isArray(input.annotations) || input.annotations.length > 10000) throw new Error(t('annInvalidList'));
    const ids = new Set();
    function uniqueId(value) {
      value = text(value, t('annFieldRecordId'), 200);
      if (ids.has(value)) throw new Error(t('annDuplicateId'));
      ids.add(value);
      return value;
    }
    let totalText = 0;
    function content(value) {
      const result = text(value, t('annFieldContent'));
      totalText += result.length;
      if (totalText > 10 * 1024 * 1024) throw new Error(t('annTextTooLong'));
      return result;
    }
    return input.annotations.map(item => {
      if (!item || !['text', 'rectangle', 'circle'].includes(item.type)) throw new Error(t('annInvalidType'));
      const doc = state.documents.find(d => d.id === item.documentId);
      if (!doc || item.group !== doc.group) throw new Error(t('annDocMissing'));
      if (!['pending', 'resolved'].includes(item.status)) throw new Error(t('annInvalidState'));
      if (!Array.isArray(item.replies) || item.replies.length > 1000) throw new Error(t('annInvalidReplies'));
      return { id: uniqueId(item.id), documentId: doc.id, group: doc.group, type: item.type,
        geometry: geometry(item.geometry, item.type), text: content(item.text), creator: author(item.creator),
        createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt), status: item.status,
        replies: item.replies.map(reply => {
          if (!reply) throw new Error(t('annInvalidReply'));
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
    feedback(t('annImported', { n: items.length }));
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
  const addButton = iconButton('annAdd', t('annAdd'), () => {
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
  const toolTextKeys = { text: 'annToolText', rectangle: 'annToolRectangle', circle: 'annToolCircle' };
  const typeTextKeys = { text: 'annTypeText', rectangle: 'annTypeRectangle', circle: 'annTypeCircle' };
  for (const type of ['text', 'rectangle', 'circle']) {
    toolButtons[type] = button(t(toolTextKeys[type]), () => { closeMenu(); showPanel(); setTool(type); }, addPopup);
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
  const visibilityButton = iconButton('eye', t('annVisibility'), () => setAnnotationsVisible(!state.visible), toolbar);
  visibilityButton.className = 'ev-btn ev-btn-icon ann-visibility ev-on';
  visibilityButton.title = t('annHideAll');
  visibilityButton.setAttribute('aria-pressed', 'true');
  toolbar.append(element('span', 'ev-sep'));
  const undoButton = iconButton('undo', t('annUndo'), () => history('undo'), toolbar);
  const redoButton = iconButton('redo', t('annRedo'), () => history('redo'), toolbar);
  undoButton.title = t('annUndoShortcut');
  redoButton.title = t('annRedoShortcut');

  const tabs = element('div', 'ann-tabs');
  const notesTab = button(t('annTabNotes'), () => showPanel(), tabs);
  const propsTab = button(t('annTabProps'), () => {
    shell.rightEl.classList.remove('ann-open');
    setTool('select');
    notesTab.classList.remove('ev-on');
    propsTab.classList.add('ev-on');
  }, tabs);
  tabs.prepend(propsTab);
  for (const [btn, name] of [[propsTab, 'layers'], [notesTab, 'list']]) {
    btn.insertAdjacentHTML('afterbegin', icon(name, 15));
    btn.querySelector('svg').setAttribute('aria-hidden', 'true');
  }
  shell.rightEl.prepend(tabs);
  const panel = element('section', 'ann-panel');
  panel.setAttribute('aria-label', t('annPanelLabel'));
  shell.rightEl.append(panel);
  const head = element('div', 'ann-head');
  const groupTabs = element('div', 'ann-group-tabs');
  const groupButtons = {};
  const groupTextKeys = { schematic: 'annGroupSchematic', pcb: 'annGroupPcb' };
  for (const group of ['schematic', 'pcb']) {
    groupButtons[group] = button(t(groupTextKeys[group]), () => { state.group = group; renderList(); }, groupTabs);
  }
  const contextLabel = element('div', 'ann-meta');
  const filter = element('select');
  filter.setAttribute('aria-label', t('annFilterLabel'));
  const filterTextKeys = { all: 'annFilterAll', pending: 'annFilterPending', resolved: 'annFilterResolved' };
  for (const value of ['all', 'pending', 'resolved']) {
    const option = element('option', '', t(filterTextKeys[value])); option.value = value; filter.append(option);
  }
  filter.addEventListener('change', () => { state.filter = filter.value; renderList(); });
  const authorLabel = element('label', 'ann-author');
  const authorText = element('span', '', t('annAuthor'));
  const authorInput = element('input');
  authorInput.value = state.user.name;
  authorInput.maxLength = 200;
  authorInput.setAttribute('aria-label', t('annAuthor'));
  authorInput.addEventListener('change', () => {
    safely(() => { state.user = author({ ...state.user, name: authorInput.value }); });
    authorInput.value = state.user.name;
  });
  authorLabel.append(authorText, authorInput);
  const headRow = element('div', 'ann-head-row');
  headRow.append(contextLabel, filter);
  head.append(groupTabs, headRow, authorLabel);
  const list = element('div', 'ann-list');
  const editor = element('form', 'ann-editor');
  editor.hidden = true;
  const editorTitle = element('div', 'ann-editor-title');
  const editorText = element('textarea');
  editorText.maxLength = 10000;
  editorText.placeholder = t('annEditorPlaceholder');
  editorText.setAttribute('aria-label', t('annEditorAria'));
  const editorActions = element('div', 'ann-actions ann-editor-actions');
  const cancelButton = button(t('annCancel'), () => { cancelEditor(); draw(); }, editorActions);
  const saveButton = button(t('annSave'), () => saveEditor(), editorActions);
  saveButton.classList.add('ev-btn-primary');
  editor.append(editorTitle, editorText, editorActions);
  editor.addEventListener('submit', event => { event.preventDefault(); safely(saveEditor); });
  panel.append(head, list, editor);
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('ann-layer');
  svg.setAttribute('aria-label', t('annLayerLabel'));
  shell.canvasHost.append(svg);

  function feedback(message, error = false) {
    if (error) shell.setStatus(message, true);
  }
  function showPanel() {
    if (!enabled) return;
    shell.rightEl.classList.add('ann-open');
    notesTab.classList.add('ev-on');
    propsTab.classList.remove('ev-on');
    shell.rightForced = true;
    shell.applyChrome();
  }
  function setTool(type) {
    if (type !== 'select') requireNoDraft();
    if (type !== 'select' && !currentDocument()) throw new Error(t('annNeedDoc'));
    if (type !== 'select' && !state.visible) throw new Error(t('annNeedVisible'));
    cancelGesture();
    state.tool = type;
    if (type !== 'select' && shell.measure.active) shell.measure.setActive(false);
    svg.classList.toggle('ann-drawing', type !== 'select');
    for (const [key, btn] of Object.entries(toolButtons)) btn.classList.toggle('ev-on', key === type);
    feedback(type === 'select' ? t('annSelectHint') : type === 'text' ? t('annTextHint') : t('annShapeHint'));
  }
  function setAnnotationsVisible(value) {
    if (typeof value !== 'boolean') throw new TypeError(t('annVisibleMustBool'));
    if (!value) requireNoDraft();
    state.visible = value;
    visibilityButton.classList.toggle('ev-on', state.visible);
    visibilityButton.classList.toggle('ev-off', !state.visible);
    visibilityButton.innerHTML = icon(state.visible ? 'eye' : 'eyeOff', 16);
    visibilityButton.title = state.visible ? t('annHideAll') : t('annShowAll');
    visibilityButton.setAttribute('aria-pressed', String(state.visible));
    closeMenu();
    if (!state.visible) { cancelGesture(); cancelEditor(); setTool('select'); }
    render();
    feedback(state.visible ? t('annShown') : t('annHidden'));
    return state.visible;
  }
  function editorTitleFor(mode) {
    return t(mode === 'create' ? 'annNewAnnotation' : mode === 'reply' ? 'annReplyAnnotation' : 'annEditAnnotation');
  }
  function beginEditor(value, initial = '') {
    requireNoDraft();
    setTool('select');
    if (value.mode === 'edit') {
      value.geometry = clone(getAnnotation(value.id).geometry);
      state.selected = value.id;
    }
    state.editor = value;
    showPanel();
    editorTitle.textContent = editorTitleFor(value.mode);
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
    if (state.gesture) throw new Error(t('annFinishDrag'));
    const content = text(editorText.value.trim(), t('annFieldContent'));
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
    feedback(t('annSaved'));
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
  function initialOf(name) { return (Array.from(String(name || '').trim())[0] || '?').toUpperCase(); }
  function renderList() {
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    const doc = currentDocument();
    contextLabel.textContent = doc ? t('annCurrentDoc', { title: doc.title }) : t('annNoDoc');
    filter.value = state.filter;
    for (const [key, btn] of Object.entries(groupButtons)) {
      const count = state.annotations.filter(a => a.group === key).length;
      btn.textContent = `${t(groupTextKeys[key])} (${count})`;
      btn.classList.toggle('ev-on', state.group === key);
    }
    const items = state.annotations.filter(a => a.group === state.group && (state.filter === 'all' || a.status === state.filter));
    if (!items.length) {
      const empty = element('div', 'ann-empty');
      const emptyIcon = element('div', 'ann-empty-ico');
      emptyIcon.innerHTML = icon('annAdd', 22);
      emptyIcon.querySelector('svg').setAttribute('aria-hidden', 'true');
      empty.append(emptyIcon, element('div', 'ann-empty-title', t('annNoNotes')),
        element('div', 'ann-empty-hint', t('annEmptyHint')));
      list.append(empty);
    }
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
      const typeButton = button(t(typeTextKeys[item.type]), () => focusAnnotation(item.id), heading);
      typeButton.classList.add('ann-type');
      typeButton.insertAdjacentHTML('afterbegin', icon(menuIcons[item.type], 13));
      typeButton.querySelector('svg').setAttribute('aria-hidden', 'true');
      const statePill = element('span', `ann-state ${item.status === 'resolved' ? 'ann-state-resolved' : 'ann-state-pending'}`,
        t(item.status === 'resolved' ? 'annStatusResolved' : 'annStatusPending'));
      heading.append(statePill);
      const meta = element('div', 'ann-card-meta');
      if (docTitle) {
        const docLine = element('div', 'ann-card-doc', docTitle);
        docLine.title = docTitle;
        meta.append(docLine);
      }
      meta.append(element('div', 'ann-card-by', `${item.creator.name} · ${dateLabel(item.createdAt)}`));
      card.append(heading, meta, element('div', 'ann-content', item.text));
      if (item.replies.length) {
        const replies = element('div', 'ann-replies');
        for (const reply of item.replies) {
          const row = element('div', 'ann-reply');
          const avatar = element('span', 'ann-avatar', initialOf(reply.creator.name));
          const body = element('div', 'ann-reply-body');
          body.append(element('div', 'ann-meta', `${reply.creator.name} · ${dateLabel(reply.createdAt)}`),
            element('div', 'ann-content', reply.text));
          row.append(avatar, body);
          replies.append(row);
        }
        card.append(replies);
      }
      const actions = element('div', 'ann-actions');
      const replyButton = button(t('annReplyCount', { n: item.replies.length }), () => beginEditor({ mode: 'reply', id: item.id }), actions);
      replyButton.classList.add('ann-action-reply');
      const editButton = button(t('annEdit'), async () => {
        requireNoDraft();
        if (currentDocument()?.id !== item.documentId) await focusAnnotation(item.id);
        beginEditor({ mode: 'edit', id: item.id }, item.text);
      }, actions);
      editButton.classList.add('ann-action');
      const resolveButton = button(t(item.status === 'resolved' ? 'annReopen' : 'annResolve'), () => updateAnnotation(item.id, { status: item.status === 'resolved' ? 'pending' : 'resolved' }), actions);
      resolveButton.classList.add('ann-action');
      const deleteButton = button(t('annDelete'), () => { if (confirm(t('annDeleteConfirm'))) deleteAnnotation(item.id); }, actions);
      deleteButton.classList.add('ann-action', 'ann-danger');
      card.append(actions);
      list.append(card);
    }
    list.scrollTop = scrollTop;
  }
  // re-label every static control after the viewer language switches
  function refreshAnnotationTexts() {
    setButtonText(propsTab, t('annTabProps'));
    setButtonText(notesTab, t('annTabNotes'));
    addButton.title = t('annAdd');
    addButton.setAttribute('aria-label', t('annAdd'));
    visibilityButton.title = state.visible ? t('annHideAll') : t('annShowAll');
    visibilityButton.setAttribute('aria-label', t('annVisibility'));
    undoButton.title = t('annUndoShortcut');
    undoButton.setAttribute('aria-label', t('annUndo'));
    redoButton.title = t('annRedoShortcut');
    redoButton.setAttribute('aria-label', t('annRedo'));
    for (const type of ['text', 'rectangle', 'circle']) setButtonText(toolButtons[type], t(toolTextKeys[type]));
    for (const value of ['all', 'pending', 'resolved']) {
      const option = filter.querySelector(`option[value="${value}"]`);
      if (option) option.textContent = t(filterTextKeys[value]);
    }
    filter.setAttribute('aria-label', t('annFilterLabel'));
    authorText.textContent = t('annAuthor');
    authorInput.setAttribute('aria-label', t('annAuthor'));
    editorText.placeholder = t('annEditorPlaceholder');
    editorText.setAttribute('aria-label', t('annEditorAria'));
    setButtonText(cancelButton, t('annCancel'));
    setButtonText(saveButton, t('annSave'));
    panel.setAttribute('aria-label', t('annPanelLabel'));
    svg.setAttribute('aria-label', t('annLayerLabel'));
    if (state.editor) editorTitle.textContent = editorTitleFor(state.editor.mode);
    renderList();
    draw();
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
    if (state.editor?.mode === 'create') items.push({ ...state.editor.draft, id: '', text: t('annDraftLabel'), status: 'pending' });
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
      const label = characters.slice(0, 24).join('') + (characters.length > 24 ? '…' : '') || t('annFallbackLabel');
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
    if (!enabled) return;
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
    if (state.editor) { feedback(t('annNoDraft'), true); return; }
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
        beginEditor({ mode: 'create', draft: { type: gesture.type, geometry: g, documentId: currentDocument().id } });
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
    if (active && state.editor) { feedback(t('annNoDraft'), true); return; }
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
  shell.rightVisible = () => enabled && shell.rightForced === null && currentDocument() ? true : originalRightVisible();
  // `chrome.annotations=false` (preview mode) hides the toolbar group, the
  // right-panel tab and the SVG overlay, and stops forcing the right panel open
  let appliedEnabled = null;
  function syncAnnotationChrome() {
    const changed = appliedEnabled !== enabled;
    appliedEnabled = enabled;
    toolbar.classList.toggle('ev-hidden', !enabled);
    tabs.classList.toggle('ev-hidden', !enabled);
    panel.classList.toggle('ev-hidden', !enabled);
    svg.classList.toggle('ev-hidden', !enabled);
    if (!enabled) {
      shell.rightEl.classList.remove('ann-open');
      notesTab.classList.remove('ev-on');
      closeMenu();
      if (state.editor || state.gesture) { cancelGesture(); cancelEditor(); }
      if (state.tool !== 'select') setTool('select');
    } else if (!shell.rightEl.classList.contains('ann-open')) {
      notesTab.classList.remove('ev-on');
      propsTab.classList.add('ev-on');
    }
    if (changed) render();
  }
  const originalApplyChrome = shell.applyChrome.bind(shell);
  shell.applyChrome = () => {
    enabled = shell.getChrome().annotations !== false;
    originalApplyChrome();
    syncAnnotationChrome();
  };
  const originalSetLang = shell.setLang.bind(shell);
  shell.setLang = lang => {
    originalSetLang(lang);
    // only follow the language for the untouched default author name
    if (state.user.id === 'local' && LOCAL_USER_NAMES.has(state.user.name)) {
      state.user = { ...state.user, name: t('annLocalUser') };
      authorInput.value = state.user.name;
    }
    refreshAnnotationTexts();
  };
  const originalOpenNode = shell.openNode.bind(shell);
  shell.openNode = async node => {
    if (opening) throw new Error(t('annOpening'));
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
    if (state.editor) { feedback(t('annNoDraft'), true); return; }
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
    if (notifying) throw new Error(t('annNoLoadInCallback'));
    if (busy || opening) throw new Error(t('annBusy'));
    requireNoDraft();
    const context = {
      projectId: options.projectId === undefined ? '' : text(options.projectId, t('annFieldProjectId'), 500),
      revision: options.revision === undefined ? '' : text(options.revision, t('annFieldRevision'), 200, true)
    };
    if (options.user) author(options.user);
    const entries = Array.from(files || []);
    if (!entries.length) throw new Error(t('annProvideFiles'));
    busy = true;
    requestedContext = context;
    const previous = shell.model;
    let loadError = null;
    const onLoadError = event => { loadError = event.detail?.message || t('annLoadFailed'); };
    loadEvents.addEventListener('error', onLoadError);
    try {
      await shell.loadFiles(entries);
      if (loadError || shell.model === previous) throw new Error(loadError || t('annLoadFailedCheck'));
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
      if (opening) { shell.fail(new Error(t('annOpening'))); return; }
      try { requireNoDraft(); }
      catch (error) { shell.fail(error); return; }
      clearSegCache();
      return original(...args);
    };
  }
  const api = Object.freeze({
    version: '1.2.0', loadProject,
    setAnnotationsVisible,
    getAnnotationsVisible: () => state.visible,
    getContext: () => clone({ projectId: state.projectId, revision: state.revision, documents: state.documents, currentDocument: currentDocument() }),
    setUser: value => { state.user = author(value); authorInput.value = state.user.name; return clone(state.user); },
    exportAnnotations: () => snapshot(), importAnnotations,
    createAnnotation, updateAnnotation, deleteAnnotation, addReply, focusAnnotation,
    selectByDesignators: designators => shell.selectByDesignators(designators),
    clearSelection: () => shell.clearSelection(),
    undo: () => history('undo'), redo: () => history('redo'),
    onChange: callback => {
      if (typeof callback !== 'function') throw new TypeError(t('annCallbackMustBeFunction'));
      state.listeners.add(callback);
      return () => state.listeners.delete(callback);
    },
    open: async nodeId => {
      requireReady();
      const node = shell.model.openables.get(nodeId);
      if (!node) throw new Error(t('annOpenMissing'));
      await shell.openNode(node);
      return api.getContext();
    },
    fit: () => shell.fitCurrent(),
    setLang: lang => shell.setLang(lang),
    setTheme: theme => shell.setTheme(theme),
    setChrome: flags => shell.setChrome(flags)
  });
  if (enabled) {
    shell.rightEl.classList.add('ann-open');
    notesTab.classList.add('ev-on');
  }
  setTool('select');
  syncAnnotationChrome();
  return { api, destroy() {
    lifetime.abort();
    resizeObserver.disconnect();
    shell.leafer.off('render.end', onRender);
    state.listeners.clear();
    toolbar.remove(); tabs.remove(); panel.remove(); svg.remove();
  } };
}

// MCP OAuth console - client logic.
// The page never receives token material: only scope, expiry and fingerprints.

const REFRESH_WINDOW_MS = 30 * 60 * 1000;

const els = {
  total: document.getElementById('kpi-total'),
  authorized: document.getElementById('kpi-authorized'),
  refreshable: document.getElementById('kpi-refreshable'),
  expiring: document.getElementById('kpi-expiring'),
  servers: document.getElementById('servers'),
  hint: document.getElementById('panel-hint'),
  modalRoot: document.getElementById('modal-root'),
  toastRoot: document.getElementById('toast-root'),
  configPath: document.getElementById('config-path-hint'),
  autoRefresh: document.getElementById('toggle-auto-refresh'),
  allowPrivate: document.getElementById('toggle-private-network'),
  themeToggle: document.getElementById('theme-toggle'),
  refreshAll: document.getElementById('refresh-all'),
  addServer: document.getElementById('add-server'),
};

const view = {
  data: null,
  loading: true,
  error: null,
  busy: new Set(),
  rows: new Map(),
  checkedAt: new Map(),
  modal: null,
  modalRendered: null,
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Error text is owned by the server (see miniapp/node/errors.mjs). The page
 * renders the message it receives and only falls back to a generic line when
 * the response carries none, so a code is never described in two places.
 */
async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.ok) {
    const fallback = `操作失败（${payload?.error ?? `http_${response.status}`}）`;
    throw new Error(payload?.message || fallback);
  }
  return payload;
}

function formatRemaining(ms) {
  if (!Number.isFinite(ms)) return '有效期未知';
  if (ms <= 0) return '已过期';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 1) return `剩余 ${hours} 小时 ${minutes % 60} 分`;
  return `剩余 ${minutes} 分钟`;
}

function formatTime(epochMs) {
  if (!Number.isFinite(epochMs)) return '—';
  const date = new Date(epochMs);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toast(message, tone = 'ok') {
  const node = document.createElement('div');
  node.className = `toast toast--${tone}`;
  node.textContent = message;
  els.toastRoot.append(node);
  while (els.toastRoot.children.length > 4) els.toastRoot.firstElementChild.remove();
  setTimeout(() => node.remove(), 4200);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(text, tone) {
  const node = element('span', `badge${tone ? ` badge--${tone}` : ''}`);
  node.append(element('span', 'badge__dot'), document.createTextNode(text));
  return node;
}

/**
 * Marks a row busy. This must NOT re-render the list: rebuilding would
 * replace the button the user just pressed and swallow the click.
 */
function setBusy(name, value) {
  if (value) view.busy.add(name);
  else view.busy.delete(name);
  applyBusyState();
}

function applyBusyState() {
  for (const [name, row] of view.rows) {
    const busy = view.busy.has(name);
    for (const button of [row.btnApply, row.btnRefresh, row.btnAuthorize, row.btnDetect]) {
      button.disabled = busy;
    }
  }
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  renderKpis();
  renderServers();
  renderModal();
}

function renderKpis() {
  if (!view.data) return;
  const summary = view.data.summary;
  els.total.textContent = String(summary.total);
  els.authorized.textContent = String(summary.authorized);
  els.refreshable.textContent = String(summary.refreshable);
  els.expiring.textContent = String(summary.expiringSoon);
  els.expiring.className = summary.expiringSoon > 0 ? 'kpi__value kpi__value--warn' : 'kpi__value';

  const settings = view.data.settings ?? {};
  if (els.autoRefresh) els.autoRefresh.checked = settings.autoRefresh === true;
  if (els.allowPrivate) els.allowPrivate.checked = settings.allowPrivateNetwork === true;
  if (els.configPath) {
    els.configPath.textContent = view.data.configPath ? `将写入的文件：${view.data.configPath}` : '未能定位 MCP 配置文件';
  }
}

function renderServers() {
  els.servers.setAttribute('aria-busy', view.loading ? 'true' : 'false');

  if (view.loading) {
    const node = element('div', 'state');
    node.append(element('span', 'spinner'), document.createTextNode(' 正在读取本地 MCP 配置…'));
    els.servers.replaceChildren(node);
    view.rows.clear();
    els.hint.textContent = '读取中';
    return;
  }

  if (view.error) {
    const node = element('div', 'state state--error');
    node.append(element('p', 'state__title', '无法读取 MCP 配置'), element('p', null, view.error));
    els.servers.replaceChildren(node);
    view.rows.clear();
    els.hint.textContent = '读取失败';
    return;
  }

  const servers = view.data?.servers ?? [];
  if (!servers.length) {
    const node = element('div', 'state');
    node.append(
      element('p', 'state__title', '还没有 MCP 服务器'),
      element('p', null, '点击右上角「添加服务器」，填入受 OAuth 保护的 MCP 地址即可开始授权。'),
    );
    els.servers.replaceChildren(node);
    view.rows.clear();
    els.hint.textContent = '空列表';
    return;
  }

  // Rows are updated in place. Tearing the list down and rebuilding it would
  // replace the very button the user is clicking, and the click would be lost
  // before it ever reached the server.
  // The container only ever holds row articles: any leftover state block (and
  // its infinite spinner) must go, or it shifts every row and keeps the page
  // permanently animating.
  for (const child of [...els.servers.children]) {
    if (child.tagName !== 'ARTICLE') child.remove();
  }
  const seen = new Set();
  for (const server of servers) {
    seen.add(server.name);
    let row = view.rows.get(server.name);
    if (!row) {
      row = createServerRow(server);
      view.rows.set(server.name, row);
      els.servers.append(row.node);
    }
    updateServerRow(row, server);
  }
  for (const [name, row] of view.rows) {
    if (!seen.has(name)) {
      row.node.remove();
      view.rows.delete(name);
    }
  }
  applyBusyState();
  els.hint.textContent = `${servers.length} 个服务器 · 每 60 秒检查一次到期情况`;
}

function currentServer(name) {
  return view.data?.servers?.find((item) => item.name === name) ?? null;
}

function metaItems(server) {
  const items = [];
  if (server.scope) {
    const scope = element('span');
    scope.append(document.createTextNode('scope '));
    scope.append(element('code', null, server.scope));
    items.push(scope);
  }
  if (server.tokenFingerprint) {
    const fingerprint = element('span');
    fingerprint.append(document.createTextNode('指纹 '));
    fingerprint.append(element('code', null, server.tokenFingerprint));
    items.push(fingerprint);
  }
  if (Number.isFinite(server.expiresAt)) {
    items.push(element('span', null, `到期 ${formatTime(server.expiresAt)} · ${formatRemaining(server.remainingMs)}`));
  }
  if (server.authorizationServer) {
    items.push(element('span', null, `授权服务器 ${server.authorizationServer}`));
  }
  if (server.dynamicRegistration) {
    items.push(element('span', null, '支持动态注册'));
  }
  if (server.oauthReason === 'probe_failed') {
    items.push(element('span', null, '探测失败，请重试'));
  }
  if (server.oauthReason === 'probe_indeterminate') {
    items.push(element('span', null, '端点响应无法判断是否需要 OAuth'));
  }
  if (server.authRequirement === 'bearer') {
    items.push(element('span', null, '该地址要求 Bearer 凭证，但未提供 resource_metadata，无法自动发现授权服务器'));
  }
  if (server.authRequirement === 'credential') {
    items.push(element('span', null, '该地址要求凭证但未声明认证方式（不是 OAuth），需手动配置 Authorization 头'));
  }
  if (server.oauthProtected && !server.authorizationServer) {
    items.push(
      element(
        'span',
        null,
        server.oauthReason === 'no_resource_metadata'
          ? '响应里没有 resource_metadata，无法自动发现授权服务器'
          : '未能自动发现授权服务器',
      ),
    );
  }
  const checkedAt = view.checkedAt.get(server.name);
  if (checkedAt) {
    items.push(element('span', null, `检测于 ${new Date(checkedAt).toLocaleTimeString()}`));
  }
  for (const warning of server.warnings ?? []) {
    items.push(element('span', 'server__warn', warning));
  }
  if (!server.url) {
    items.push(element('span', 'server__note', '本地进程 · 无 URL'));
  }
  if (server.type) {
    items.push(element('span', null, server.type));
  }
  return items;
}

function createServerRow(server) {
  const node = element('article', 'server');

  const main = element('div');
  const title = element('div', 'server__name');
  const badgeSlot = element('span', 'badge-slot');
  const credBadgeSlot = element('span', 'badge-slot');
  title.append(document.createTextNode(server.name), badgeSlot, credBadgeSlot);
  main.append(title);

  const urlNode = element('div', 'server__url');
  main.append(urlNode);

  const metaNode = element('div', 'server__meta');
  main.append(metaNode);

  const actions = element('div', 'server__actions');
  const name = server.name;

  const btnApply = actionButton('确认写入', 'btn btn--primary', () => openConfirmModal(name));
  const btnRefresh = actionButton('刷新令牌', 'btn btn--secondary', async () => {
    setBusy(name, true);
    try {
      const result = await api('/api/refresh', { method: 'POST', body: { serverName: name } });
      toast(`${name} 已刷新${result.probe ? `，握手状态 ${result.probe.status}` : ''}`);
      await loadState();
    } catch (error) {
      toast(`${name} 刷新失败：${error.message}`, 'error');
    } finally {
      setBusy(name, false);
    }
  });
  const btnAuthorize = actionButton('授权登录', 'btn btn--secondary', () => {
    const target = currentServer(name);
    if (target) openAuthorizeModal(target);
  });
  const btnDetect = actionButton('检测', 'btn btn--link', async () => {
    setBusy(name, true);
    try {
      await api('/api/discover', { method: 'POST', body: { serverName: name } });
      // The detection result belongs to this row, so it is rendered in the
      // row itself. A floating toast would overlap the action column and make
      // the next click land on a different row's button.
      view.checkedAt.set(name, Date.now());
      await loadState();
    } catch (error) {
      toast(`${name} 检测失败：${error.message}`, 'error');
    } finally {
      setBusy(name, false);
    }
  });

  actions.append(btnApply, btnRefresh, btnAuthorize, btnDetect);
  btnApply.dataset.action = 'apply';
  btnRefresh.dataset.action = 'refresh';
  btnAuthorize.dataset.action = 'authorize';
  btnDetect.dataset.action = 'detect';
  node.append(main, actions);

  return { node, badgeSlot, credBadgeSlot, urlNode, metaNode, btnApply, btnRefresh, btnAuthorize, btnDetect };
}

function updateServerRow(row, server) {
  row.badgeSlot.replaceChildren(renderRequirementBadge(server));
  row.credBadgeSlot.replaceChildren(renderCredentialBadge(server));
  row.urlNode.textContent = server.url || '（本地 stdio 进程，无 URL）';
  row.metaNode.replaceChildren(...metaItems(server));
  row.btnAuthorize.textContent = server.hasAuthorization ? '重新授权' : '授权登录';
  // A browser OAuth flow only makes sense when the server declared an
  // authorization server. Otherwise the credential has to be set by hand.
  const oauthFlowAvailable = server.authRequirement === 'oauth' || server.authRequirement === 'unknown';
  row.btnAuthorize.hidden = !server.url || !oauthFlowAvailable;
  row.btnDetect.hidden = !server.url;
  row.btnRefresh.hidden = !server.refreshable;
  row.btnApply.hidden = !server.pendingGrant;
}

/**
 * Two orthogonal facts, shown as two separate badges:
 *   - what the SERVER requires (from the OAuth probe) - a property of the
 *     server, unchanged by what this machine happens to hold;
 *   - what THIS MACHINE holds (from mcp.json + the credential file).
 * Collapsing them into one badge made a server look "fine" just because a
 * token existed, and made "requires OAuth" read as "you have no credential".
 */
/**
 * What the server demands, as declared by the server itself:
 *   oauth      - 401 + a Bearer challenge carrying resource_metadata
 *   bearer     - 401 + a Bearer challenge, but no discoverable auth server
 *   credential - 401 with no usable challenge: some credential, unknown scheme
 *   none       - an unauthenticated handshake was accepted
 * A plain 401 is NOT treated as OAuth: the server never said so.
 */
function renderRequirementBadge(server) {
  switch (server.authRequirement) {
    case 'oauth':
      return badge('需要 OAuth', 'warn');
    case 'bearer':
      return badge('需要 Bearer 凭证', 'warn');
    case 'credential':
      return badge('需要凭证·方式未声明', 'warn');
    case 'none':
      return badge('未要求 OAuth', null);
    default:
      if (server.oauthReason === 'probe_failed') return badge('探测失败', 'danger');
      if (server.oauthReason === 'probe_indeterminate') return badge('探测不确定', 'warn');
      return badge('未探测', null);
  }
}

function renderCredentialBadge(server) {
  switch (server.credentialState) {
    case 'pending':
      return badge('待确认写入', 'info');
    case 'valid':
      return badge('令牌有效', 'ok');
    case 'expiring':
      return badge('即将过期', 'warn');
    case 'expired':
      return badge('已过期', 'danger');
    case 'configured_unknown':
      return badge('已配置·无到期信息', null);
    case 'other_scheme':
      return badge('其他认证方式', null);
    default:
      return badge('未配置令牌', null);
  }
}

function actionButton(label, className, onClick) {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

/* ------------------------------------------------------------------ */
/* modal                                                               */
/* ------------------------------------------------------------------ */

function openModal(state) {
  view.modal = state;
  renderModal(true);
  const focusable = els.modalRoot.querySelector('input, textarea, button');
  focusable?.focus();
}

function closeModal() {
  view.modal = null;
  renderModal(true);
}

/**
 * Builds the modal only when it actually changed. A background state refresh
 * must not replace the buttons of a dialog the user is about to press.
 */
function renderModal(force = false) {
  const modal = view.modal;
  if (!modal) {
    if (view.modalRendered) {
      els.modalRoot.innerHTML = '';
      view.modalRendered = null;
    }
    return;
  }
  if (!force && view.modalRendered === modal) return;
  view.modalRendered = modal;

  els.modalRoot.innerHTML = '';

  const backdrop = element('div', 'modal-backdrop');
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closeModal();
  });

  const dialog = element('div', 'modal');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', modal.title);

  const head = element('div', 'modal__head');
  head.append(element('h2', null, modal.title));
  const close = actionButton('关闭', 'btn btn--icon', closeModal);
  close.setAttribute('aria-label', '关闭对话框');
  head.append(close);

  const body = element('div', 'modal__body');
  modal.build(body);

  const foot = element('div', 'modal__foot');
  for (const action of modal.footer ?? []) {
    foot.append(actionButton(action.label, action.className ?? 'btn btn--secondary', action.onClick));
  }

  dialog.append(head, body, foot);
  backdrop.append(dialog);
  els.modalRoot.append(backdrop);

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeModal();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('input, textarea, button, a[href]')].filter(
      (node) => !node.disabled && node.offsetParent !== null,
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function field(labelText, input, hint) {
  const wrap = element('div', 'field');
  const label = element('label', null, labelText);
  const id = `field-${Math.random().toString(36).slice(2, 9)}`;
  label.setAttribute('for', id);
  input.id = id;
  wrap.append(label, input);
  if (hint) wrap.append(element('p', 'field__hint', hint));
  return wrap;
}

/* ---- authorize modal ---- */

function openAuthorizeModal(server) {
  const draft = {
    serverName: server?.name ?? '',
    url: server?.url ?? '',
    scope: '',
    method: 'device',
    session: null,
    device: null,
    deviceStatus: 'idle',
    lastStatus: '',
    error: null,
    working: false,
    pollTimer: null,
  };
  openModal({
    title: server?.hasAuthorization ? `重新授权 · ${server.name}` : '授权登录',
    build: (body) => renderAuthorizeBody(body, draft),
    footer: [
      {
        label: '取消',
        className: 'btn btn--secondary',
        onClick: () => {
          stopPolling(draft);
          closeModal();
        },
      },
      {
        label: '开始授权',
        className: 'btn btn--primary',
        onClick: () => (draft.method === 'device' ? startDeviceFlow(draft) : startAuthorization(draft)),
      },
    ],
  });
}

function renderAuthorizeBody(body, draft) {
  const switcher = element('div', 'segmented');
  for (const [value, label, hint] of [
    ['device', '设备码（推荐）', '无需回调，最省事'],
    ['pkce', '授权码 + PKCE', '需手动回填一次'],
  ]) {
    const button = element('button', `segmented__item${draft.method === value ? ' is-active' : ''}`, label);
    button.type = 'button';
    button.setAttribute('aria-pressed', draft.method === value ? 'true' : 'false');
    button.title = hint;
    button.addEventListener('click', () => {
      if (draft.method === value) return;
      draft.method = value;
      draft.error = null;
      renderModal(true);
    });
    switcher.append(button);
  }
  body.append(switcher);

  if (draft.method === 'device') {
    renderDeviceBody(body, draft);
  } else {
    renderPkceBody(body, draft);
  }

  if (draft.error) {
    body.append(element('div', 'notice notice--danger', draft.error));
  }
}

function renderDeviceBody(body, draft) {
  if (!draft.device) {
    const steps = element('ol', 'steps');
    for (const text of ['读取授权服务器元数据', '申请设备码', '在授权页输入设备码', '换取令牌', '确认写入 mcp.json']) {
      steps.append(element('li', null, text));
    }
    body.append(steps);
    body.append(
      element(
        'div',
        'notice',
        '设备码流程不需要浏览器回调，因此不会被宿主对回环端口的鉴权拦住。页面会给你一串设备码，在授权页输入即可。',
      ),
    );
    body.append(serverFields(draft));
    return;
  }

  const code = element('div', 'device-code');
  code.append(element('span', 'device-code__label', '设备码'), element('strong', 'device-code__value', draft.device.userCode));
  body.append(code);

  const link = draft.device.verificationUriComplete || draft.device.verificationUri;
  const notice = element('div', 'notice');
  notice.append(element('p', null, '在授权页输入上面的设备码，页面会自动继续：'));
  const anchor = element('a', 'btn btn--link', link);
  anchor.href = link;
  anchor.target = '_blank';
  anchor.rel = 'noreferrer';
  notice.append(anchor);
  body.append(notice);

  const actions = element('div', 'server__actions');
  actions.append(
    actionButton('打开授权页', 'btn btn--secondary', () => {
      window.open(link, '_blank', 'noopener');
    }),
    actionButton('复制设备码', 'btn btn--secondary', async () => {
      await copyText(draft.device.userCode);
      toast('设备码已复制');
    }),
  );
  body.append(actions);

  const statusText =
    draft.deviceStatus === 'pending'
      ? '等待你在授权页确认…'
      : draft.deviceStatus === 'granted'
        ? '已获得令牌，正在确认写入…'
        : draft.deviceStatus === 'expired'
          ? '设备码已过期，请重新申请'
          : draft.deviceStatus === 'failed'
            ? '授权失败，请重新申请'
            : '准备中…';
  body.append(element('p', 'field__hint', `状态：${statusText}`));
}

function serverFields(draft) {
  const wrap = element('div', 'field-stack');

  const nameInput = element('input');
  nameInput.type = 'text';
  nameInput.value = draft.serverName;
  nameInput.placeholder = 'hf-endpoints';
  nameInput.addEventListener('input', () => {
    draft.serverName = nameInput.value;
  });
  wrap.append(field('服务器名称（写入 mcp.json 的键名）', nameInput, '名称已存在时覆盖该条目的 Authorization 头，否则新建条目。'));

  const urlInput = element('input');
  urlInput.type = 'url';
  urlInput.value = draft.url;
  urlInput.placeholder = 'https://endpoints.huggingface.co/mcp';
  urlInput.addEventListener('input', () => {
    draft.url = urlInput.value;
  });
  wrap.append(field('MCP 地址', urlInput, '受 OAuth 保护的 MCP 服务端点。'));

  const scopeInput = element('input');
  scopeInput.type = 'text';
  scopeInput.value = draft.scope;
  scopeInput.placeholder = 'read-endpoints write-endpoints';
  scopeInput.addEventListener('input', () => {
    draft.scope = scopeInput.value;
  });
  wrap.append(field('scope（可选，留空则用授权服务器默认值）', scopeInput));
  return wrap;
}

function renderPkceBody(body, draft) {
  const steps = element('ol', 'steps');
  const items = ['读取授权服务器元数据', '动态注册客户端', '在浏览器中完成授权', '回填回调地址', '确认写入 mcp.json'];
  const reached = draft.session ? 3 : 0;
  items.forEach((text, index) => {
    const li = element('li', null, text);
    if (index < reached) li.dataset.state = 'done';
    else if (index === reached) li.dataset.state = 'active';
    steps.append(li);
  });
  body.append(steps);

  if (!draft.session) {
    body.append(
      element(
        'div',
        'notice',
        '浏览器会跳回本机端口，但宿主对回环端口有鉴权，那个页面会显示 401。地址栏里仍然带着授权码，把它复制回来即可。',
      ),
    );
    body.append(serverFields(draft));
    return;
  }

  const notice = element('div', 'notice');
  notice.append(
    element(
      'p',
      null,
      draft.session.browserOpened
        ? '浏览器已打开授权页。如果未能自动跳转，请复制下面的链接在新标签打开：'
        : '没能自动打开浏览器，请复制下面的链接到浏览器打开：',
    ),
  );
  const link = element('a', 'btn btn--link', draft.session.authorizationUrl);
  link.href = draft.session.authorizationUrl;
  link.target = '_blank';
  link.rel = 'noreferrer';
  notice.append(link);
  body.append(notice);

  const copyRow = element('div', 'server__actions');
  copyRow.append(
    actionButton('复制授权链接', 'btn btn--secondary', async () => {
      await copyText(draft.session.authorizationUrl);
      toast(`${draft.serverName} 授权链接已复制`);
    }),
  );
  body.append(copyRow);

  const callbackInput = element('textarea');
  callbackInput.placeholder = 'http://127.0.0.1:PORT/oauth/callback?code=...&state=...';
  body.append(
    field(
      '回填：粘贴浏览器地址栏里的完整 URL',
      callbackInput,
      '授权完成后浏览器地址栏会是一段带 code 的地址，整段复制过来即可，无需回填页真的打开。',
    ),
  );

  const manualRow = element('div', 'server__actions');
  manualRow.append(
    actionButton('用回填完成', 'btn btn--primary', async () => {
      const value = callbackInput.value.trim();
      if (!value) {
        toast('请先粘贴回调地址', 'error');
        return;
      }
      draft.working = true;
      try {
        await api('/api/authorize/complete', {
          method: 'POST',
          body: { sessionId: draft.session.sessionId, redirectUrl: value },
        });
        toast(`${draft.serverName} 已获取令牌，请在列表中确认写入`);
        closeModal();
        await loadState();
      } catch (error) {
        toast(`${draft.serverName} 完成授权失败：${error.message}`, 'error');
      } finally {
        draft.working = false;
      }
    }),
  );
  body.append(manualRow);
}

function startDeviceFlow(draft) {
  if (!draft.serverName.trim()) {
    toast('请填写服务器名称', 'error');
    return;
  }
  if (!draft.url.trim()) {
    toast('请填写 MCP 地址', 'error');
    return;
  }
  draft.working = true;
  draft.error = null;
  renderModal(true);
  api('/api/device/start', {
    method: 'POST',
    body: {
      serverName: draft.serverName.trim(),
      url: draft.url.trim(),
      scope: draft.scope.trim() || undefined,
    },
  })
    .then((result) => {
      draft.device = result;
      draft.deviceStatus = 'pending';
      draft.lastStatus = 'pending';
      renderModal(true);
      pollDeviceStatus(draft);
    })
    .catch((error) => {
      draft.error = `发起设备码失败：${error.message}`;
      renderModal(true);
    })
    .finally(() => {
      draft.working = false;
    });
}

function pollDeviceStatus(draft) {
  stopPolling(draft);
  draft.pollTimer = setInterval(async () => {
    let result = null;
    try {
      result = await api(`/api/device/status?serverName=${encodeURIComponent(draft.serverName.trim())}`);
    } catch {
      return; // transient: keep polling
    }
    if (result.status !== draft.lastStatus) {
      draft.lastStatus = result.status;
      draft.deviceStatus = result.status;
      renderModal(true);
    }
    if (result.status === 'granted') {
      stopPolling(draft);
      toast(`${draft.serverName} 已获取令牌，请在列表中确认写入`);
      closeModal();
      void loadState();
      return;
    }
    if (result.status === 'failed' || result.status === 'expired') {
      stopPolling(draft);
      draft.error = `设备码授权${result.status === 'expired' ? '已过期' : '失败'}${result.error ? `（${result.error}）` : ''}`;
      renderModal(true);
    }
  }, 3000);
}

function stopPolling(draft) {
  if (draft.pollTimer) {
    clearInterval(draft.pollTimer);
    draft.pollTimer = null;
  }
}

async function startAuthorization(draft) {
  if (!draft.serverName.trim()) {
    toast('请填写服务器名称', 'error');
    return;
  }
  if (!draft.url.trim()) {
    toast('请填写 MCP 地址', 'error');
    return;
  }
  draft.working = true;
  draft.error = null;
  try {
    const result = await api('/api/authorize', {
      method: 'POST',
      body: {
        serverName: draft.serverName.trim(),
        url: draft.url.trim(),
        scope: draft.scope.trim() || undefined,
      },
    });
    draft.session = result;
    renderModal(true);
  } catch (error) {
    draft.error = `${draft.serverName} 发起授权失败：${error.message}`;
    renderModal(true);
  } finally {
    draft.working = false;
  }
}

/* ---- confirm modal ---- */

function openConfirmModal(serverName) {
  const server = view.data?.servers?.find((item) => item.name === serverName);
  openModal({
    title: '确认写入本地配置',
    build: (body) => {
      const list = element('dl', 'kv');
      const add = (term, value) => {
        list.append(element('dt', null, term), element('dd', null, value));
      };
      add('目标服务器', server?.name ?? serverName);
      add('MCP 地址', server?.url ?? '—');
      add('写入文件', view.data?.configPath ?? '—');
      add('写入字段', `mcpServers.${serverName}.headers.Authorization`);
      add('新令牌指纹', server?.pendingFingerprint ?? '—');
      add('当前指纹', server?.tokenFingerprint ?? '（尚未配置）');
      add('scope', server?.scope ?? '—');
      body.append(list);
      body.append(
        element(
          'div',
          'notice notice--warn',
          '这会修改上面列出的文件里该服务器的 Authorization 头，并在 dataDir 下写入凭据文件。写入前会先备份（备份失败则不写）。',
        ),
      );
    },
    footer: [
      { label: '取消', className: 'btn btn--secondary', onClick: closeModal },
      {
        label: '确认写入',
        className: 'btn btn--danger',
        onClick: async () => {
          try {
            const result = await api('/api/apply', {
              method: 'POST',
              body: {
                serverName,
                confirmToken: server?.pendingConfirmToken ?? null,
                expectedPath: view.data?.configPath ?? null,
              },
            });
            toast(
              `已写入 ${serverName}${result.probe ? ` · 握手状态 ${result.probe.status}` : ''}${result.created ? ' · 新建条目' : ''}`,
            );
            closeModal();
            await loadState();
          } catch (error) {
            toast(`${serverName} 写入失败：${error.message}`, 'error');
          }
        },
      },
    ],
  });
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = element('textarea');
    area.value = value;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

/* ------------------------------------------------------------------ */
/* data flow                                                           */
/* ------------------------------------------------------------------ */

async function loadState() {
  try {
    const payload = await api('/api/state');
    view.data = payload.state;
    view.error = null;
  } catch (error) {
    view.error = error.message;
  } finally {
    view.loading = false;
    render();
  }
}

function subscribe() {
  try {
    const source = new EventSource('/api/events');
    source.addEventListener('state', () => {
      void loadState();
    });
    source.onerror = () => {
      // the browser retries the stream on its own
    };
  } catch {
    // event streams are optional; the page still polls on interaction
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    if (theme) localStorage.setItem('mcp-oauth-console.theme', theme);
    else localStorage.removeItem('mcp-oauth-console.theme');
  } catch {
    // storage is optional
  }
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem('mcp-oauth-console.theme');
  } catch {
    stored = null;
  }
  applyTheme(stored);
}

els.themeToggle.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = current ?? (prefersDark ? 'dark' : 'light');
  applyTheme(effective === 'dark' ? 'light' : 'dark');
});

els.refreshAll.addEventListener('click', async () => {
  els.refreshAll.disabled = true;
  try {
    const result = await api('/api/refresh-all', { method: 'POST' });
    const ok = (result.results ?? []).filter((item) => item.ok).length;
    const failed = (result.results ?? []).length - ok;
    toast(failed ? `${ok} 个已刷新，${failed} 个失败` : `${ok} 个令牌已刷新`, failed ? 'error' : 'ok');
    await loadState();
  } catch (error) {
    toast(`刷新失败：${error.message}`, 'error');
  } finally {
    els.refreshAll.disabled = false;
  }
});

els.addServer.addEventListener('click', () => openAuthorizeModal(null));

async function saveSettings(patch) {
  try {
    await api('/api/settings', { method: 'POST', body: patch });
    await loadState();
  } catch (error) {
    toast(`保存设置失败：${error.message}`, 'error');
  }
}

els.autoRefresh?.addEventListener('change', (event) => {
  void saveSettings({ autoRefresh: event.target.checked });
});

els.allowPrivate?.addEventListener('change', (event) => {
  void saveSettings({ allowPrivateNetwork: event.target.checked });
});

initTheme();
render();
void loadState();
subscribe();

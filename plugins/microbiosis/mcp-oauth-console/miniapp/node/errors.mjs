// @ts-check

/**
 * Single source of truth for the domain error contract.
 *
 * Every failure the service can report is listed here with the HTTP status the
 * transport should use and the Chinese text the page shows. The transport
 * forwards `message` to the Client verbatim, so an error code is described in
 * exactly one place instead of once per layer.
 *
 * `serviceError()` fails fast on an unregistered code, so a typo surfaces at
 * the throw site instead of silently degrading into an opaque "internal error".
 */

const ERROR_CATALOG = {
  // request routing
  invalid_json: { status: 400, message: '请求格式不正确' },
  internal_error: { status: 500, message: '服务端内部错误' },
  not_found: { status: 404, message: '接口不存在' },

  // target selection
  server_not_found: { status: 404, message: 'mcp.json 里没有这个服务器条目' },
  server_without_url: { status: 400, message: '该服务器是本地 stdio 进程，没有可检测的 URL' },
  target_url_required: { status: 400, message: '请先填写 MCP 地址' },
  target_url_invalid: { status: 400, message: 'MCP 地址格式不正确（必须是 https，或本机回环地址的 http）' },
  target_url_contains_credentials: { status: 400, message: 'MCP 地址里不能带用户名或密码' },
  target_url_blocked: { status: 400, message: '该地址属于实例元数据或链路本地网段，已拒绝访问' },
  redirect_invalid: { status: 400, message: '服务端返回的重定向地址无法解析，已停止请求' },
  redirect_not_allowed: { status: 502, message: '该接口返回了重定向，出于安全考虑已停止请求' },
  too_many_redirects: { status: 502, message: '重定向次数过多，已停止请求' },
  config_not_parseable: { status: 500, message: 'mcp.json 的内容无法解析，已放弃写入' },
  invalid_server_name: { status: 400, message: '服务器名称含有非法字符（只允许字母、数字、点、下划线和连字符）' },
  config_path_changed: { status: 409, message: 'MCP 配置文件的位置已经变了，请刷新页面重新确认' },
  confirm_required: { status: 403, message: '写入需要页面上的确认令牌，请重新在页面上确认' },
  auto_refresh_disabled: { status: 409, message: '后台自动续期未开启，请先在页面上开启' },
  target_url_missing: { status: 400, message: '找不到该服务器的 URL' },

  // authorization flow
  session_not_found: { status: 404, message: '授权会话已失效，请重新发起授权' },
  state_mismatch: { status: 400, message: 'state 校验没通过，请重新发起授权' },
  authorization_code_missing: { status: 400, message: '回调里没有拿到 authorization code' },
  authorization_server_not_resolved: { status: 502, message: '定位不到该 MCP 地址对应的授权服务器' },
  authorization_endpoint_missing: { status: 502, message: '授权服务器元数据里缺少 authorization_endpoint' },
  dynamic_registration_unsupported: { status: 501, message: '该授权服务器不支持动态注册，需要手动提供 client_id' },
  device_flow_unsupported: { status: 501, message: '该授权服务器不支持设备码流程（device authorization）' },
  no_resource_metadata: { status: 502, message: '该地址需要 OAuth，但响应里没有 resource_metadata，无法自动发现授权服务器' },
  bearer_without_resource_metadata: { status: 502, message: '该地址要求 Bearer 凭证，但没有提供 resource_metadata，无法自动发现授权服务器' },
  credential_required_unknown_scheme: { status: 502, message: '该地址要求凭证，但没有声明认证方式（不是 OAuth），请手动配置 Authorization 头' },
  no_pending_grant: { status: 409, message: '没有待写入的令牌，请先完成授权' },

  // token lifecycle
  refresh_token_unavailable: { status: 409, message: '没有可用的 refresh_token，需要重新授权' },
  token_endpoint_unresolved: { status: 502, message: '拿不到令牌端点地址' },

  // configuration patch
  server_entry_not_locatable: { status: 409, message: '在 mcp.json 里定位不到该服务器条目' },
  patched_config_invalid: { status: 500, message: '改写后的配置不是合法 JSON，已放弃写入' },
  patch_verification_failed: { status: 500, message: '改写后的配置校验不通过，已放弃写入' },

  // transport
  request_failed: { status: 502, message: '请求授权服务器失败' },
  probe_failed: { status: 502, message: '探测该地址失败' },
  probe_indeterminate: { status: 502, message: '端点的响应无法判断是否需要 OAuth' },
};

/** Codes whose tail is provider-controlled, so they cannot be enumerated. */
const DYNAMIC_PREFIXES = [
  { prefix: 'token_request_failed_', status: 502, label: '授权服务器拒绝了令牌请求' },
  { prefix: 'device_authorization_failed_', status: 502, label: '设备码申请失败' },
  { prefix: 'dynamic_registration_failed_', status: 502, label: '动态注册失败' },
  { prefix: 'authorization_denied_', status: 400, label: '授权被拒绝' },
  { prefix: 'http_', status: 502, label: '请求失败' },
];

export function isKnownServiceError(code) {
  if (Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code)) return true;
  return DYNAMIC_PREFIXES.some((rule) => code.startsWith(rule.prefix));
}

/** Resolves a code into the status and the user-facing text. */
export function describeServiceError(code) {
  const known = Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code) ? ERROR_CATALOG[code] : null;
  if (known) return { code, status: known.status, message: known.message };
  for (const rule of DYNAMIC_PREFIXES) {
    if (code.startsWith(rule.prefix)) {
      return { code, status: rule.status, message: `${rule.label}（${code.slice(rule.prefix.length)}）` };
    }
  }
  return { code, status: 500, message: `操作失败（${code}）` };
}

/** Builds a domain error. An unregistered code is a programming error. */
export function serviceError(code) {
  if (!isKnownServiceError(code)) {
    throw new Error(`unregistered_error_code:${code}`);
  }
  const error = new Error(code);
  error.name = 'ServiceError';
  error.serviceCode = code;
  return error;
}

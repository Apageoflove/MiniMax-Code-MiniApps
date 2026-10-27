# MCP OAuth Console

[简体中文](README.zh-CN.md) | English

Sign in to MCP servers that require OAuth: runs the device-code flow (or authorization-code + PKCE), keeps the token out of the page, writes the `Authorization` header into the MiniMax Code MCP configuration, and can refresh it before it expires.

Author: [Microbiosis](https://github.com/Microbiosis) · Version: `1.0.0`

## Install & use

Copy this directory into the active MiniMax Code data directory under `plugins/`. `<dataDir>` defaults to `~/.minimax`, so the default install path is:

```text
<dataDir>/plugins/mcp-oauth-console/
```

Keep the hidden `.minimax-plugin/` directory. Restart MiniMax Code, confirm the plugin is recognized, then open "MCP OAuth 令牌台" from the plugin list or by asking the assistant.

The page lists every MCP server in the MiniMax Code configuration and shows **two independent facts** per server: what the *server* demands (probed from the endpoint) and what *this machine* holds (the credential in the local configuration). A server can require OAuth and still be satisfied by a local token; a server can need no OAuth and still have no token. Keeping them apart stops either one from hiding the other.

| Action | What it does |
|---|---|
| Detect | Re-probes the endpoint with a handshake that matches the declared transport, and shows the result in that server's own row |
| Authorize | Runs an OAuth sign-in for that server, then a confirmation dialog showing exactly which file and field will change |
| Confirm write | Patches `mcpServers.<name>.headers.Authorization` in `mcp.json`, backs the file up first, then verifies the token with a real MCP handshake |
| Refresh | Exchanges the stored refresh token for a new access token and writes it back |
| Refresh expiring | Refreshes every stored token that is within 30 minutes of expiry. This is a manual action and always runs, regardless of the automatic-refresh setting |

## Signing in

Two methods are offered, and the page recommends the first one.

**Device code (recommended).** The server asks the authorization server for a short user code, the page shows it next to a link to the provider's verification page, and the server polls the token endpoint until you approve. There is no redirect, so nothing depends on the browser reaching this Mini App.

**Authorization code + PKCE.** The browser opens the consent page and the provider redirects back to this Mini App's loopback port. **From MiniMax Code 3.1.2 the Host authenticates every request to that port**, so the callback page answers `401` and your handler never runs. The address bar still carries the authorization code, so copy that whole URL back into the page and the flow completes — the callback page itself is never needed.

Either way the `state` value must match exactly, and a successful sign-in does not write anything yet: the page shows a confirmation first, and only the confirmation writes the file.

## Settings

The settings panel holds two switches and the path of the file that a write would touch.

| Setting | Default | Effect |
|---|---|---|
| Refresh automatically before expiry | off | While the Mini App is running, tokens inside the 30-minute window are refreshed in the background. Off by default, so the plugin never talks to an authorization server on its own. |
| Allow private addresses | off | Permits loopback, RFC 1918, carrier-grade NAT, link-local and unique-local addresses for **the MCP endpoint you configured yourself**. This switch does not apply to URLs that a remote server hands back — those are always checked strictly. |

The configuration path shown in the panel is the exact file a write would touch. It is resolved once, symlinks are resolved, and the write is refused if the path changed in the meantime.

## How detection works

The probe uses the transport the server declares in the configuration:

- `streamable-http`: a real `initialize` JSON-RPC call.
- `sse`: a `GET` that opens the event stream. A `POST` to the `/sse` URL is not a valid call for that transport and answers `405`.

A `401` on its own is **not** treated as OAuth. Only a `WWW-Authenticate: Bearer resource_metadata="…"` challenge is read as a declaration of OAuth, because that is how an MCP server points at its authorization server (RFC 9728). The page therefore distinguishes:

| Result | Meaning |
|---|---|
| Requires OAuth | `401` plus a discoverable authorization server. The browser flow can run. |
| Requires a Bearer credential | `401` plus a Bearer challenge, but no `resource_metadata`. No authorization server can be discovered. |
| Requires a credential, scheme undeclared | `401` with no usable challenge. The endpoint wants *some* credential — an API key, for example — not necessarily OAuth. |
| OAuth not required | An unauthenticated handshake was accepted. |
| Undetermined | The endpoint answered with something else (`404`, `405`, `5xx`) or could not be reached. |

When a server does not declare OAuth the browser flow is not offered: there is no authorization server to run it against, so the header has to be set by hand instead.

## Data & access

### Files read

| File | Why |
|---|---|
| The MiniMax Code MCP server configuration (`mcp.json`) | The list of servers to inspect, and the header to write. |

`mcp.json` is a Host file with no supported API for plugins. The plugin looks for it in exactly two places:

1. the Host's own data-dir chain — it walks up from `context.dataDir` (the plugin's data directory lives inside the MiniMax data directory) and takes the first `mcp.json` it finds;
2. the documented default location, `~/.minimax/mcp.json`.

The process working directory and the Node executable's directory are deliberately **not** searched, so an unrelated `mcp.json` next to them can never win. The walk **stops at the MiniMax data directory** and never reaches the home directory, so a stray `mcp.json` there is not picked up either. The layout is still unspecified: on a Host that keeps the configuration somewhere else, the plugin finds no servers and shows an empty list.

A credential directory left next to `mcp.json` by an earlier version of this plugin is read once and imported into `context.dataDir`. It is never written to again.

### Files written

| File | What |
|---|---|
| `mcp.json` | Only the `Authorization` header of one server entry. The patch is surgical: the rest of the file stays byte-identical. |
| `<dataDir>/mcp-credentials/<server>.json` | The credential: client id, client secret, refresh token, access token, scope, expiry. The file name is the server name, restricted to `A-Z a-z 0-9 . _ -` and at most 64 characters, so a name such as `../../other` cannot leave the directory. |
| `<dataDir>/settings.json` | The two settings above. |
| `<dataDir>/mcp.json.bak` | A copy of `mcp.json`, taken before every write. |
| `<dataDir>/mcp.json.applied.bak` | A copy of `mcp.json`, taken before a **confirmed** write. A background refresh writes to `mcp.json.bak` instead, so it can never replace the snapshot the user was shown. |

Writes to `mcp.json` are atomic: a temporary file in the same directory, then a rename. The original file mode is carried over, because a temp file starts with the default mode. Writes are serialized so two of them cannot interleave. If a write fails the temporary file is removed and the previous content stays intact. **A failed backup aborts the write** — the backup is the only way back, so it is written before the file is touched, and if that fails nothing is changed.

The read, the patch and the write all happen under one lock, and the file is re-read inside the lock, so a concurrent edit cannot lose an entry.

### Network hosts

The plugin talks to exactly two kinds of hosts:

1. The MCP endpoints listed in the MCP configuration — for the detection probe and for the post-write verification handshake.
2. The OAuth endpoints of those servers, taken from their metadata: the authorization endpoint, the token endpoint, the device-authorization endpoint, the client-registration endpoint, the protected-resource document, and the `.well-known` authorization-server metadata.

Nothing else is contacted. There is no telemetry, no analytics, and no third-party service.

Every URL is validated before the process requests it:

- `https` only — plain `http` is accepted for loopback addresses;
- no credentials inside the URL;
- loopback, RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), carrier-grade NAT (`100.64/10`), link-local (`169.254/16`), IPv6 unique-local (`fc00::/7`), IPv6 link-local (`fe80::/10`), IPv6 multicast, the unspecified address, and the instance-metadata hosts are refused;
- IPv4-mapped, IPv4-compatible and NAT64 IPv6 forms are resolved back to their IPv4 address first, so `::ffff:127.0.0.1` and `::ffff:7f00:1` are refused as well.

Redirects are followed by hand, and **every hop is checked again with the same rule** — a `302` must not be a way around the guard. At most five hops are followed.

A redirect also must not hand the credential to a host that did not receive it:

- a redirect to another origin is followed **without** the `Authorization` header and without cookies, the way `fetch` itself drops them;
- a `301`, `302` or `303` turns the `POST` into a `GET` without a body, the way a browser does;
- a request whose body holds a secret — a token request, a client registration, a device code — is **never redirected**. Those endpoints are not expected to redirect, so the request is refused instead.

Two tiers exist. A URL that a **remote server** handed back — a metadata document, a token endpoint, a device endpoint — is always checked strictly and can never reach a private address. A URL the **user** configured as their own MCP endpoint may point at a private address, but only when the "Allow private addresses" switch is on.

### Spawned processes

| Command | When |
|---|---|
| `explorer.exe <authorization-url>` (Windows), `open <authorization-url>` (macOS), `xdg-open <authorization-url>` (Linux) | Once per authorization, to open the consent page in the default browser. |

Arguments are passed as an argv array and never through a shell. The URL is the authorization request built from the server's own metadata. If the helper cannot be started the page says so and shows the link to copy instead.

### Where state is stored

All durable state lives under `context.dataDir`, the private directory the Host creates for this plugin. Nothing is written outside it except the MCP configuration listed above.

### Agent turns

None. The package declares no `agentAccess`, so it never asks the Agent to run a turn, read a file, or call a tool. Everything happens inside the Node process or in the provider's own page.

### Conversations read

None. The package declares no `session.read`, so it never sees a conversation, a turn, or a reply.

### Tools called

None. The package declares no `toolAccess`, so it never calls an MCP or Connector tool.

### Microphone

None. The package declares no `deviceAccess`, so it never records the user.

### Credentials

Token material stays in the Node process. The page receives metadata only: scope, expiry, and an eight-character SHA-256 fingerprint used to tell two tokens apart. A fingerprint is not reversible and is not usable as a credential. Credentials are never placed in HTML, client JavaScript, log messages, or error responses.

Internal error codes are never shown to the user. Every code the service can raise is registered in one catalog that carries the user-facing message, and an unregistered code fails fast instead of leaking through.

## Tested environment

| | |
|---|---|
| MiniMax Code | 3.1.6 (Windows) |
| Platform | Windows 11, Node 22 or newer |
| Authorization servers | Hugging Face OAuth (`huggingface.co`), Exa OAuth (`auth.exa.ai`) |
| Verified flows | Dynamic client registration, device authorization (RFC 8628), authorization code + PKCE (S256), authorization code exchange, refresh token exchange, MCP `initialize` handshake after a write |

Verified end to end against the Hugging Face authorization server and the Hugging Face Inference Endpoints MCP server.

## Known limitations

- The plugin can only manage servers that are already in the MCP configuration, or that you add through the page. It does not discover servers on its own.
- A server that needs a credential but does not declare OAuth cannot be signed in to from the page; the header has to be set by hand.
- The PKCE method needs the callback URL copied back by hand, because the Host guards the loopback port. Use the device code method unless the provider offers nothing else.
- The detection probe checks the handshake. A server may accept an unauthenticated `initialize` and still require a token for tool calls.
- Automatic refresh only runs while the Mini App is running, and it is off until you switch it on. A token that expires while the app is stopped is refreshed the next time it starts.

## Development

The package ships its own unit tests. Run them from this directory:

```bash
node --test "tests/**/*.test.mjs"
```

They cover the URL guard, the credential-path confinement, the surgical `mcp.json` patch, and a static check that every error code the service can raise is registered in the catalog.

## License

Apache-2.0. See [LICENSE](LICENSE).

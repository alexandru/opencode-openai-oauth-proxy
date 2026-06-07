# opencode-openai-oauth-proxy

OpenCode plugin that proxies OpenAI OAuth authentication and Codex API calls through a user-specified proxy server. Useful when you are behind a network that blocks direct connections to `auth.openai.com` and `chatgpt.com`.

## Installation

Add the plugin to your `opencode.json`:

```json
{
  "plugin": [
    ["opencode-openai-oauth-proxy", {
      "routeMap": {
        "https://auth.openai.com/": "https://api.intl.nedelcu.net/openai-auth/",
        "https://chatgpt.com/backend-api/": "https://api.intl.nedelcu.net/openai-codex-api/"
      }
    }]
  ]
}
```

Then run `opencode providers login --provider openai` and select one of the proxied auth methods.

## Configuration

The plugin accepts a single option — `routeMap` — which is a dictionary mapping original URLs to proxy URLs. All requests to URLs starting with a key are rewritten to use the corresponding value prefix, with the remaining path preserved.

### Required routes

| Original URL | Proxy URL | Purpose |
|---|---|---|
| `https://auth.openai.com/` | Your proxy prefix | OAuth authorize, token exchange, token refresh, device flow |
| `https://chatgpt.com/backend-api/` | Your proxy prefix | Codex LLM API calls |

### Proxy server setup

Your proxy server must transparently forward HTTPS requests. For example, if your proxy runs at `api.intl.nedelcu.net` and uses prefix-based routing:

```
/openai-auth/       → https://auth.openai.com/
/openai-codex-api/  → https://chatgpt.com/backend-api/
```

The proxy must preserve all HTTP headers, query parameters, and request bodies.

### Complete opencode.json example

```json
{
  "plugin": [
    ["opencode-openai-oauth-proxy", {
      "routeMap": {
        "https://auth.openai.com/": "https://api.intl.nedelcu.net/openai-auth/",
        "https://chatgpt.com/backend-api/": "https://api.intl.nedelcu.net/openai-codex-api/"
      }
    }]
  ],
  "provider": {
    "kimi-for-coding": {
      "options": {
        "baseURL": "https://api.intl.nedelcu.net/km/v1"
      }
    },
    "opencode-go": {
      "options": {
        "baseURL": "https://api.intl.nedelcu.net/go/v1"
      }
    }
  }
}
```

## Authentication

After adding the plugin, run:

```bash
opencode providers login --provider openai
```

You will see the proxied auth methods:

- **ChatGPT Pro/Plus (browser, proxied)** — Opens a browser window. The authorization page loads through your proxy.
- **ChatGPT Pro/Plus (headless, proxied)** — Device code flow for headless environments. All polling and token exchange goes through your proxy.
- **Manually enter API Key** — Unchanged. No proxy needed for API keys.

## How it works

The plugin overrides the built-in Codex OAuth methods using OpenCode's plugin system (external plugins take precedence over built-in ones for the same provider). All hardcoded `auth.openai.com` and `chatgpt.com` URLs are rewritten to use your proxy server.

The plugin does **not** interfere with:
- Other providers in your config
- The built-in Codex model filtering (`provider.models` hook)
- Chat headers and parameters (`chat.headers`, `chat.params`)

## Disabling the built-in plugin

If you want only the proxy plugin's auth methods and not the built-in ones, set the environment variable:

```bash
OPENCODE_DISABLE_DEFAULT_PLUGINS=true
```

This is optional — even without it, the proxy plugin's auth methods replace the built-in ones because external plugins win when both register for the same provider.

## Building from source

```bash
make build
```

## Publishing

```bash
make publish
```

Requires an npm token with publish access.

## License

MIT

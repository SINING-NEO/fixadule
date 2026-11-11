// Where the API lives. Empty means "same site" (Cloudflare or local dev).
// On GitHub Pages the API is the Cloudflare Worker.
window.FIXADULE_API = location.hostname.endsWith('github.io') ? 'https://fixadule.WORKERS_SUBDOMAIN.workers.dev' : '';

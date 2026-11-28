#!/usr/bin/env node
/**
 * Stdio HTTP CONNECT tunnel for OpenSSH ProxyCommand over Muse `hatch-egress-proxy:3130`.
 * Usage: node tailscale_ssh_proxy.mjs <host> <port>
 */
import net from 'node:net';

const [host, portStr] = process.argv.slice(2);
const port = Number(portStr);
if (!host || !port) {
  process.stderr.write('Usage: tailscale_ssh_proxy.mjs <host> <port>\n');
  process.exit(2);
}

function findProxy() {
  const override = String(process.env.MUSE_TAILSCALE_PROXY || '').trim();
  if (override) return new URL(override);
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const raw = String(process.env[k] || '').trim();
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (u.hostname === 'hatch-egress-proxy') {
        u.port = '3130';
        return u;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

const proxy = findProxy();
if (!proxy) {
  const sock = net.connect(port, host, () => {
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
  });
  sock.on('error', (e) => {
    process.stderr.write(e.message + '\n');
    process.exit(1);
  });
} else {
  const pHost = proxy.hostname;
  const pPort = Number(proxy.port) || 3130;
  const sock = net.connect(pPort, pHost, () => {
    const hdrs = [
      `CONNECT ${host}:${port} HTTP/1.1`,
      `Host: ${host}:${port}`,
    ];
    if (proxy.username || proxy.password) {
      const cred = Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
      ).toString('base64');
      hdrs.push(`Proxy-Authorization: Basic ${cred}`);
    }
    sock.write(hdrs.join('\r\n') + '\r\n\r\n');
  });

  let established = false;
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    if (established) {
      process.stdout.write(chunk);
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const head = buf.slice(0, idx).toString('latin1');
    const rest = buf.slice(idx + 4);
    const statusLine = head.split('\r\n')[0] || '';
    if (!/\s200\s/.test(statusLine)) {
      process.stderr.write(`CONNECT failed: ${statusLine}\n`);
      process.exit(1);
    }
    established = true;
    if (rest.length) process.stdout.write(rest);
    process.stdin.on('data', (d) => sock.write(d));
    process.stdin.on('end', () => sock.end());
  });
  sock.on('end', () => process.exit(0));
  sock.on('error', (e) => {
    process.stderr.write(e.message + '\n');
    process.exit(1);
  });
}

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

function blockedIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function ipv6Value(address) {
  let value = address.toLowerCase().split("%")[0];
  const embeddedIpv4 = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embeddedIpv4) {
    const parts = embeddedIpv4[1].split(".").map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const high = ((parts[0] << 8) | parts[1]).toString(16);
    const low = ((parts[2] << 8) | parts[3]).toString(16);
    value = value.slice(0, -embeddedIpv4[1].length) + `${high}:${low}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 0 || (halves.length === 1 && zeroCount !== 0)) return null;
  const groups = [...left, ...Array(zeroCount).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return groups.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
}

function blockedAddress(address) {
  const family = isIP(address);
  if (family === 4) return blockedIpv4(address);
  if (family !== 6) return true;

  const value = ipv6Value(address);
  if (value == null) return true;
  const prefix = bits => value >> BigInt(128 - bits);

  // IPv4-mapped addresses inherit the IPv4 policy. Other non-global ranges
  // (including IPv4-compatible, ULA, link-local, multicast and NAT64) fail closed.
  const high96 = value >> 32n;
  if (high96 === 0xffffn) {
    const v4 = Number(value & 0xffffffffn);
    return blockedIpv4([v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join("."));
  }
  if (prefix(3) !== 1n) return true; // global unicast only (2000::/3)
  if (prefix(32) === 0x20010db8n || prefix(48) === 0x200100020000n || prefix(16) === 0x2002n) return true;
  if (prefix(20) === 0x3fff0n) return true; // documentation range
  return false;
}

async function publicAddresses(url, allowPrivateOrigins) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!hostname) {
    throw new Error("host local recusado");
  }
  const literalFamily = isIP(hostname);
  const explicitlyLocalName = (!literalFamily && !hostname.includes(".")) || /(?:^|\.)(?:localhost|local|internal|lan|home|test)$/.test(hostname) || hostname.endsWith(".home.arpa");
  const explicitPrivateHost = explicitlyLocalName || (literalFamily && blockedAddress(hostname));
  const allowPrivate = allowPrivateOrigins.has(url.origin) && explicitPrivateHost;
  if (explicitlyLocalName && !allowPrivate) {
    throw new Error("host local recusado");
  }
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || (!allowPrivate && addresses.some(({ address }) => blockedAddress(address)))) {
    throw new Error("host sem endereço público recusado");
  }
  return addresses;
}

function requestOnce(url, addresses, { timeoutMs, maxBytes, headers }) {
  const transport = url.protocol === "https:" ? https : http;
  const suppliedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const pinnedLookup = (_hostname, options, callback) => {
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const req = transport.request(url, {
      method: "GET",
      headers: { "user-agent": "ai-site-cloner/0.3", ...suppliedHeaders, "accept-encoding": "identity" },
      lookup: pinnedLookup
    }, res => {
      const status = Number(res.statusCode || 0);
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        res.destroy();
        settled = true;
        clearTimeout(timer);
        resolve({ redirect: location });
        return;
      }
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
        res.destroy();
        fail(new Error("resposta compactada não suportada; servidor ignorou Accept-Encoding: identity"));
        return;
      }

      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error(`resposta excede o limite de ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const body = Buffer.concat(chunks, size);
        const responseHeaders = res.headers;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: {
            get: name => {
              const value = responseHeaders[String(name).toLowerCase()];
              return value == null ? null : Array.isArray(value) ? value.join(", ") : String(value);
            },
          },
          body,
          text: async () => body.toString("utf8"),
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
        });
      });
      res.on("error", fail);
    });
    req.on("error", fail);
    timer = setTimeout(() => req.destroy(new Error(`timeout após ${timeoutMs} ms`)), timeoutMs);
    req.end();
  });
}

export async function fetchPublic(input, {
  timeoutMs = 15000,
  maxBytes = 5 * 1024 * 1024,
  headers = {},
  allowPrivateOrigins = [],
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs inválido");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("maxBytes inválido");
  const allowedOrigins = new Set(allowPrivateOrigins.map(value => new URL(value).origin));
  let url = new URL(input);
  const initialOrigin = url.origin;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      throw new Error("somente URLs HTTP/HTTPS públicas são aceitas");
    }
    const addresses = await publicAddresses(url, allowedOrigins);
    const requestHeaders = url.origin === initialOrigin
      ? headers
      : Object.fromEntries(Object.entries(headers).filter(([name]) => !/^(authorization|cookie|proxy-authorization)$/i.test(name)));
    const result = await requestOnce(url, addresses, { timeoutMs, maxBytes, headers: requestHeaders });
    if (!result.redirect) return result;
    if (redirects === 5) throw new Error("limite de redirecionamentos excedido");
    url = new URL(result.redirect, url);
  }
  throw new Error("limite de redirecionamentos excedido");
}

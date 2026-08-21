// Shared HTTP network guards for the dsh-files upload surface. Mirrors the
// official dsh-files-button contract: loopback or configured trusted host,
// same-origin and same-site checks. The upload endpoint runs these before
// touching any session or path.
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
    try {
        return new URL(`http://${authority}`);
    }
    catch {
        return undefined;
    }
}
/**
 * Whether the request Host matches one configured trusted authority.
 * A port-less entry matches any port on that host; an entry with an explicit
 * port matches that exact host:port. Mirrors the official
 * isTrustedAuthority semantics (dsh-client-connection).
 */
export function isTrustedHost(host, trustedHosts) {
    const hostUrl = parseAuthority(host);
    if (hostUrl === undefined)
        return false;
    return trustedHosts.some((entry) => {
        const entryUrl = parseAuthority(entry);
        if (entryUrl === undefined)
            return false;
        // The port is judged from URL parses under both special schemes (their
        // default ports differ, so `:80`/`:443` still count as explicit), never
        // from the raw string, where WHATWG trimming would misread shapes like
        // `host:port ` as port-less.
        const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port;
        return port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
    });
}
/**
 * Assert one configured trustedHosts entry is a bare authority (`host` or
 * `host:port`) in canonical form: it must survive WHATWG parsing unchanged
 * (case aside). Anything parsing would silently rewrite is refused as a typo
 * that must fail the load loudly instead of being ignored until requests 403
 * or quietly changing the grant. Mirrors the official assertTrustedAuthority.
 */
export function assertTrustedAuthority(entry) {
    let url;
    try {
        url = new URL(`http://${entry}`);
    }
    catch {
        throw new Error(`dsh-files: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`);
    }
    // The port is judged from URL parses under both special schemes (their
    // default ports differ, so `:80`/`:443` still count as explicit), never
    // from the raw string, where WHATWG trimming would misread shapes like
    // `host:port ` as port-less.
    const port = url.port !== '' ? url.port : new URL(`https://${entry}`).port;
    const canonical = port === '' ? url.hostname : `${url.hostname}:${port}`;
    if (canonical !== entry.toLowerCase()) {
        throw new Error(`dsh-files: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`);
    }
}
/**
 * Reject requests that are not loopback/trusted, same-origin and same-site.
 * Returns a human-readable reason, or null when the request passes.
 *
 * `trustedHosts` are the deployment's non-loopback authorities (e.g. the
 * value of `dsh web --trusted-host`): reverse-tunnel and LAN deployments
 * serve the GUI under a public or LAN host, and the browser's Host header
 * carries that authority on every request.
 */
export function networkGuard(req, trustedHosts = []) {
    const host = String(req.headers?.host ?? '');
    const hostUrl = parseAuthority(host);
    if (hostUrl === undefined || (!LOOPBACK_HOST.test(host) && !isTrustedHost(host, trustedHosts))) {
        return 'forbidden: non-loopback host';
    }
    const origin = req.headers?.origin;
    if (origin !== undefined) {
        // TLS may terminate upstream (reverse proxy / tunnel): the socket the
        // server sees is plain HTTP while the browser's Origin is https. Compare
        // the host part only, mirroring the official isTrustedApiRequest fence.
        let originHost;
        try {
            originHost = new URL(String(origin)).host;
        }
        catch {
            originHost = undefined;
        }
        if (originHost !== hostUrl.host)
            return 'forbidden: cross-origin';
    }
    const secFetchSite = req.headers?.['sec-fetch-site'];
    if (secFetchSite !== undefined && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
        return 'forbidden: cross-site';
    }
    return null;
}
/** Write a JSON error response. */
export function jsonError(res, status, error) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error }));
}

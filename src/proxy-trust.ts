/**
 * How many proxy hops in front of the server express should trust when it derives req.ip.
 *
 * The OAuth endpoints rate-limit per req.ip. On SAP BTP Cloud Foundry a request passes a load
 * balancer and then the CF router, so X-Forwarded-For arrives as "client, load balancer" and the
 * socket is the router: two trusted hops put the client's address in req.ip. With fewer, every
 * client shares the bucket of a load balancer node; with more, a client could pick its own key
 * by sending an X-Forwarded-For of its own. Outside Cloud Foundry nothing is trusted, because
 * there is no proxy that would overwrite such a header. BW_TRUST_PROXY_HOPS overrides both.
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv): number {
  const configured = env.BW_TRUST_PROXY_HOPS;
  if (configured !== undefined && configured.trim() !== '') {
    const hops = Number(configured);
    if (!Number.isInteger(hops) || hops < 0) {
      throw new Error(`BW_TRUST_PROXY_HOPS must be a whole number of hops, not "${configured}".`);
    }
    return hops;
  }
  return env.VCAP_APPLICATION ? 2 : 0;
}

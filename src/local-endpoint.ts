/** Operator-configured origins only. No caller URL, redirect, credentials or path. */
export function validateLocalEndpoint(input:string,hosts:string[]) {
  if(hosts.some(h=>!h||/[\s/@?#*]/.test(h)))throw Error('LOCAL_PROVIDER_HOSTS requires exact hostnames/IPs.');
  const url=new URL(input);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['localhost','127.0.0.1','[::1]',...hosts].includes(url.hostname.toLowerCase()))
    throw Error('Local provider URL must be an allowlisted HTTP(S) origin without credentials, path or query.');
  return url.origin;
}

import { z } from 'zod';

export const infrastructureKinds = ['tailscale_status', 'acme_certificates', 'openresty_status'] as const;
export type InfrastructureKind = typeof infrastructureKinds[number];
const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const Alias = z.string().trim().min(1).max(64).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const Target = z.object({ containerId: z.string().regex(/^[a-f0-9]{64}$/), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
const RelativeCertificate = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_./-]+\.(?:cer|crt|pem)$/).refine((value) => !value.startsWith('/') && !value.split('/').some((part) => part === '..' || part === '.' || !part));
const Probe = z.object({ siteId: z.number().int().min(1).max(1_000_000), alias: Alias, serverName: z.string().max(253).regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/), port: z.number().int().min(1).max(65535) }).strict();
const common = { sourceRef: Id, profileId: Id, displayName: Alias.optional(), target: Target };
export const TailscaleSourceSchema = z.object({ ...common, kind: z.literal('tailscale_status'), peer: z.object({ nodeId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), ip: z.string().refine((value) => { const octets = value.split('.').map(Number); return octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127; }), alias: Alias }).strict() }).strict();
export const AcmeSourceSchema = z.object({ ...common, kind: z.literal('acme_certificates'), manager: Target, certificates: z.array(z.object({ id: Id, alias: Alias, managedRelative: RelativeCertificate, deployedRelative: RelativeCertificate, databaseId: z.number().int().min(1).max(1_000_000) }).strict()).length(1), probe: Probe }).strict();
export const OpenrestySourceSchema = z.object({ ...common, kind: z.literal('openresty_status'), siteIds: z.array(z.number().int().min(1).max(1_000_000)).min(1).max(16).refine((ids) => new Set(ids).size === ids.length), probe: Probe }).strict();
export const InfrastructureSourceSchema = z.discriminatedUnion('kind', [TailscaleSourceSchema, AcmeSourceSchema, OpenrestySourceSchema]);
export type RegisteredInfrastructureSource = z.infer<typeof InfrastructureSourceSchema>;
export type InfrastructureRead = { kind: InfrastructureKind; complete: boolean; data: Record<string, unknown> };
export const INFRASTRUCTURE_LIMITS = { timeoutMs: 5_000, maxBytes: 512 * 1024, maxResponseBytes: 256 * 1024, refreshMs: 60_000 } as const;

/** Constant, main-owned reader. Arguments are validated registered objects, never renderer input. */
export const INFRASTRUCTURE_PYTHON = String.raw`import base64,datetime,json,os,re,selectors,signal,socket,sqlite3,ssl,stat,subprocess,sys,time
s=json.loads(sys.argv[1]);budget=max(0.05,min(4.8,float(sys.argv[2])));deadline=time.monotonic()+budget
MAX_BYTES=512*1024;used=0;DOCKER=sys.argv[3]
def alarm_timeout(signum,frame):raise TimeoutError()
signal.signal(signal.SIGALRM,alarm_timeout)
signal.setitimer(signal.ITIMER_REAL,budget)
def remaining():
 r=deadline-time.monotonic()
 if r<=0:raise TimeoutError()
 return r
def run(args,seconds=1.2,limit=65536):
 global used
 until=time.monotonic()+min(seconds,remaining());p=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 sel=selectors.DefaultSelector();chunks={p.stdout:bytearray(),p.stderr:bytearray()}
 for pipe in chunks:os.set_blocking(pipe.fileno(),False);sel.register(pipe,selectors.EVENT_READ)
 try:
  while sel.get_map():
   wait=min(until-time.monotonic(),remaining())
   if wait<=0:raise TimeoutError()
   for key,_ in sel.select(wait):
    data=os.read(key.fileobj.fileno(),8192)
    if not data:sel.unregister(key.fileobj);continue
    used+=len(data)
    if len(chunks[key.fileobj])+len(data)>limit or used>MAX_BYTES:raise ValueError('output_limit')
    chunks[key.fileobj].extend(data)
  p.wait(timeout=max(.001,min(until-time.monotonic(),remaining())))
  return p.returncode,bytes(chunks[p.stdout]),bytes(chunks[p.stderr])
 finally:
  sel.close()
  if p.poll() is None:p.kill();p.wait()
  p.stdout.close();p.stderr.close()

def target(t):
 code,out,err=run([DOCKER,'inspect','--format','{{json .Id}}\t{{json .Image}}\t{{json .State.Status}}\t{{json .Mounts}}\t{{json .NetworkSettings.Ports}}',t['containerId']])
 if code:raise ValueError('target_unavailable')
 parts=[json.loads(p) for p in out.decode().strip().split('\t')]
 if parts[0]!=t['containerId'] or parts[1]!=t['imageId'] or parts[2]!='running':raise ValueError('identity_mismatch')
 return {'id':parts[0],'mounts':parts[3],'ports':parts[4] or {}}
def mount(t,destination):
 paths=[m['Source'] for m in t['mounts'] if m['Destination']==destination and m.get('Type') in ('bind','volume')]
 if len(paths)!=1:raise ValueError('mount_unavailable')
 return os.path.realpath(paths[0])
def file_read(root,relative,limit=32768):
 global used
 parts=relative.split('/')
 if not parts or any(p in ('','.','..') for p in parts):raise ValueError('path_invalid')
 fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for part in parts[:-1]:
   nextfd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nextfd
  leaf=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
  try:
   before=os.fstat(leaf)
   if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>limit:raise ValueError('file_invalid')
   data=os.read(leaf,limit+1);after=os.fstat(leaf)
   if len(data)>limit or (before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns):raise ValueError('file_changed')
   used+=len(data)
   if used>MAX_BYTES:raise ValueError('output_limit')
   return data
  finally:os.close(leaf)
 finally:os.close(fd)
def certificate(root,relative):
 try:
  data=file_read(root,relative)
  if b'PRIVATE KEY' in data or b'BEGIN CERTIFICATE' not in data:raise ValueError('certificate_invalid')
  return {'pem':base64.b64encode(data).decode()}
 except PermissionError:return {'error':'permission'}
 except FileNotFoundError:return {'error':'missing'}
 except (OSError,ValueError):return {'error':'invalid'}
def database(t):
 root=mount(t,'/opt/om/data');path=root+'/data.db'
 info=os.lstat(path)
 if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise ValueError('database_invalid')
 db=sqlite3.connect('file:'+path+'?mode=ro',uri=True,timeout=min(.1,remaining()));db.execute('PRAGMA query_only=ON');db.set_progress_handler(lambda:1 if time.monotonic()>deadline else 0,1000)
 return db
def served(t,db):
 probe=s['probe'];row=db.execute('SELECT domains FROM sites WHERE id=? AND length(domains)<=4096',(probe['siteId'],)).fetchone()
 if not row or probe['serverName'] not in json.loads(row[0]):raise ValueError('site_identity')
 if str(probe['port']) not in [p.get('HostPort') for p in t['ports'].get('443/tcp',[])]:raise ValueError('port_identity')
 try:
  # Public-certificate inspection only: no HTTP, credentials, or trust-success claim.
  ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT);ctx.check_hostname=False;ctx.verify_mode=ssl.CERT_NONE
  with socket.create_connection(('127.0.0.1',probe['port']),timeout=min(1.0,remaining())) as sock:
   sock.settimeout(min(1.0,remaining()))
   with ctx.wrap_socket(sock,server_hostname=probe['serverName']) as peer:
    return {'der':base64.b64encode(peer.getpeercert(binary_form=True)).decode(),'protocol':peer.version(),'reachable':True,'trustVerified':False}
 except (socket.timeout,TimeoutError):return {'reachable':False,'error':'timeout'}
 except (OSError,ssl.SSLError):return {'reachable':False,'error':'tls_or_connection'}
def renewal(t):
 code,out,err=run([DOCKER,'logs','--timestamps','--tail','80',t['id']],limit=65536)
 if code:return {'outcome':'unknown','error':'source'}
 latest=None;success=None;current=None
 domain=s['certificates'][0]['managedRelative'].split('/')[0].removesuffix('_ecc')
 for line in (out+err).decode('utf-8','replace').splitlines()[-160:]:
  m=re.search(r'msg=("(?:[^"\\]|\\.)*")',line)
  try:msg=json.loads(m.group(1)) if m else line
  except ValueError:continue
  renewal_domain=re.search(r"Renew: (?:'([^']+)'|([^\s]+))",msg)
  if renewal_domain:current=renewal_domain.group(1) or renewal_domain.group(2)
  if current!=domain:continue
  at=line.split(' ',1)[0]
  if not re.match(r'^\d{4}-\d\d-\d\dT',at):continue
  skipped=re.search(r'Skipping\. Next renewal time is: (\d{4}-\d\d-\d\dT[0-9:]+Z)',msg)
  if skipped:latest={'outcome':'not_due','checkedAt':at,'nextEligibleAt':skipped.group(1)}
  # Upgrade successful is deliberately not certificate/renewal success.
  if 'Cert success.' in msg:success={'outcome':'issuance_success','occurredAt':at}
 return {'latest':latest,'issuance':success,'outcome':'no_record' if latest is None and success is None else 'observed'}
def errors(t):
 code,out,err=run([DOCKER,'exec',t['id'],'tail','-c','16384','/opt/om/nginx/logs/error.log'],limit=32768)
 if code:return {'available':False,'samples':[]}
 samples=[]
 for line in out.decode('utf-8','replace').splitlines()[-80:]:
  stamp=re.match(r'^(\d{4}/\d\d/\d\d \d\d:\d\d:\d\d)',line)
  if not stamp:continue
  kind='upstream_timeout' if 'upstream timed out' in line else 'connection_refused' if 'connect() failed (111:' in line else 'tls' if 'SSL_do_handshake() failed' in line else 'file_not_found' if ('No such file or directory' in line or 'is not found' in line) else 'other_request_error'
  samples.append({'at':stamp.group(1),'kind':kind})
 code,zone,err=run([DOCKER,'exec',t['id'],'date','+%z'],limit=1024)
 offset=zone.decode().strip() if code==0 else ''
 return {'available':True,'samples':samples,'window':'last_16KiB_max80_lines','timezoneOffset':offset if re.match(r'^[+-][0-9]{4}$',offset) else None}
try:
 t=target(s['target']);kind=s['kind'];data={};complete=True
 if kind=='tailscale_status':
  code,out,err=run([DOCKER,'exec',t['id'],'timeout','2','tailscale','status','--json'],seconds=2.3,limit=262144)
  if code:raise ValueError('status_unavailable')
  raw=json.loads(out);peer=next((p for p in (raw.get('Peer') or {}).values() if p.get('ID')==s['peer']['nodeId']),None)
  data={'version':raw.get('Version'),'backendState':raw.get('BackendState'),'selfOnline':(raw.get('Self') or {}).get('Online'),'peerOnline':peer.get('Online') if peer else None,'healthCount':len(raw.get('Health') or []),'peerFound':peer is not None,'probe':{'outcome':'not_probed','reason':'budget'}}
  if peer and s['peer']['ip'] in peer.get('TailscaleIPs',[]) and remaining()>2.8:
   code,out,err=run([DOCKER,'exec',t['id'],'timeout','2','tailscale','ping','--tsmp','--c=1','--timeout=1500ms',s['peer']['ip']],seconds=2.2,limit=8192)
   msg=out.decode('utf-8','replace');match=re.search(r'via TSMP in ([0-9.]+)ms',msg)
   data['probe']={'outcome':'success' if code==0 and match else 'failed','latencyMs':float(match.group(1)) if match and code==0 else None,'layer':'TSMP'}
 elif kind=='acme_certificates':
  manager=target(s['manager']);db=database(manager)
  try:
   data['certificates']=[];managed=mount(t,'/acme.sh');deployed=mount(t,'/certs')
   for cert in s['certificates']:
    row=db.execute('SELECT expires,crt FROM certs WHERE id=? AND length(crt)<=32768',(cert['databaseId'],)).fetchone()
    data['certificates'].append({'id':cert['id'],'managed':certificate(managed,cert['managedRelative']),'deployed':certificate(deployed,cert['deployedRelative']),'database':{'pem':base64.b64encode(row[1].encode()).decode(),'reportedExpires':row[0]} if row and 'PRIVATE KEY' not in row[1] else {'error':'missing'}})
   data['served']=served(manager,db)
  finally:db.close()
  data['renewal']=renewal(t)
 elif kind=='openresty_status':
  db=database(t)
  try:
   placeholders=','.join('?' for _ in s['siteIds']);data['siteCount']=db.execute('SELECT count(*) FROM sites WHERE id IN ('+placeholders+')',s['siteIds']).fetchone()[0];data['upstreamCount']=db.execute('SELECT count(*) FROM upstreams').fetchone()[0]
   data['served']=served(t,db)
  finally:db.close()
  data['errors']=errors(t)
 else:raise ValueError('kind_invalid')
 result={'kind':kind,'complete':complete,'data':data}
 encoded=json.dumps(result)
 if len(encoded.encode())>262144:raise ValueError('output_limit')
 print(encoded)
except PermissionError:print(json.dumps({'error':'permission'}))
except (TimeoutError,subprocess.TimeoutExpired):print(json.dumps({'error':'timeout'}))
except (ValueError,KeyError,TypeError,sqlite3.Error,OSError):print(json.dumps({'error':'schema_or_source'}))
`;

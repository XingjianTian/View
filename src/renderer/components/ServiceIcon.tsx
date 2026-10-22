import type { ReactNode } from 'react';
import type { Service } from '../../shared/contracts.js';

type Kind = 'paper' | 'knowledge' | 'chart' | 'tasks' | 'schedule' | 'tunnel' | 'infrastructure' | 'service';
const drawings: Record<Kind, ReactNode> = {
  paper: <><path d="M13 3H5v18h14V9l-6-6Zm0 0v6h6" /><path d="M12 11v6m-3-3 3 3 3-3M8 7h2" /></>,
  knowledge: <><path d="M12 6c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v15" /><path d="M6 9h3m-3 4h3m6-4h3m-3 4h3" /></>,
  chart: <><path d="M3 3v18h18M6 15l4-5 4 3 6-8" /><path d="M16 5h4v4" /></>,
  tasks: <><path d="m3 6 2 2 3-4M11 6h10M3 13l2 2 3-4M11 13h10M11 20h10" /><circle cx="5" cy="20" r="1" /></>,
  schedule: <><circle cx="12" cy="13" r="8" /><path d="M12 9v5l3 2M9 2h6M18 4l2 2" /></>,
  tunnel: <><path d="M4 18V9a8 8 0 0 1 16 0v9M8 18V9a4 4 0 0 1 8 0v9" /><path d="M3 21h18M12 10v2m0 4v2" /></>,
  infrastructure: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.1m0 11h.1M12 6.5h5m-5 11h5M12 10v4" /></>,
  service: <><path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10v9M3 8l9 5 9-5M8 5l9 5" /></>,
};

export function serviceIconKind(service: Pick<Service, 'name' | 'category' | 'statusAdapter'>): Kind {
  const name = service.name.toLowerCase();
  if (/隧道|tunnel|proxy/.test(name)) return 'tunnel';
  if (/量化|quant/.test(name)) return 'chart';
  if (/定时|cron|schedule/.test(name)) return 'schedule';
  if (/后台|任务|worker|queue/.test(name)) return 'tasks';
  const identity = name + ' ' + service.category.toLowerCase();
  if (/知识|rag|knowledge/.test(identity) || service.statusAdapter?.kind === 'ragflow_documents') return 'knowledge';
  if (/论文|paper|article/.test(identity) || service.statusAdapter?.kind === 'article_receipt_json') return 'paper';
  if (/基础设施|infra|database|server/.test(identity)) return 'infrastructure';
  if (service.statusAdapter?.kind === 'quant_pg_receipts') return 'chart';
  if (/后台|任务|worker|queue/.test(identity)) return 'tasks';
  return 'service';
}

export function ServiceIcon({ service }: { service: Pick<Service, 'name' | 'category' | 'statusAdapter'> }) {
  const kind = serviceIconKind(service);
  return <svg className="service-icon" data-service-icon={kind} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{drawings[kind]}</svg>;
}

import type { ReactNode } from 'react';

type IconName = 'arrow-up' | 'check' | 'cross' | 'warning' | 'question' | 'minus';
const shapes: Record<IconName, ReactNode> = {
  'arrow-up': <><path d="M12 20V4m-6 6 6-6 6 6" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  cross: <path d="m6 6 12 12M18 6 6 18" />,
  warning: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3v.1" /></>,
  question: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3v.1" /></>,
  minus: <path d="M5 12h14" />,
};

export function Icon({ name }: { name: IconName }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{shapes[name]}</svg>;
}

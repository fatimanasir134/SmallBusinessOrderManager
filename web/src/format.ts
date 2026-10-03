const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const formatCents = (cents: number | null | undefined) =>
  cents == null ? '—' : money.format(cents / 100);

export const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';

export const formatDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

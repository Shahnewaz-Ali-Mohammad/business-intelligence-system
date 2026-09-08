import type { DashboardData } from '@/lib/dashboard/metrics';

export type DashboardViewStatus = 'Live' | 'Snapshot' | 'Freeze';

export type PinnedView = {
  title: string;
  meta: string;
  status: DashboardViewStatus;
  days: number;
  region: string | null;
};

export type FilterHistoryEntry = {
  label: string;
  timeLabel: string;
  timestamp: number;
  days: number;
  region: string | null;
  data: DashboardData;
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
};

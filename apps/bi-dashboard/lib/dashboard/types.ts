export type Kpi = {
  label: string;
  value: string;
  delta: string;
  trend: 'up' | 'down';
  accent: string;
  sparkline: number[];
  chartPoints: {
    label: string;
    value: string;
    normalized: number;
  }[];
  source: string;
  detail: string;
  context: string;
  footer: string;
  axis: {
    xStart: string;
    xEnd: string;
    yMin: string;
    yMax: string;
  };
};

export type PageLink = {
  title: string;
  meta: string;
  status: 'Live' | 'Snapshot' | 'Freeze';
};

export type CustomerMix = {
  newCustomers: number;
  returningCustomers: number;
  newPct: number;
  returningPct: number;
};

export type TopCustomerByOrders = {
  name: string;
  orders: number;
};

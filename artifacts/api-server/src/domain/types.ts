export interface ValopayRecord {
  id: string;
  merchantId: string;
  kind: string;
  name: string;
  status: string;
  reference: string;
  amountKobo: number;
  customerId: string;
  createdAt: string;
  updatedAt: string;
  data: Record<string, any>;
}

export interface Merchant {
  id: string;
  name: string;
  shortName: string;
  segment: string;
  mode: string;
  status: string;
  provider: string;
  monthlyVolume: number;
  killSwitch: boolean;
  preDataReady: boolean;
  preLiveReady: boolean;
}

export interface DomainState {
  merchant: Merchant;
  records: ValopayRecord[];
  settings: Record<string, any>;
}

export interface Context {
  actor: string;
  role: string;
  now: string;
}

export interface Metric {
  key: string;
  label: string;
  value: number;
  unit: string;
  detail: string;
}

export interface Report {
  metrics: Metric[];
  billing: Record<string, any>;
  experiment: Record<string, any>;
  operational: Record<string, any>;
  closes: ValopayRecord[];
}

export interface ActionInput {
  action: string;
  recordId?: string;
  reason?: string;
  data?: Record<string, any>;
}

export interface ActionResult {
  message: string;
  record?: ValopayRecord;
  data: Record<string, any>;
}
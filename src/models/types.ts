// Core types for the CPQ system

export interface CustomerInfo {
  name: string;
  company: string;
  email?: string;
  phone?: string;
}

export interface PumpRequirements {
  gpm: number;
  headFt: number;
  fluid: string;
  powerAvailable: '230V_1ph' | '460V_3ph';
  environment: 'ATEX' | 'non-ATEX';
  materialPref?: 'CastIron' | 'Stainless';
  maintenanceBias?: 'budget' | 'low maintenance';
  siteConstraints?: string[];
  notes?: string;
}

export interface PumpConfiguration {
  family: string;
  motorHp: number;
  voltage: string;
  sealType: 'Mechanical' | 'Packing';
  material: 'CastIron' | 'Stainless';
  mount: 'Base' | 'CloseCoupled';
  impeller: string;
  atex: boolean;
}

export interface BOMItem {
  sku: string;
  description: string;
  quantity: number;
  unitPrice: number;
  extendedPrice: number;
}

export interface Pricing {
  listTotal: number;
  discountPercent: number;
  netTotal: number;
  bom?: BOMItem[];
}

export interface CPQCanvas {
  customer: CustomerInfo;
  requirements: PumpRequirements;
  configuration: PumpConfiguration;
  rationale: string;
  bom: BOMItem[];
  pricing: Pricing;
  openQuestions: string[];
  nextSteps: string[];
  timestamp: string;
}

export interface ValidationResult {
  isValid: boolean;
  violations: string[];
  suggestion?: string;
}

export interface CatalogSearchResult {
  family?: string[];
  options?: Array<{
    optionType: string;
    optionValue: string;
    constraints?: string;
    priceAdder?: number;
  }>;
}

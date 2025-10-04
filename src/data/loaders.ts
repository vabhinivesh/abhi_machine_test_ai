import fs from 'fs';
import { parse } from 'csv-parse/sync';
import path from 'path';

export interface CatalogEntry {
  family: string;
  minGpm: number;
  maxGpm: number;
  maxHeadFt: number;
  maxHp: number;
  baseNote: string;
}

export interface OptionEntry {
  optionType: string;
  optionValue: string;
  constraints?: string;
  priceAdder?: number;
}

export interface FlowHeadMapEntry {
  gpmRange: string;
  headRange: string;
  family: string;
  motorHp: number;
  impellerCode: string;
}

export interface BOMRules {
  base_components: Array<{
    sku: string;
    desc: string;
    qty: number;
    unit_price: Record<string, Record<string, number>>;
  }>;
  impellers: Record<string, { sku: string; desc: string; price: number }>;
  motors: Record<string, { sku: string; desc: string; price: number }>;
  seal_kits: Record<string, { sku: string; desc: string; price: number }>;
  mounts: Record<string, { sku: string; desc: string; price: number }>;
  coupling: { sku: string; desc: string; price: number };
  atex: { sku: string; desc: string; price: number };
  fasteners: { sku: string; desc: string; price: number };
  finish: { sku: string; desc: string; price: number };
}

export interface PricingRules {
  default_discount_pct: number;
}

const DATA_DIR = path.join(__dirname, '../../data');

export function loadCatalog(): CatalogEntry[] {
  const filePath = path.join(DATA_DIR, 'catalog.csv');
  const content = fs.readFileSync(filePath, 'utf-8');
  
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    cast: (value, context) => {
      if (context.column === 'min_gpm' || 
          context.column === 'max_gpm' || 
          context.column === 'max_head_ft' || 
          context.column === 'max_hp') {
        return parseFloat(value);
      }
      return value;
    }
  });

  return records.map((row: any) => ({
    family: row.family,
    minGpm: parseFloat(row.min_gpm),
    maxGpm: parseFloat(row.max_gpm),
    maxHeadFt: parseFloat(row.max_head_ft),
    maxHp: parseFloat(row.max_hp),
    baseNote: row.base_note
  }));
}

export function loadOptions(): OptionEntry[] {
  const filePath = path.join(DATA_DIR, 'options.csv');
  const content = fs.readFileSync(filePath, 'utf-8');
  
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    cast: (value, context) => {
      if (context.column === 'price_adder') {
        return value ? parseFloat(value) : 0;
      }
      return value;
    }
  });

  return records.map((row: any) => ({
    optionType: row.option_type,
    optionValue: row.option_value,
    constraints: row.constraints || '',
    priceAdder: row.price_adder ? parseFloat(row.price_adder) : 0
  }));
}

export function loadFlowHeadMap(): FlowHeadMapEntry[] {
  const filePath = path.join(DATA_DIR, 'flow_head_map.csv');
  const content = fs.readFileSync(filePath, 'utf-8');
  
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    cast: (value, context) => {
      if (context.column === 'motor_hp') {
        return parseFloat(value);
      }
      return value;
    }
  });

  return records.map((row: any) => ({
    gpmRange: row.gpm_range,
    headRange: row.head_range,
    family: row.family,
    motorHp: parseFloat(row.motor_hp),
    impellerCode: row.impeller_code
  }));
}

export function loadBOMRules(): BOMRules {
  const filePath = path.join(DATA_DIR, 'bom_rules.json');
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

export function loadPricingRules(): PricingRules {
  const filePath = path.join(DATA_DIR, 'pricing_rules.json');
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

// Preload all data for better performance
const catalog = loadCatalog();
const options = loadOptions();
const flowHeadMap = loadFlowHeadMap();
const bomRules = loadBOMRules();
const pricingRules = loadPricingRules();

export const DataStore = {
  catalog,
  options,
  flowHeadMap,
  bomRules,
  pricingRules,
  reload: () => {
    Object.assign(DataStore, {
      catalog: loadCatalog(),
      options: loadOptions(),
      flowHeadMap: loadFlowHeadMap(),
      bomRules: loadBOMRules(),
      pricingRules: loadPricingRules()
    });
  }
};

import { DataStore } from '../data/loaders';
import { 
  CatalogSearchResult, 
  PumpConfiguration, 
  PumpRequirements, 
  ValidationResult,
  BOMItem,
  Pricing
} from '../models/types';

/**
 * Searches the pump catalog based on the provided query
 */
export function searchCatalog(query: string): CatalogSearchResult {
  const result: CatalogSearchResult = {};
  
  // Search in catalog
  if (query.toLowerCase().includes('family')) {
    result.family = DataStore.catalog.map(item => item.family);
  }
  
  // Search in options
  if (query.toLowerCase().includes('option') || query.toLowerCase().includes('motor') || 
      query.toLowerCase().includes('voltage') || query.toLowerCase().includes('seal') ||
      query.toLowerCase().includes('material') || query.toLowerCase().includes('mount') ||
      query.toLowerCase().includes('atex')) {
    
    const searchTerms = query.toLowerCase().split(' ');
    result.options = DataStore.options.filter(option => 
      searchTerms.some(term => 
        option.optionType.toLowerCase().includes(term) || 
        option.optionValue.toLowerCase().includes(term)
      )
    );
  }
  
  return result;
}

/**
 * Validates if the current configuration meets all constraints
 */
export function validateConfiguration(
  config: Partial<PumpConfiguration>,
  requirements: Partial<PumpRequirements>
): ValidationResult {
  const violations: string[] = [];
  
  // Check if required fields are present
  if (!config.family) violations.push("Pump family is required");
  if (!config.motorHp) violations.push("Motor HP is required");
  if (!config.voltage) violations.push("Voltage is required");
  if (!config.sealType) violations.push("Seal type is required");
  if (!config.material) violations.push("Material is required");
  if (!config.mount) violations.push("Mount type is required");
  
  // Check voltage constraints
  if (config.voltage === '230V_1ph' && (config.motorHp || 0) > 3) {
    violations.push("230V 1-phase requires Motor HP <= 3");
  }
  
  if (config.voltage === '460V_3ph' && (config.motorHp || 0) < 5) {
    violations.push("460V 3-phase requires Motor HP >= 5");
  }
  
  // Check mount constraints
  if (config.mount === 'CloseCoupled' && (config.motorHp || 0) > 7.5) {
    violations.push("Close coupled mount requires Motor HP <= 7.5");
  }
  
  // Check ATEX constraints if applicable
  if (requirements.environment === 'ATEX' && config.atex) {
    if (config.material !== 'Stainless' || 
        config.sealType !== 'Mechanical' || 
        config.voltage !== '460V_3ph' || 
        config.mount !== 'Base' || 
        (config.motorHp || 0) < 5) {
      violations.push("ATEX compliance requires: Stainless material, Mechanical seal, 460V 3-phase, Base mount, and Motor HP >= 5");
    }
  }
  
  return {
    isValid: violations.length === 0,
    violations,
    suggestion: violations.length > 0 ? 
      "Please adjust the configuration to meet all constraints." : 
      "Configuration is valid."
  };
}

/**
 * Calculates pricing for the given configuration
 */
export function calculatePricing(
  config: PumpConfiguration,
  discountPercent: number = DataStore.pricingRules.default_discount_pct
): Pricing {
  let listTotal = 0;
  const bom: BOMItem[] = [];
  
  // Add base component (pump casing)
  const baseComponent = DataStore.bomRules.base_components[0];
  const baseSku = baseComponent.sku
    .replace('{family}', config.family)
    .replace('{material}', config.material);
    
  const basePrice = baseComponent.unit_price[config.family][config.material];
  
  bom.push({
    sku: baseSku,
    description: baseComponent.desc
      .replace('{family}', config.family)
      .replace('{material}', config.material),
    quantity: 1,
    unitPrice: basePrice,
    extendedPrice: basePrice
  });
  listTotal += basePrice;
  
  // Add impeller
  const impeller = DataStore.bomRules.impellers[config.impeller];
  if (impeller) {
    bom.push({
      sku: impeller.sku,
      description: impeller.desc,
      quantity: 1,
      unitPrice: impeller.price,
      extendedPrice: impeller.price
    });
    listTotal += impeller.price;
  }
  
  // Add motor
  const motorKey = `${config.motorHp}|${config.voltage}`;
  const motor = DataStore.bomRules.motors[motorKey];
  if (motor) {
    bom.push({
      sku: motor.sku,
      description: motor.desc,
      quantity: 1,
      unitPrice: motor.price,
      extendedPrice: motor.price
    });
    listTotal += motor.price;
  }
  
  // Add seal kit
  const sealKey = `${config.sealType}|${config.material}`;
  const sealKit = DataStore.bomRules.seal_kits[sealKey];
  if (sealKit) {
    bom.push({
      sku: sealKit.sku,
      description: sealKit.desc,
      quantity: 1,
      unitPrice: sealKit.price,
      extendedPrice: sealKit.price
    });
    listTotal += sealKit.price;
  }
  
  // Add mount
  const mount = DataStore.bomRules.mounts[config.mount];
  if (mount) {
    bom.push({
      sku: mount.sku,
      description: mount.desc,
      quantity: 1,
      unitPrice: mount.price,
      extendedPrice: mount.price
    });
    listTotal += mount.price;
  }
  
  // Add coupling
  bom.push({
    sku: DataStore.bomRules.coupling.sku,
    description: DataStore.bomRules.coupling.desc,
    quantity: 1,
    unitPrice: DataStore.bomRules.coupling.price,
    extendedPrice: DataStore.bomRules.coupling.price
  });
  listTotal += DataStore.bomRules.coupling.price;
  
  // Add ATEX package if needed
  if (config.atex) {
    bom.push({
      sku: DataStore.bomRules.atex.sku,
      description: DataStore.bomRules.atex.desc,
      quantity: 1,
      unitPrice: DataStore.bomRules.atex.price,
      extendedPrice: DataStore.bomRules.atex.price
    });
    listTotal += DataStore.bomRules.atex.price;
  }
  
  // Add fasteners and finish
  bom.push({
    sku: DataStore.bomRules.fasteners.sku,
    description: DataStore.bomRules.fasteners.desc,
    quantity: 1,
    unitPrice: DataStore.bomRules.fasteners.price,
    extendedPrice: DataStore.bomRules.fasteners.price
  });
  listTotal += DataStore.bomRules.fasteners.price;
  
  bom.push({
    sku: DataStore.bomRules.finish.sku,
    description: DataStore.bomRules.finish.desc,
    quantity: 1,
    unitPrice: DataStore.bomRules.finish.price,
    extendedPrice: DataStore.bomRules.finish.price
  });
  listTotal += DataStore.bomRules.finish.price;
  
  // Calculate net total with discount
  const netTotal = listTotal * (1 - discountPercent / 100);
  
  return {
    listTotal: parseFloat(listTotal.toFixed(2)),
    discountPercent,
    netTotal: parseFloat(netTotal.toFixed(2)),
    bom
  };
}
